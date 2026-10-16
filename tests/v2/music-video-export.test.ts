import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createEngine, type Engine, type EditIntent, type TimedSequenceClip } from 'videobook-engine'
import { afterEach, expect, it } from 'vitest'
import { FFMPEG, probeVideo } from '../../server/src/ffmpeg.js'
import { commandPlanDefs } from '../../server/src/tools/command-plan.js'
import { updateSequenceRhythm } from '../../server/src/rhythm/sequence-rhythm.js'
import { planMusicVideo, commitMusicVideo } from '../../server/src/rhythm/music-draft.js'
import { registerExportSequenceJob } from '../../server/src/jobs/export-sequence.js'
import { queue, setEngineRoot } from '../../server/src/queue.js'

const exec = promisify(execFile)
let root = ''
let engine: Engine | undefined

afterEach(async () => {
  await queue.stop()
  engine?.close()
  if (root) await rm(root, { recursive: true, force: true })
})

it('renders fitted beat cuts at the reviewed frames with trimmed and offset soundtrack timing', async () => {
  root = await mkdtemp(join(tmpdir(), 'videobook-beat-export-'))
  engine = createEngine({ durableWrites: false, rootDir: root, initialBookName: 'beat-export' })
  await setEngineRoot(root, engine)
  const fixtures = [
    { label: 'portrait', kind: 'video' as const, input: 'color=red:s=90x160:r=30:d=2', filters: 'drawbox=x=0:y=0:w=iw:h=12:c=lime:t=fill,drawbox=x=0:y=148:w=iw:h=12:c=blue:t=fill' },
    { label: 'landscape', kind: 'video' as const, input: 'color=yellow:s=160x90:r=30:d=2' },
    { label: 'song', kind: 'audio' as const, input: 'aevalsrc=0.3*sin(2*PI*880*t)*lt(mod(t+0.25\\,0.5)\\,0.06):s=48000:d=4' },
  ]
  const artifacts: Array<{ id: string; label: string }> = []
  for (const fixture of fixtures) {
    const path = join(root, fixture.kind === 'audio' ? 'song.wav' : `${fixture.label}.mp4`)
    await exec(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', fixture.input,
      ...(fixture.filters ? ['-vf', fixture.filters] : []), ...(fixture.kind === 'video' ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'] : ['-c:a', 'pcm_s16le']), path])
    const artifact = await engine.artifacts.create(fixture.kind, fixture.label)
    if (!artifact.ok) throw new Error(artifact.error.message)
    const name = fixture.kind === 'audio' ? 'original.wav' : 'original.mp4'
    const written = await engine.files.writeFromPath(artifact.value.artifactId, name, path)
    if (!written.ok) throw new Error(written.error.message)
    const manifest = await engine.files.manifest(artifact.value.artifactId)
    if (!manifest.ok) throw new Error(manifest.error.message)
    const probe = await probeVideo(path)
    const stream = fixture.kind === 'audio' ? probe.audioStream : probe.videoStream
    if (!stream) throw new Error('Fixture stream missing')
    const registered = await engine.streams.register({ artifactId: artifact.value.artifactId, objectHash: manifest.value.files[0]!.objectHash,
      sourcePath: name, streamIndex: stream.index, kind: fixture.kind, codec: stream.codec, timeBase: stream.timeBase, durationTicks: stream.durationTicks,
      ...(stream.video ? { video: stream.video } : {}), ...(stream.audio ? { audio: stream.audio } : {}) })
    if (!registered.ok) throw new Error(registered.error.message)
    artifacts.push({ id: artifact.value.artifactId, label: fixture.label })
  }
  const sequence = engine.sequences.getPrimary()
  const audioTrack = sequence.tracks.find((track) => track.kind === 'audio')!
  const videoTrack = sequence.tracks.find((track) => track.kind === 'video')!
  const planner = commandPlanDefs(engine).find((tool) => tool.name === 'plan_sequence_edit')!
  const append = await planner.handler({ book_id: engine.book.get().bookId, actor: 'export-test', source_surface: 'ui', edits: [{ kind: 'append', artifact_id: artifacts[2]!.id, track_id: audioTrack.trackId }] })
  if (append.isError) throw new Error(append.content[0]!.text)
  const intent = (JSON.parse(append.content[0]!.text) as { stages: Array<{ intent: EditIntent }> }).stages[0]!.intent
  const placement = intent.operations[0]
  if (placement?.kind !== 'insert-clip' || placement.placement.source.kind !== 'timed') throw new Error('Timed audio placement missing')
  placement.placement.timelineStartFrame = 15
  placement.placement.durationFrames = 90
  placement.placement.source.range.startTick = 24_000
  placement.placement.source.range.durationTicks = 144_000
  const preview = engine.edits.preview(intent)
  if (!preview.ok) throw new Error(preview.error.message)
  const audioCommit = await engine.edits.commit(intent, preview.value.previewHash)
  if (!audioCommit.ok) throw new Error(audioCommit.error.message)
  const master = audioCommit.value.sequence.clips[0] as TimedSequenceClip
  const rhythm = await updateSequenceRhythm(engine, sequence.sequenceId, 'none', { masterClipId: master.clipId,
    correction: { objectHash: master.source.range.objectHash, analysisId: null, bpm: 120, beatsPerBar: null,
      markers: Array.from({ length: 8 }, (_, index) => ({ id: `beat-${index}`, timeSeconds: index / 2, manual: true, bar: false })) } })
  const draft = await planMusicVideo(engine, { track_id: videoTrack.trackId, start_frame: 15, end_frame: 105,
    sources: artifacts.slice(0, 2).map((asset) => ({ artifact_id: asset.id })), interval: 1, unit: 'beats', minimum_shot_frames: 3,
    preserve_existing: true, preserve_clip_ids: [], reuse_sources: false, allow_retiming: false }, engine.head, rhythm.revision, 'export-test', 'ui')
  expect(draft.shots.map((shot) => shot.startFrame)).toEqual([15, 30, 45, 60, 75, 90])
  expect(draft.uncovered).toEqual([])
  const committed = await commitMusicVideo(engine, draft.plan.stages[0]!.intent, draft.preview.previewHash, rhythm.revision, draft.sequenceContentRevision)
  registerExportSequenceJob(engine)
  const output = await queue.enqueueAndWait<{ artifactId: string; output: string }>('beat-export', {
    type: 'export_sequence', bookId: engine.book.get().bookId, sequenceRevision: committed.revision, orientation: 'landscape', captions: 'omit',
  }, 60000)
  const manifest = await engine.files.manifest(output.artifactId)
  if (!manifest.ok) throw new Error(manifest.error.message)
  const path = join(manifest.value.path, output.output)
  const probe = await probeVideo(path)
  expect(probe.width).toBe(1920)
  expect(probe.height).toBe(1080)
  expect(Math.abs(probe.duration - 3.5)).toBeLessThan(0.08)
  const frame = async (index: number) => (await exec(FFMPEG, ['-v', 'error', '-i', path, '-vf', `select=eq(n\\,${index}),scale=160:90`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer', maxBuffer: 160 * 90 * 3 + 1024 })).stdout
  const rgb = (pixels: Buffer, x: number, y: number) => [...pixels.subarray((y * 160 + x) * 3, (y * 160 + x) * 3 + 3)]
  expect(Math.max(...rgb(await frame(14), 80, 45))).toBeLessThan(15)
  const portrait = await frame(15)
  expect(rgb(portrait, 80, 45)[0]).toBeGreaterThan(180)
  expect(Math.max(...rgb(portrait, 10, 45))).toBeLessThan(15)
  expect(rgb(portrait, 80, 2)[1]).toBeGreaterThan(150)
  expect(rgb(portrait, 80, 87)[2]).toBeGreaterThan(150)
  const landscape = await frame(30)
  expect(rgb(landscape, 10, 45).slice(0, 2).every((value) => value > 170)).toBe(true)
  expect(rgb(await frame(29), 80, 45)[1]).toBeLessThan(40)
  const pcm = (await exec(FFMPEG, ['-v', 'error', '-i', path, '-vn', '-ac', '1', '-ar', '8000', '-f', 'f32le', 'pipe:1'], { encoding: 'buffer', maxBuffer: 200000 })).stdout
  const rms = (start: number, end: number) => {
    let energy = 0
    const first = Math.floor(start * 8000)
    const last = Math.floor(end * 8000)
    for (let index = first; index < last; index++) energy += pcm.readFloatLE(index * 4) ** 2
    return Math.sqrt(energy / (last - first))
  }
  expect(rms(0.1, 0.4)).toBeLessThan(0.001)
  expect(rms(0.52, 0.65)).toBeLessThan(0.002)
  expect(rms(0.76, 0.80)).toBeGreaterThan(0.1)
  expect(rms(0.76, 0.80)).toBeLessThan(0.25)
  expect(rms(0.9, 1.1)).toBeLessThan(0.002)
}, 90000)
