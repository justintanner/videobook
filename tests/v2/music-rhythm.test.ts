import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EditIntent, Engine, Sequence, TimedSequenceClip } from 'videobook-engine'
import { closeEngineForTest, createEngineForTest } from '../../server/src/engine.js'
import { queue, setEngineRoot } from '../../server/src/queue.js'
import { registerAnalyzeMusicJob } from '../../server/src/jobs/analyze-music.js'
import { musicAnalysisDefs } from '../../server/src/tools/music-analysis.js'
import { commandPlanDefs } from '../../server/src/tools/command-plan.js'
import { analyzeMusicSource, cachedMusicAnalysis, musicSource, readMusicAnalysis } from '../../server/src/rhythm/music-analysis.js'
import { readSequenceRhythm, updateSequenceRhythm } from '../../server/src/rhythm/sequence-rhythm.js'
import { clipWaveform, effectiveMarkers, frameAtSourceTime, nearestBeat, sourceTimeAtFrame, timelineMarkers } from '../../server/src/rhythm/timing.js'
import { synthesizeClicks } from '../../server/src/rhythm/synthesize.js'
import type { MusicAnalysisState, RhythmSettings } from '../../server/src/rhythm/model.js'
import type { ToolResult } from '../../server/src/tools/tool-def.js'
import { runRhythmWorker } from '../../server/src/rhythm/run-worker.js'
import { FFMPEG } from '../../server/src/ffmpeg.js'

function decode<T>(result: ToolResult): T {
  if (result.isError) throw new Error(result.content[0]!.text)
  return JSON.parse(result.content[0]!.text) as T
}

function wav(seconds: number, bpm: number) {
  const { samples, sampleRate } = synthesizeClicks({ seconds, bpm, leadSilenceSeconds: 0.5 })
  const buffer = Buffer.alloc(44 + samples.length * 2)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(buffer.length - 8, 4)
  buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(samples.length * 2, 40)
  samples.forEach((sample, index) => buffer.writeInt16LE(Math.round(sample * 32767), 44 + index * 2))
  return { buffer, samples, sampleRate }
}

