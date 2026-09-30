import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type EditIntent, type Engine, type Sequence, type TimedSequenceClip } from 'videobook-engine'
import { closeEngineForTest, createEngineForTest } from '../../server/src/engine.js'
import { queue, setEngineRoot } from '../../server/src/queue.js'
import { registerAnalyzeMusicJob } from '../../server/src/jobs/analyze-music.js'
import { registerLabelMusicSectionsJob } from '../../server/src/jobs/label-music-sections.js'
import { registerEditingMomentsJob } from '../../server/src/jobs/analyze-editing-moments.js'
import { musicAnalysisDefs } from '../../server/src/tools/music-analysis.js'
import { musicDraftDefs } from '../../server/src/tools/music-draft.js'
import { commandPlanDefs } from '../../server/src/tools/command-plan.js'
import { analyzeMusicSource, cachedMusicAnalysis, musicSource, readMusicAnalysis } from '../../server/src/rhythm/music-analysis.js'
import { updateSequenceRhythm } from '../../server/src/rhythm/sequence-rhythm.js'
import { planMusicVideo } from '../../server/src/rhythm/music-draft.js'
import { energySegments } from '../../server/src/rhythm/energy.js'
import { FFMPEG, probeVideo } from '../../server/src/ffmpeg.js'
import { synthesizeClicks } from '../../server/src/rhythm/synthesize.js'
import type { MusicAnalysis, MusicAnalysisState } from '../../server/src/rhythm/model.js'
import type { ToolResult } from '../../server/src/tools/tool-def.js'

const exec = promisify(execFile)

function decode<T>(result: ToolResult): T {
  if (result.isError) throw new Error(result.content[0]!.text)
  return JSON.parse(result.content[0]!.text) as T
}

function steppedWav(seconds: number, bpm: number, quietGain: number, loudGain: number, stepSeconds: number) {
  const { samples, sampleRate } = synthesizeClicks({ seconds, bpm, leadSilenceSeconds: 0 })
  for (let index = 0; index < samples.length; index += 1) {
    const gain = index / sampleRate < stepSeconds ? quietGain : loudGain
    samples[index] = samples[index]! * gain
  }
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
  return { buffer, sampleRate, sampleCount: samples.length }
}

