import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createEngine,
  type EditIntent,
  type Engine,
  type Sequence,
} from 'videobook-engine'
import { afterEach, describe, expect, it } from 'vitest'
import { commandPlanDefs } from '../../server/src/tools/command-plan.js'

function resultJson(result: {
  isError?: true
  content: Array<{ type: 'text'; text: string }>
}): unknown {
  if (result.isError) throw new Error(result.content[0]?.text ?? 'Tool failed')
  return JSON.parse(result.content[0]!.text) as unknown
}

async function createTimedArtifact(
  engine: Engine,
  kind: 'audio' | 'video' | 'final',
  label: string,
  durationTicks: number,
) {
  const artifact = await engine.artifacts.create(kind, label)
  if (!artifact.ok) throw new Error(artifact.error.message)
  const sourcePath = kind === 'audio' ? 'original.wav' : 'original.mp4'
  const written = await engine.files.write(
    artifact.value.artifactId,
    sourcePath,
    Buffer.from(`${kind}-${label}`),
  )
  if (!written.ok) throw new Error(written.error.message)
  const manifest = await engine.files.manifest(artifact.value.artifactId)
  if (!manifest.ok) throw new Error(manifest.error.message)
  const objectHash = manifest.value.files.find((file) =>
    file.name === sourcePath)?.objectHash
  if (!objectHash) throw new Error('Missing source object hash')
  const stream = await engine.streams.register({
    artifactId: artifact.value.artifactId,
    sourcePath,
    objectHash,
    streamIndex: 0,
    kind: kind === 'audio' ? 'audio' : 'video',
    timeBase: kind === 'audio'
      ? { numerator: 1, denominator: 48_000 }
      : { numerator: 1, denominator: 30 },
    durationTicks,
    codec: kind === 'audio' ? 'pcm_s16le' : 'h264',
    ...(kind === 'audio'
      ? {
          audio: {
            sampleRateHz: 48_000,
            channels: 2,
            channelLayout: 'stereo',
          },
        }
      : {
          video: {
            width: 1920,
            height: 1080,
            rotationDegrees: 0,
            pixelAspect: { numerator: 1, denominator: 1 },
            nominalFrameRate: { numerator: 30, denominator: 1 },
            averageFrameRate: { numerator: 30, denominator: 1 },
          },
        }),
  })
  if (!stream.ok) throw new Error(stream.error.message)
  return { artifactId: artifact.value.artifactId, stream: stream.value }
}

function toolsFor(engine: Engine) {
  return new Map(commandPlanDefs(engine).map((tool) => [tool.name, tool]))
}

async function plan(
  engine: Engine,
  request: Record<string, unknown>,
  expectedRevision = engine.head,
) {
  const tools = toolsFor(engine)
  return resultJson(await tools.get('plan_sequence_edit')!.handler({
    book_id: engine.book.get().bookId,
    source_surface: 'ui',
    actor: 'music-video-test',
    expected_revision: expectedRevision,
    request,
  })) as {
    summary: string
    stages: Array<{ intent: EditIntent }>
  }
}

async function commitPlan(
  engine: Engine,
  request: Record<string, unknown>,
): Promise<Sequence> {
  const tools = toolsFor(engine)
  const planned = await plan(engine, request)
  const intent = planned.stages[0]!.intent
  const preview = resultJson(await tools.get('preview_edit_intent')!.handler({
    book_id: engine.book.get().bookId,
    intent,
  })) as { valid: boolean; previewHash: string }
  expect(preview.valid).toBe(true)
  return (resultJson(await tools.get('commit_edit_intent')!.handler({
    book_id: engine.book.get().bookId,
    intent,
    preview_hash: preview.previewHash,
  })) as { sequence: Sequence }).sequence
}