describe('music analysis and rhythm persistence', () => {
  let root: string
  let engine: Engine
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'videobook-rhythm-'))
    engine = createEngineForTest(root)
    await setEngineRoot(root, engine)
    registerAnalyzeMusicJob(engine)
  })
  afterEach(async () => {
    await queue.stop()
    closeEngineForTest(root, engine)
    await rm(root, { recursive: true, force: true })
  })

  async function audio(seconds = 8, bpm = 120) {
    const data = wav(seconds, bpm)
    const created = await engine.artifacts.create('audio', 'Rhythm fixture')
    if (!created.ok) throw new Error(created.error.message)
    const id = created.value.artifactId
    const written = await engine.files.write(id, 'original.wav', data.buffer)
    if (!written.ok) throw new Error(written.error.message)
    const manifest = await engine.files.manifest(id)
    if (!manifest.ok) throw new Error(manifest.error.message)
    const stream = await engine.streams.register({
      artifactId: id, sourcePath: 'original.wav', objectHash: manifest.value.files[0]!.objectHash,
      streamIndex: 0, kind: 'audio', codec: 'pcm_s16le', durationTicks: data.samples.length,
      timeBase: { numerator: 1, denominator: data.sampleRate },
      audio: { sampleRateHz: data.sampleRate, channels: 1, channelLayout: 'mono' },
    })
    if (!stream.ok) throw new Error(stream.error.message)
    return { id, stream: stream.value }
  }

  async function placeAudio(id: string): Promise<Sequence> {
    const sequence = engine.sequences.getPrimary()
    const track = sequence.tracks.find((item) => item.kind === 'audio')!
    const tools = commandPlanDefs(engine)
    const plan = decode<{ stages: Array<{ intent: EditIntent }> }>(await tools.find((tool) => tool.name === 'plan_sequence_edit')!.handler({
      book_id: engine.book.get().bookId, source_surface: 'ui', actor: 'rhythm-test',
      request: { kind: 'append', artifact_id: id, track_id: track.trackId },
    }))
    const intent = plan.stages[0]!.intent
    const preview = engine.edits.preview(intent)
    if (!preview.ok) throw new Error(preview.error.message)
    const committed = await engine.edits.commit(intent, preview.value.previewHash)
    if (!committed.ok) throw new Error(committed.error.message)
    return committed.value.sequence
  }

  it('runs the real decoder and queued analyzer once, caches by audio content, and fences replaced sources', async () => {
    const { id } = await audio()
    const tool = musicAnalysisDefs(engine).find((item) => item.name === 'analyze_music')!
    const args = { book_id: engine.book.get().bookId, asset_id: id }
    const first = decode<MusicAnalysisState>(await tool.handler(args))
    const second = decode<MusicAnalysisState>(await tool.handler(args))
    expect(second.jobId).toBe(first.jobId)
    await expect.poll(async () => (await readMusicAnalysis(engine, id)).status, { timeout: 15000 }).toBe('ready')
    const ready = await readMusicAnalysis(engine, id)
    expect(ready.analysis?.beats.length).toBeGreaterThan(10)
    expect(ready.analysis?.beats[0]?.timeSeconds).toBeGreaterThan(0.4)
    expect(ready.analysis?.waveform.length).toBe(8192)
    expect(engine.jobs.queue.get(first.jobId!)?.artifactId).toBeNull()
    expect(decode<MusicAnalysisState>(await tool.handler(args)).jobId).toBe(first.jobId)
    const oldSource = await musicSource(engine, id)
    expect(await engine.files.write(id, 'original.wav', wav(8, 90).buffer)).toMatchObject({ ok: true })
    const manifest = await engine.files.manifest(id)
    if (!manifest.ok) throw new Error(manifest.error.message)
    const streams = engine.streams.list(id)
    if (!streams.ok) throw new Error(streams.error.message)
    const { streamId: _id, ...stream } = streams.value[0]!
    expect(await engine.streams.register({ ...stream, objectHash: manifest.value.files[0]!.objectHash })).toMatchObject({ ok: true })
    expect((await readMusicAnalysis(engine, id)).status).toBe('missing')
    await expect(analyzeMusicSource(engine, id, oldSource.analysisId, oldSource.streamId, new AbortController().signal)).rejects.toThrow()
    expect(await cachedMusicAnalysis(engine, await musicSource(engine, id))).toBeNull()
  }, 20000)

  it('transfers a multi-minute beat map from the worker without truncating IPC output', async () => {
    const { id } = await audio(300)
    const source = await musicSource(engine, id)
    const result = await runRhythmWorker(FFMPEG, source.inputPath, new AbortController().signal)
    expect(result.beats.length).toBeGreaterThan(590)
    expect(result.beats.at(-1)!.timeSeconds).toBeGreaterThan(298)
    expect(result.resources!.pcmRetainedSamples).toBeLessThanOrEqual(1280)
    expect(result.resources!.peakRssBytes).toBeLessThan(512 * 1024 * 1024)
  }, 15000)

  it('keeps failed decode and cancelled analysis distinct from a successful empty beat map', async () => {
    const { id, stream } = await audio(60)
    const source = await musicSource(engine, id)
    const abort = new AbortController()
    const work = runRhythmWorker(FFMPEG, source.inputPath, abort.signal)
    setTimeout(() => abort.abort(), 60)
    await expect(work).rejects.toThrow('cancelled')
    expect(await cachedMusicAnalysis(engine, source)).toBeNull()
    expect(await engine.files.write(id, 'original.wav', 'invalid wav')).toMatchObject({ ok: true })
    const manifest = await engine.files.manifest(id)
    if (!manifest.ok) throw new Error(manifest.error.message)
    const { streamId: _oldId, ...rest } = stream
    const registered = await engine.streams.register({ ...rest, objectHash: manifest.value.files[0]!.objectHash })
    if (!registered.ok) throw new Error(registered.error.message)
    const invalid = await musicSource(engine, id)
    await expect(analyzeMusicSource(engine, id, invalid.analysisId, registered.value.streamId, new AbortController().signal)).rejects.toThrow('decode')
    expect(await cachedMusicAnalysis(engine, invalid)).toBeNull()
  }, 15000)

  it('persists beat corrections with conflict protection and independent undo/redo', async () => {
    const { id } = await audio()
    const sequence = await placeAudio(id)
    const clip = sequence.clips[0] as TimedSequenceClip
    const before = await readSequenceRhythm(engine, sequence.sequenceId)
    const settings: RhythmSettings = { masterClipId: clip.clipId, correction: {
      objectHash: clip.source.range.objectHash, analysisId: null, bpm: 120, beatsPerBar: 3,
      markers: [{ id: 'manual-1', timeSeconds: 0.5, bar: true, manual: true }],
    } }
    const [first, stale] = await Promise.allSettled([
      updateSequenceRhythm(engine, sequence.sequenceId, before.revision, settings),
      updateSequenceRhythm(engine, sequence.sequenceId, before.revision, settings),
    ])
    expect(first.status).toBe('fulfilled')
    expect(stale.status).toBe('rejected')
    const saved = await readSequenceRhythm(engine, sequence.sequenceId)
    expect(saved.settings).toEqual(settings)
    expect(engine.sequences.getPrimary().clips).toEqual(sequence.clips)
    const undo = await updateSequenceRhythm(engine, sequence.sequenceId, saved.revision, 'undo')
    expect(undo.settings.correction).toBeNull()
    expect((await updateSequenceRhythm(engine, sequence.sequenceId, undo.revision, 'redo')).settings).toEqual(settings)
    await queue.stop()
    closeEngineForTest(root, engine)
    engine = createEngineForTest(root)
    expect((await readSequenceRhythm(engine, sequence.sequenceId)).settings).toEqual(settings)
  })

  it('maps source beats and waveform through trim, offset, reverse and rational speed at fractional FPS', async () => {
    const { id } = await audio()
    const sequence = await placeAudio(id)
    sequence.frameRate = { numerator: 30000, denominator: 1001 }
    const original = sequence.clips[0] as TimedSequenceClip
    const clip: TimedSequenceClip = { ...original, timelineStartFrame: 60, durationFrames: 120,
      speed: { numerator: 3, denominator: 2 }, reverse: true,
      source: { ...original.source, range: { ...original.source.range, startTick: 22050, durationTicks: 132300 } },
    }
    const fps = 30000 / 1001
    expect(Math.abs(sourceTimeAtFrame(clip, frameAtSourceTime(clip, 4, fps), fps) - 4)).toBeLessThan(1 / fps)
    const markers = timelineMarkers(clip, [{ id: 'a', timeSeconds: 4, bar: true, manual: true }], sequence)
    expect(markers[0]!.frame).toBe(120)
    expect(nearestBeat(119, markers, 'beats', 5)).toBe(120)
    expect(nearestBeat(110, markers, 'beats', 5)).toBe(110)
    const waveform = clipWaveform(clip, [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7], 8, fps, 4)
    expect(waveform[0]).toBeGreaterThan(waveform.at(-1)!)
    const settings: RhythmSettings = { masterClipId: clip.clipId, correction: { objectHash: 'old', analysisId: null, bpm: null, beatsPerBar: null, markers: [] } }
    expect(effectiveMarkers(clip, settings, null)).toEqual([])
  })
})