describe('optional music sections, energy planning and provenance', () => {
  let root: string
  let engine: Engine
  let savedKey: string | undefined
  const FPS = 30

  beforeEach(async () => {
    savedKey = process.env.OPENAI_API_KEY
    delete process.env.OPENAI_API_KEY
    root = await mkdtemp(join(tmpdir(), 'videobook-sections-'))
    engine = createEngineForTest(root)
    await setEngineRoot(root, engine)
    registerAnalyzeMusicJob(engine)
    registerLabelMusicSectionsJob(engine)
    registerEditingMomentsJob(engine)
  })
  afterEach(async () => {
    await queue.stop()
    closeEngineForTest(root, engine)
    await rm(root, { recursive: true, force: true })
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = savedKey
  })

  async function createAudio(seconds = 16, bpm = 120): Promise<{ id: string }> {
    const data = steppedWav(seconds, bpm, 0.12, 0.95, seconds / 2)
    const created = await engine.artifacts.create('audio', 'Sections fixture')
    if (!created.ok) throw new Error(created.error.message)
    const id = created.value.artifactId
    const written = await engine.files.write(id, 'original.wav', data.buffer)
    if (!written.ok) throw new Error(written.error.message)
    const manifest = await engine.files.manifest(id)
    if (!manifest.ok) throw new Error(manifest.error.message)
    const stream = await engine.streams.register({
      artifactId: id, sourcePath: 'original.wav', objectHash: manifest.value.files[0]!.objectHash,
      streamIndex: 0, kind: 'audio', codec: 'pcm_s16le', durationTicks: data.sampleCount,
      timeBase: { numerator: 1, denominator: data.sampleRate },
      audio: { sampleRateHz: data.sampleRate, channels: 1, channelLayout: 'mono' },
    })
    if (!stream.ok) throw new Error(stream.error.message)
    return { id }
  }

  async function createVideo(seconds: number, label: string): Promise<string> {
    const path = join(root, `${label}.mp4`)
    await exec(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=black:s=160x90:r=${FPS}:d=${seconds}`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path])
    const artifact = await engine.artifacts.create('video', label)
    if (!artifact.ok) throw new Error(artifact.error.message)
    const written = await engine.files.writeFromPath(artifact.value.artifactId, 'original.mp4', path)
    if (!written.ok) throw new Error(written.error.message)
    const manifest = await engine.files.manifest(artifact.value.artifactId)
    if (!manifest.ok) throw new Error(manifest.error.message)
    const probe = await probeVideo(path)
    const video = probe.videoStream
    if (!video) throw new Error('Video fixture stream missing')
    const registered = await engine.streams.register({
      artifactId: artifact.value.artifactId, sourcePath: 'original.mp4', objectHash: manifest.value.files[0]!.objectHash,
      streamIndex: video.index, kind: 'video', codec: video.codec,
      durationTicks: video.durationTicks, timeBase: video.timeBase,
      video: video.video,
    })
    if (!registered.ok) throw new Error(registered.error.message)
    return artifact.value.artifactId
  }

  async function placeAudio(id: string): Promise<Sequence> {
    const sequence = engine.sequences.getPrimary()
    const track = sequence.tracks.find((item) => item.kind === 'audio')!
    const tools = commandPlanDefs(engine)
    const plan = decode<{ stages: Array<{ intent: EditIntent }> }>(await tools.find((tool) => tool.name === 'plan_sequence_edit')!.handler({
      book_id: engine.book.get().bookId, source_surface: 'ui', actor: 'sections-test',
      request: { kind: 'append', artifact_id: id, track_id: track.trackId },
    }))
    const intent = plan.stages[0]!.intent
    const preview = engine.edits.preview(intent)
    if (!preview.ok) throw new Error(preview.error.message)
    const committed = await engine.edits.commit(intent, preview.value.previewHash)
    if (!committed.ok) throw new Error(committed.error.message)
    return committed.value.sequence
  }

  async function verifyBeatMap(sequence: Sequence, master: TimedSequenceClip, seconds: number) {
    return updateSequenceRhythm(engine, sequence.sequenceId, 'none', {
      masterClipId: master.clipId,
      correction: {
        objectHash: master.source.range.objectHash, analysisId: null, bpm: 120, beatsPerBar: null,
        markers: Array.from({ length: Math.floor(seconds * 2) }, (_, index) => ({
          id: `beat-${index}`, timeSeconds: index / 2, manual: true, bar: false,
        })),
      },
    })
  }

  it('caches a source-timed energy curve and suggested section boundaries with provenance', async () => {
    const { id } = await createAudio()
    const source = await musicSource(engine, id)
    const first = await analyzeMusicSource(engine, id, source.analysisId, source.streamId, new AbortController().signal)
    expect(first.energy).not.toBeNull()
    expect(first.energy!.algorithmId).toBe('videobook-rms-energy')
    expect(first.energy!.algorithmVersion).toBe('1')
    expect(first.energy!.hopSeconds).toBeGreaterThan(0.2)
    expect(first.energy!.hopSeconds).toBeLessThan(0.3)
    expect(first.energy!.values.length).toBeGreaterThan(50)
    expect(first.energy!.values.every((value) => value >= 0 && value <= 1)).toBe(true)
    expect(first.sections).not.toBeNull()
    expect(first.sections!.algorithmId).toBe('videobook-energy-sections')
    expect(first.sections!.algorithmVersion).toBe('1')
    expect(first.sections!.candidates).toHaveLength(1)
    const boundary = first.sections!.candidates[0]!
    expect(Math.abs(boundary.timeSeconds - 8)).toBeLessThan(2.5)
    expect(boundary.quality).toBeGreaterThan(0.5)
    expect(boundary.id).toBe('section-1')
    const second = await analyzeMusicSource(engine, id, source.analysisId, source.streamId, new AbortController().signal)
    expect(second.energy).toEqual(first.energy)
    expect(second.sections).toEqual(first.sections)
    const cached = await cachedMusicAnalysis(engine, await musicSource(engine, id))
    expect(cached).toEqual(first)
    const state = await readMusicAnalysis(engine, id)
    expect(state.status).toBe('ready')
    expect(state.sections!.status).toBe('missing')
    expect(state.sections!.labels).toBeNull()
    const read = decode<MusicAnalysisState>(await musicAnalysisDefs(engine).find((tool) => tool.name === 'get_music_analysis')!.handler({
      book_id: engine.book.get().bookId, asset_id: id,
    }))
    expect(read.analysis!.energy).toEqual(first.energy)
    expect(read.analysis!.sections).toEqual(first.sections)
    expect(read.sections!.status).toBe('missing')
  }, 30000)

  it('keeps quiet passages low and loud passages high with deterministic tiers', async () => {
    const { id } = await createAudio()
    const source = await musicSource(engine, id)
    const analysis = await analyzeMusicSource(engine, id, source.analysisId, source.streamId, new AbortController().signal)
    const segments = energySegments(analysis.energy!, analysis.sections, analysis.durationSeconds)
    expect(segments).toHaveLength(2)
    expect(segments[0]!.tier).toBe('low')
    expect(segments[1]!.tier).toBe('high')
    expect(segments[0]!.meanEnergy).toBeLessThan(segments[1]!.meanEnergy)
    const repeat = energySegments(analysis.energy!, analysis.sections, analysis.durationSeconds)
    expect(repeat).toEqual(segments)
  }, 30000)

  it('records optional label absence without touching the local analysis', async () => {
    const { id } = await createAudio()
    const tools = musicAnalysisDefs(engine)
    const analyze = tools.find((tool) => tool.name === 'analyze_music')!
    const args = { book_id: engine.book.get().bookId, asset_id: id, sections: true }
    const queued = decode<MusicAnalysisState>(await analyze.handler(args))
    expect(queued.analysis).toBeNull()
    await expect.poll(async () => (await readMusicAnalysis(engine, id)).status, { timeout: 20000 }).toBe('ready')
    await expect.poll(async () => (await readMusicAnalysis(engine, id)).sections?.status, { timeout: 10000 }).toBe('unavailable')
    const state = await readMusicAnalysis(engine, id)
    expect(state.sections!.labels).toBeNull()
    expect(state.sections!.error).toContain('OPENAI_API_KEY')
    expect(state.analysis!.beats.length).toBeGreaterThan(10)
    expect(state.analysis!.energy).not.toBeNull()
    const again = decode<MusicAnalysisState>(await analyze.handler(args))
    expect(again.sections!.status).toBe('unavailable')
    const jobs = engine.jobs.queue.list({ type: 'label_music_sections', limit: 100 })
    expect(jobs).toHaveLength(1)
    const settled = decode<MusicAnalysisState>(await analyze.handler({ book_id: engine.book.get().bookId, asset_id: id }))
    expect(settled.status).toBe('ready')
    expect(settled.sections!.status).toBe('unavailable')
  }, 40000)

  it('plans denser cuts in loud sections while every cut stays on the verified beat map', async () => {
    const { id } = await createAudio()
    const footage = await createVideo(20, 'sections-footage')
    const sequence = await placeAudio(id)
    const master = sequence.clips.find((clip) => clip.trackId === sequence.tracks.find((track) => track.kind === 'audio')!.trackId) as TimedSequenceClip
    const videoTrack = sequence.tracks.find((track) => track.kind === 'video')!
    const source = await musicSource(engine, id)
    const analysis = await analyzeMusicSource(engine, id, source.analysisId, source.streamId, new AbortController().signal)
    const rhythm = await verifyBeatMap(sequence, master, 16)
    const videoTools = musicDraftDefs(engine)
    const planTool = videoTools.find((tool) => tool.name === 'plan_music_video')!
    const base = {
      book_id: engine.book.get().bookId, expected_revision: engine.head, rhythm_revision: rhythm.revision,
      actor: 'sections-test', source_surface: 'ui',
      options: {
        track_id: videoTrack.trackId, start_frame: 0, end_frame: 480,
        sources: [{ artifact_id: footage }], interval: 2, unit: 'beats', minimum_shot_frames: 1,
        preserve_existing: true, preserve_clip_ids: [], reuse_sources: false, allow_retiming: false,
      },
    }
    const plain = decode<{ shots: Array<{ startFrame: number; endFrame: number }>; energyPlan?: unknown }>(await planTool.handler(JSON.parse(JSON.stringify(base))))
    expect(plain.energyPlan).toBeUndefined()
    const markerFrames = new Set<number>([0])
    for (let index = 0; index < 32; index += 1) markerFrames.add(index * 15)
    for (const shot of plain.shots) {
      expect(markerFrames.has(shot.startFrame)).toBe(true)
      expect(shot.endFrame === 480 || markerFrames.has(shot.endFrame)).toBe(true)
    }
    const requested = JSON.parse(JSON.stringify(base))
    requested.options.strategy = 'follow_song_energy'
    requested.options.analysis = { music_analysis_id: source.analysisId }
    const first = decode<{
      shots: Array<{ startFrame: number; endFrame: number }>
      energyPlan: { strategy: string; musicAnalysisId: string; segments: Array<{ startFrame: number; endFrame: number; tier: string; interval: number }> }
    }>(await planTool.handler(requested))
    expect(first.energyPlan.strategy).toBe('follow_song_energy')
    expect(first.energyPlan.musicAnalysisId).toBe(source.analysisId)
    const tiers = first.energyPlan.segments.map((segment) => segment.tier)
    expect(tiers).toContain('low')
    expect(tiers).toContain('high')
    for (const shot of first.shots) {
      expect(markerFrames.has(shot.startFrame)).toBe(true)
      expect(shot.endFrame === 480 || markerFrames.has(shot.endFrame)).toBe(true)
    }
    const quietCuts = first.shots.filter((shot) => shot.startFrame < 240).length
    const loudCuts = first.shots.filter((shot) => shot.startFrame >= 240).length
    expect(loudCuts).toBeGreaterThan(quietCuts * 2)
    const loudInterval = first.energyPlan.segments.find((segment) => segment.tier === 'high')!.interval
    const quietInterval = first.energyPlan.segments.find((segment) => segment.tier === 'low')!.interval
    expect(loudInterval).toBe(2)
    expect(quietInterval).toBe(8)
    const second = decode<{ shots: Array<{ startFrame: number; endFrame: number }>; energyPlan: unknown }>(await planTool.handler(requested))
    expect(second.shots).toEqual(first.shots)
    expect(second.energyPlan).toEqual(first.energyPlan)
    expect(first.shots.length).toBeGreaterThan(plain.shots.filter((shot) => shot.startFrame >= 240).length)
    expect(analysis.analysisId).toBe(source.analysisId)
  }, 60000)

  it('rejects stale analysis and moments references instead of planning from them', async () => {
    const { id } = await createAudio()
    const footage = await createVideo(8, 'stale-footage')
    const sequence = await placeAudio(id)
    const master = sequence.clips.find((clip) => clip.trackId === sequence.tracks.find((track) => track.kind === 'audio')!.trackId) as TimedSequenceClip
    const videoTrack = sequence.tracks.find((track) => track.kind === 'video')!
    const source = await musicSource(engine, id)
    await analyzeMusicSource(engine, id, source.analysisId, source.streamId, new AbortController().signal)
    const rhythm = await verifyBeatMap(sequence, master, 16)
    const options = {
      track_id: videoTrack.trackId, start_frame: 0, end_frame: 480,
      sources: [{ artifact_id: footage }], interval: 2 as const, unit: 'beats' as const, minimum_shot_frames: 1,
      preserve_existing: true, preserve_clip_ids: [] as string[], reuse_sources: false, allow_retiming: false,
      strategy: 'follow_song_energy' as const,
    }
    await expect(planMusicVideo(engine, {
      ...options, analysis: { music_analysis_id: 'not-the-current-analysis' },
    }, engine.head, rhythm.revision, 'stale-test', 'ui')).rejects.toThrow(/stale/)
    const tampered = await engine.metadata.artifacts.write(id, `music.analysis.${source.analysisId}`, {
      analysisId: source.analysisId, artifactId: id, objectHash: source.objectHash, streamId: source.streamId,
      durationSeconds: source.durationSeconds, analyzerVersion: 'videobook-spectral-flux-dp@4',
      beats: [{ timeSeconds: 0.5, confidence: 0.9 }], bpm: 120, confidence: 0.9,
      bars: null, beatsPerBar: 4, barSource: 'detected', waveform: [0.5], lowConfidence: false,
      energy: null, sections: null,
    } satisfies MusicAnalysis)
    expect(tampered).toMatchObject({ ok: true })
    await expect(planMusicVideo(engine, {
      ...options, analysis: { music_analysis_id: source.analysisId },
    }, engine.head, rhythm.revision, 'stale-test', 'ui')).rejects.toThrow(/energy curve/)
    await expect(planMusicVideo(engine, {
      ...options, analysis: { music_analysis_id: source.analysisId, moments: [{ artifact_id: footage, moments_id: 'missing-moments' }] },
    }, engine.head, rhythm.revision, 'stale-test', 'ui')).rejects.toThrow(/stale or missing/)
    await expect(planMusicVideo(engine, options, engine.head, rhythm.revision, 'stale-test', 'ui')).rejects.toThrow(/energy curve/)
  }, 60000)
})