describe('music-video canonical sequence plans', () => {
  let rootDir: string | undefined
  let activeEngine: Engine | undefined

  afterEach(async () => {
    activeEngine?.close()
    activeEngine = undefined
    if (rootDir) {
      await rm(rootDir, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      })
    }
    rootDir = undefined
  })

  it('applies an idempotent master soundtrack and atomic ordered appends', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-music-video-setup-'))
    const engine = createEngine({ rootDir, initialBookName: 'music-video-setup' })
    activeEngine = engine
    const soundtrack = await createTimedArtifact(engine, 'audio', 'soundtrack', 480_000)
    const ambient = await createTimedArtifact(engine, 'audio', 'ambient', 96_000)
    const firstVideo = await createTimedArtifact(engine, 'video', 'first', 90)
    const secondVideo = await createTimedArtifact(engine, 'final', 'second', 60)
    let sequence = engine.sequences.getPrimary()
    const videoTrack = sequence.tracks.find((track) => track.kind === 'video')!
    const audioTracks = sequence.tracks.filter((track) => track.kind === 'audio')
    sequence = await commitPlan(engine, {
      kind: 'insert',
      artifact_id: ambient.artifactId,
      track_id: audioTracks[0]!.trackId,
      timeline_start_frame: 0,
    })
    sequence = await commitPlan(engine, {
      kind: 'insert',
      artifact_id: firstVideo.artifactId,
      track_id: videoTrack.trackId,
      timeline_start_frame: 0,
    })
    const visualBeforeSetup = sequence.clips.find((clip) =>
      clip.source.artifactId === firstVideo.artifactId)!
    sequence = await commitPlan(engine, {
      kind: 'speed',
      clip_id: visualBeforeSetup.clipId,
      numerator: 1,
      denominator: 1,
      reverse: false,
      audio_policy: 'preserve-pitch',
    })
    const setup = await plan(engine, {
      kind: 'music_video_setup',
      audio_artifact_id: soundtrack.artifactId,
      audio_track_id: audioTracks[1]!.trackId,
    })
    expect(setup.stages[0]!.intent.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'insert-clip',
        placement: expect.objectContaining({
          trackId: audioTracks[1]!.trackId,
          timelineStartFrame: 0,
          durationFrames: 300,
        }),
      }),
      expect.objectContaining({
        kind: 'set-clip-audio',
        audio: expect.objectContaining({ muted: true }),
      }),
      expect.objectContaining({
        kind: 'set-clip-speed',
        audioPolicy: 'mute',
      }),
    ]))
    sequence = await commitPlan(engine, {
      kind: 'music_video_setup',
      audio_artifact_id: soundtrack.artifactId,
      audio_track_id: audioTracks[1]!.trackId,
    })
    const master = sequence.clips.find((clip) =>
      clip.source.artifactId === soundtrack.artifactId)
    const ambientClip = sequence.clips.find((clip) =>
      clip.source.artifactId === ambient.artifactId)
    const visual = sequence.clips.find((clip) =>
      clip.source.artifactId === firstVideo.artifactId)
    expect(master).toMatchObject({
      timelineStartFrame: 0,
      durationFrames: 300,
      audio: { muted: false },
    })
    expect(ambientClip?.audio?.muted).toBe(true)
    expect(visual).toMatchObject({ audioPolicy: 'mute' })
    const idempotent = await plan(engine, {
      kind: 'music_video_setup',
      audio_artifact_id: soundtrack.artifactId,
      audio_track_id: audioTracks[1]!.trackId,
    })
    expect(idempotent.stages[0]!.intent.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'trim-clip', clipId: master?.clipId }),
      expect.objectContaining({ kind: 'set-clip-audio', clipId: master?.clipId }),
    ]))
    sequence = await commitPlan(engine, {
      kind: 'append_clips',
      track_id: videoTrack.trackId,
      artifact_ids: [secondVideo.artifactId, firstVideo.artifactId],
      timeline_limit_frame: 300,
    })
    const lane = sequence.clips
      .filter((clip) => clip.trackId === videoTrack.trackId)
      .sort((left, right) => left.timelineStartFrame - right.timelineStartFrame)
    expect(lane.map((clip) => [clip.source.artifactId, clip.timelineStartFrame])).toEqual([
      [firstVideo.artifactId, 0],
      [secondVideo.artifactId, 90],
      [firstVideo.artifactId, 150],
    ])
    await expect(plan(engine, {
      kind: 'append_clips',
      track_id: videoTrack.trackId,
      artifact_ids: [firstVideo.artifactId],
      timeline_limit_frame: 200,
    })).rejects.toThrow('beyond soundtrack frame 200')
    const staleRevision = sequence.revision
    await engine.sequences.addTrack(sequence.sequenceId, { kind: 'video' })
    await expect(plan(engine, {
      kind: 'append_clips',
      track_id: videoTrack.trackId,
      artifact_ids: [firstVideo.artifactId],
      timeline_limit_frame: 600,
    }, staleRevision)).rejects.toThrow('Sequence revision changed')
  })

  it('preserves gaps, source ranges, and downstream timing across reorder, trim, and speed', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-music-video-ripple-'))
    const engine = createEngine({ rootDir, initialBookName: 'music-video-ripple' })
    activeEngine = engine
    const first = await createTimedArtifact(engine, 'video', 'first', 90)
    const second = await createTimedArtifact(engine, 'video', 'second', 60)
    const third = await createTimedArtifact(engine, 'video', 'third', 120)
    let sequence = engine.sequences.getPrimary()
    const track = sequence.tracks.find((candidate) => candidate.kind === 'video')!
    sequence = await commitPlan(engine, {
      kind: 'append_clips',
      track_id: track.trackId,
      artifact_ids: [first.artifactId, second.artifactId, third.artifactId],
      timeline_limit_frame: 600,
    })
    sequence = await commitPlan(engine, {
      kind: 'gap',
      timeline_start_frame: 90,
      duration_frames: 10,
      track_ids: [track.trackId],
    })
    sequence = await commitPlan(engine, {
      kind: 'gap',
      timeline_start_frame: 160,
      duration_frames: 20,
      track_ids: [track.trackId],
    })
    const before = sequence.clips
      .filter((clip) => clip.trackId === track.trackId)
      .sort((left, right) => left.timelineStartFrame - right.timelineStartFrame)
    expect(before.map((clip) => clip.timelineStartFrame)).toEqual([0, 100, 180])
    sequence = await commitPlan(engine, {
      kind: 'reorder_clips',
      track_id: track.trackId,
      clip_ids: [before[2]!.clipId, before[0]!.clipId, before[1]!.clipId],
      timeline_limit_frame: 600,
    })
    let lane = sequence.clips
      .filter((clip) => clip.trackId === track.trackId)
      .sort((left, right) => left.timelineStartFrame - right.timelineStartFrame)
    expect(lane.map((clip) => [clip.source.artifactId, clip.timelineStartFrame])).toEqual([
      [third.artifactId, 0],
      [first.artifactId, 130],
      [second.artifactId, 240],
    ])
    const lead = lane[0]!
    sequence = await commitPlan(engine, {
      kind: 'trim',
      clip_id: lead.clipId,
      timeline_start_frame: 0,
      duration_frames: 90,
      edge: 'end',
      ripple: true,
      timeline_limit_frame: 600,
    })
    lane = sequence.clips
      .filter((clip) => clip.trackId === track.trackId)
      .sort((left, right) => left.timelineStartFrame - right.timelineStartFrame)
    expect(lane.map((clip) => clip.timelineStartFrame)).toEqual([0, 100, 210])
    expect(lane[0]).toMatchObject({
      durationFrames: 90,
      source: { range: { startTick: 0, durationTicks: 90 } },
    })
    sequence = await commitPlan(engine, {
      kind: 'trim',
      clip_id: lane[0]!.clipId,
      timeline_start_frame: 0,
      duration_frames: 120,
      edge: 'end',
      ripple: true,
      timeline_limit_frame: 600,
    })
    lane = sequence.clips
      .filter((clip) => clip.trackId === track.trackId)
      .sort((left, right) => left.timelineStartFrame - right.timelineStartFrame)
    expect(lane.map((clip) => clip.timelineStartFrame)).toEqual([0, 130, 240])
    const sourceRange = lane[0]!.source.kind === 'timed'
      ? lane[0]!.source.range
      : null
    sequence = await commitPlan(engine, {
      kind: 'speed',
      clip_id: lane[0]!.clipId,
      numerator: 2,
      denominator: 1,
      reverse: false,
      audio_policy: 'mute',
      ripple: true,
      timeline_limit_frame: 600,
    })
    lane = sequence.clips
      .filter((clip) => clip.trackId === track.trackId)
      .sort((left, right) => left.timelineStartFrame - right.timelineStartFrame)
    expect(lane.map((clip) => clip.timelineStartFrame)).toEqual([0, 70, 180])
    expect(lane[0]).toMatchObject({ durationFrames: 60, source: { range: sourceRange } })
    sequence = await commitPlan(engine, {
      kind: 'speed',
      clip_id: lane[0]!.clipId,
      numerator: 1,
      denominator: 2,
      reverse: false,
      audio_policy: 'mute',
      ripple: true,
      timeline_limit_frame: 600,
    })
    lane = sequence.clips
      .filter((clip) => clip.trackId === track.trackId)
      .sort((left, right) => left.timelineStartFrame - right.timelineStartFrame)
    expect(lane.map((clip) => clip.timelineStartFrame)).toEqual([0, 250, 360])
    expect(lane[0]).toMatchObject({ durationFrames: 240, source: { range: sourceRange } })
  })

  it('rejects locked-track soundtrack setup and main-lane appends', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-music-video-locked-'))
    const engine = createEngine({ rootDir, initialBookName: 'music-video-locked' })
    activeEngine = engine
    const soundtrack = await createTimedArtifact(engine, 'audio', 'soundtrack', 480_000)
    const ambient = await createTimedArtifact(engine, 'audio', 'ambient', 96_000)
    const video = await createTimedArtifact(engine, 'video', 'clip', 90)
    let sequence = engine.sequences.getPrimary()
    const videoTrack = sequence.tracks.find((track) => track.kind === 'video')!
    const audioTracks = sequence.tracks.filter((track) => track.kind === 'audio')
    sequence = await commitPlan(engine, {
      kind: 'insert',
      artifact_id: ambient.artifactId,
      track_id: audioTracks[0]!.trackId,
      timeline_start_frame: 0,
    })
    const lockedAudio = await engine.sequences.updateTrack(audioTracks[0]!.trackId, {
      locked: true,
    })
    if (!lockedAudio.ok) throw new Error(lockedAudio.error.message)
    await expect(plan(engine, {
      kind: 'music_video_setup',
      audio_artifact_id: soundtrack.artifactId,
      audio_track_id: audioTracks[1]!.trackId,
    })).rejects.toThrow(`Unlock audio track ${audioTracks[0]!.name}`)
    const lockedVideo = await engine.sequences.updateTrack(videoTrack.trackId, {
      locked: true,
    })
    if (!lockedVideo.ok) throw new Error(lockedVideo.error.message)
    await expect(plan(engine, {
      kind: 'append_clips',
      track_id: videoTrack.trackId,
      artifact_ids: [video.artifactId],
      timeline_limit_frame: 600,
    })).rejects.toThrow('No editable video track is available')
  })
})
