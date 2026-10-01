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
import { planMusicVideo, commitMusicVideo } from '../../server/src/rhythm/music-draft.js'
import { readSequenceRhythm, updateSequenceRhythm } from '../../server/src/rhythm/sequence-rhythm.js'
import type { MusicDraftOptions } from '../../server/src/rhythm/draft-model.js'
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
  request: Record<string, unknown> | Record<string, unknown>[],
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
  request: Record<string, unknown> | Record<string, unknown>[],
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

  it('assembles unlimited sequential clips and ripples removal on only the selected track', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-row-timeline-'))
    const engine = createEngine({ durableWrites: false, rootDir, initialBookName: 'row-timeline' })
    activeEngine = engine
    const video = await createTimedArtifact(engine, 'video', 'short video', 15)
    const audio = await createTimedArtifact(engine, 'audio', 'long audio', 480_000)
    let sequence = engine.sequences.getPrimary()
    const videoTrack = sequence.tracks.find((track) => track.kind === 'video')!
    const audioTracks = sequence.tracks.filter((track) => track.kind === 'audio')
    for (let index = 0; index < 12; index += 1) {
      sequence = await commitPlan(engine, { kind: 'append', track_id: videoTrack.trackId, artifact_id: video.artifactId })
    }
    const videos = sequence.clips.filter((clip) => clip.trackId === videoTrack.trackId)
    expect(videos.map((clip) => clip.timelineStartFrame).sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, index) => index * 15))
    expect(new Set(videos.map((clip) => clip.clipId)).size).toBe(12)
    expect(videos.every((clip) => clip.durationFrames === 15 && 'audioPolicy' in clip && clip.audioPolicy === 'preserve-pitch' && !clip.audio?.muted)).toBe(true)
    for (const track of audioTracks.slice(0, 2)) {
      sequence = await commitPlan(engine, { kind: 'append', track_id: track.trackId, artifact_id: audio.artifactId })
      sequence = await commitPlan(engine, { kind: 'append', track_id: track.trackId, artifact_id: audio.artifactId })
    }
    const otherTracks = sequence.clips.filter((clip) => clip.trackId !== videoTrack.trackId)
    expect(otherTracks.map((clip) => clip.timelineStartFrame).sort((a, b) => a - b)).toEqual([0, 0, 300, 300])
    const removed = videos.find((clip) => clip.timelineStartFrame === 15)!
    sequence = await commitPlan(engine, { kind: 'remove_clip', clip_id: removed.clipId, ripple: true })
    expect(sequence.clips.some((clip) => clip.clipId === removed.clipId)).toBe(false)
    expect(sequence.clips.filter((clip) => clip.trackId !== videoTrack.trackId)).toEqual(otherTracks)
    expect(sequence.clips.filter((clip) => clip.trackId === videoTrack.trackId).map((clip) => clip.timelineStartFrame).sort((a, b) => a - b))
      .toEqual(Array.from({ length: 11 }, (_, index) => index * 15))
    const stale = sequence.revision
    const tracksBefore = sequence.tracks.length
    for (let index = 0; index < 6; index += 1) {
      expect((await engine.sequences.addTrack(sequence.sequenceId, { kind: 'audio' })).ok).toBe(true)
    }
    expect(engine.sequences.getPrimary().tracks).toHaveLength(tracksBefore + 6)
    await expect(plan(engine, { kind: 'append', track_id: videoTrack.trackId, artifact_id: video.artifactId }, stale)).rejects.toThrow('Sequence revision changed')
    await expect(plan(engine, { kind: 'append', track_id: audioTracks[0]!.trackId, artifact_id: video.artifactId })).rejects.toThrow('Choose an audio source')
    expect((await engine.sequences.updateTrack(videoTrack.trackId, { locked: true })).ok).toBe(true)
    await expect(plan(engine, { kind: 'append', track_id: videoTrack.trackId, artifact_id: video.artifactId })).rejects.toThrow('locked')
    expect((await engine.sequences.updateTrack(videoTrack.trackId, { locked: false })).ok).toBe(true)
    expect((await engine.files.write(video.artifactId, 'original.mp4', Buffer.from('replaced source bytes'))).ok).toBe(true)
    await expect(plan(engine, { kind: 'append', track_id: videoTrack.trackId, artifact_id: video.artifactId })).rejects.toThrow('current source media')
    engine.close()
    activeEngine = createEngine({ durableWrites: false, rootDir })
    expect(activeEngine.sequences.getPrimary().clips).toEqual(sequence.clips)
  })

  it('keeps batched appends in request order independently on each track', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-append-batch-'))
    const engine = createEngine({ durableWrites: false, rootDir, initialBookName: 'append-batch' })
    activeEngine = engine
    const first = await createTimedArtifact(engine, 'video', 'first', 60)
    const second = await createTimedArtifact(engine, 'video', 'second', 30)
    const audio = await createTimedArtifact(engine, 'audio', 'audio', 96_000)
    const before = engine.sequences.getPrimary()
    const videoTrack = before.tracks.find((track) => track.kind === 'video')!.trackId
    const audioTrack = before.tracks.find((track) => track.kind === 'audio')!.trackId
    await commitPlan(engine, { kind: 'append', track_id: videoTrack, artifact_id: second.artifactId })
    const after = await commitPlan(engine, [
      { kind: 'append', track_id: videoTrack, artifact_id: first.artifactId },
      { kind: 'append', track_id: audioTrack, artifact_id: audio.artifactId },
      { kind: 'append', track_id: videoTrack, artifact_id: second.artifactId },
      { kind: 'append', track_id: audioTrack, artifact_id: audio.artifactId },
    ])
    expect(after.clips.filter((clip) => clip.trackId === videoTrack).sort((left, right) => left.timelineStartFrame - right.timelineStartFrame)
      .map((clip) => [clip.source.artifactId, clip.timelineStartFrame, clip.durationFrames]))
      .toEqual([[second.artifactId, 0, 30], [first.artifactId, 30, 60], [second.artifactId, 90, 30]])
    expect(after.clips.filter((clip) => clip.trackId === audioTrack).map((clip) => clip.timelineStartFrame).sort((a, b) => a - b)).toEqual([0, 60])
    await expect(plan(engine, [
      { kind: 'append', track_id: videoTrack, artifact_id: first.artifactId },
      { kind: 'remove_clip', clip_id: after.clips[0]!.clipId, ripple: true },
    ])).rejects.toThrow('plan other edits separately')
    expect(engine.sequences.getPrimary()).toEqual(after)
  })

  it('applies an idempotent master soundtrack and atomic ordered appends', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-music-video-setup-'))
    const engine = createEngine({ durableWrites: false, rootDir, initialBookName: 'music-video-setup' })
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
      fit: 'source',
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
    const engine = createEngine({ durableWrites: false, rootDir, initialBookName: 'music-video-ripple' })
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
      fit: 'source',
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
    const engine = createEngine({ durableWrites: false, rootDir, initialBookName: 'music-video-locked' })
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

  it('fills remaining soundtrack time when appending music-video clips', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-music-video-fill-'))
    const engine = createEngine({ durableWrites: false, rootDir, initialBookName: 'music-video-fill' })
    activeEngine = engine
    const first = await createTimedArtifact(engine, 'video', 'first', 90)
    const second = await createTimedArtifact(engine, 'video', 'second', 60)
    let sequence = engine.sequences.getPrimary()
    const track = sequence.tracks.find((candidate) => candidate.kind === 'video')!
    sequence = await commitPlan(engine, {
      kind: 'append_clips',
      track_id: track.trackId,
      artifact_ids: [first.artifactId, second.artifactId],
      timeline_limit_frame: 300,
    })
    const lane = sequence.clips
      .filter((clip) => clip.trackId === track.trackId)
      .sort((left, right) => left.timelineStartFrame - right.timelineStartFrame)
    expect(lane).toHaveLength(2)
    expect(lane[0]).toMatchObject({
      timelineStartFrame: 0,
      durationFrames: 150,
      source: { artifactId: first.artifactId },
      speed: { numerator: 3, denominator: 5 },
    })
    expect(lane[1]).toMatchObject({
      timelineStartFrame: 150,
      durationFrames: 150,
      source: { artifactId: second.artifactId },
      speed: { numerator: 2, denominator: 5 },
    })
  })

  it('rebalances a full music-video lane when more clips are added', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-music-video-rebalance-'))
    const engine = createEngine({ durableWrites: false, rootDir, initialBookName: 'music-video-rebalance' })
    activeEngine = engine
    const first = await createTimedArtifact(engine, 'video', 'first', 90)
    const second = await createTimedArtifact(engine, 'video', 'second', 60)
    let sequence = engine.sequences.getPrimary()
    const track = sequence.tracks.find((candidate) => candidate.kind === 'video')!
    sequence = await commitPlan(engine, {
      kind: 'append_clips',
      track_id: track.trackId,
      artifact_ids: [first.artifactId],
      timeline_limit_frame: 300,
    })
    expect(sequence.clips.find((clip) => clip.trackId === track.trackId)).toMatchObject({
      timelineStartFrame: 0,
      durationFrames: 300,
      speed: { numerator: 3, denominator: 10 },
    })
    sequence = await commitPlan(engine, {
      kind: 'append_clips',
      track_id: track.trackId,
      artifact_ids: [second.artifactId],
      timeline_limit_frame: 300,
    })
    const lane = sequence.clips
      .filter((clip) => clip.trackId === track.trackId)
      .sort((left, right) => left.timelineStartFrame - right.timelineStartFrame)
    expect(lane).toHaveLength(2)
    expect(lane[0]).toMatchObject({
      timelineStartFrame: 0,
      durationFrames: 150,
      source: { artifactId: first.artifactId },
      speed: { numerator: 3, denominator: 5 },
    })
    expect(lane[1]).toMatchObject({
      timelineStartFrame: 150,
      durationFrames: 150,
      source: { artifactId: second.artifactId },
      speed: { numerator: 2, denominator: 5 },
    })
  })

  it('rebalances an existing short clip when more sources are added', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-music-video-short-'))
    const engine = createEngine({ durableWrites: false, rootDir, initialBookName: 'music-video-short' })
    activeEngine = engine
    const first = await createTimedArtifact(engine, 'video', 'first', 90)
    const second = await createTimedArtifact(engine, 'video', 'second', 60)
    let sequence = engine.sequences.getPrimary()
    const track = sequence.tracks.find((candidate) => candidate.kind === 'video')!
    sequence = await commitPlan(engine, {
      kind: 'append_clips',
      track_id: track.trackId,
      artifact_ids: [first.artifactId],
      timeline_limit_frame: 300,
      fit: 'source',
    })
    expect(sequence.clips.find((clip) => clip.trackId === track.trackId)?.durationFrames)
      .toBe(90)
    sequence = await commitPlan(engine, {
      kind: 'append_clips',
      track_id: track.trackId,
      artifact_ids: [second.artifactId],
      timeline_limit_frame: 300,
    })
    const lane = sequence.clips
      .filter((clip) => clip.trackId === track.trackId)
      .sort((left, right) => left.timelineStartFrame - right.timelineStartFrame)
    expect(lane).toHaveLength(2)
    expect(lane[0]).toMatchObject({
      timelineStartFrame: 0,
      durationFrames: 150,
      source: { artifactId: first.artifactId },
      speed: { numerator: 3, denominator: 5 },
    })
    expect(lane[1]).toMatchObject({
      timelineStartFrame: 150,
      durationFrames: 150,
      source: { artifactId: second.artifactId },
      speed: { numerator: 2, denominator: 5 },
    })
  })
  async function draftFixture() {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-music-draft-'))
    const engine = createEngine({ durableWrites: false, rootDir, initialBookName: 'music-draft' })
    activeEngine = engine
    const audio = await createTimedArtifact(engine, 'audio', 'song', 480_000)
    const video = await createTimedArtifact(engine, 'video', 'portrait', 90)
    const video2 = await createTimedArtifact(engine, 'video', 'landscape', 180)
    let sequence = engine.sequences.getPrimary()
    const videoTrack = sequence.tracks.find((track) => track.kind === 'video')!
    const audioTrack = sequence.tracks.find((track) => track.kind === 'audio')!
    sequence = await commitPlan(engine, { kind: 'append', artifact_id: audio.artifactId, track_id: audioTrack.trackId })
    const master = sequence.clips.find((clip) => clip.trackId === audioTrack.trackId)!
    const rhythm = await updateSequenceRhythm(engine, sequence.sequenceId, 'none', {
      masterClipId: master.clipId, correction: { objectHash: audio.stream.objectHash, analysisId: null, bpm: 120, beatsPerBar: 4,
        markers: Array.from({ length: 20 }, (_, index) => ({ id: `beat-${index}`, timeSeconds: index / 2, bar: index % 4 === 0, manual: true })) },
    })
    const options: MusicDraftOptions = { track_id: videoTrack.trackId, start_frame: 0, end_frame: 300,
      sources: [{ artifact_id: video.artifactId }, { artifact_id: video2.artifactId }], interval: 4, unit: 'beats',
      minimum_shot_frames: 8, preserve_existing: true, preserve_clip_ids: [], reuse_sources: false, allow_retiming: false,
      strategy: 'beat_interval' }
    const make = (overrides: Partial<MusicDraftOptions> = {}) => planMusicVideo(engine, { ...options, ...overrides }, engine.sequences.getPrimary().revision, rhythm.revision, 'draft-test', 'ui')
    return { engine, video, video2, master, videoTrack, rhythm, options, make }
  }

  it('previews deterministic drafts without mutation, exposes uncovered spans, and applies one idempotent undoable edit', async () => {
    const { engine, master, make } = await draftFixture()
    const before = engine.sequences.getPrimary()
    const incomplete = await make()
    expect(incomplete.uncovered).not.toHaveLength(0)
    expect(incomplete.shots.every((shot) => shot.speed === 1)).toBe(true)
    const draft = await make({ reuse_sources: true })
    expect(draft.uncovered).toEqual([])
    expect(draft.shots.map((shot) => shot.startFrame)).toEqual([0, 60, 120, 180, 240])
    expect((await make({ reuse_sources: true })).shots).toEqual(draft.shots)
    expect(engine.sequences.getPrimary()).toEqual(before)
    expect(draft.sequence.clips.find((clip) => clip.clipId === master.clipId)).toEqual(master)
    expect(draft.sequence.clips.filter((clip) => clip.trackId !== master.trackId).every((clip) => clip.transform?.fit === 'fit')).toBe(true)
    const intent = draft.plan.stages[0]!.intent
    const commit = await commitMusicVideo(engine, intent, draft.preview.previewHash, draft.rhythmRevision, draft.sequenceContentRevision)
    expect(commit.sequence.clips).toEqual(expect.arrayContaining(draft.sequence.clips))
    const retry = await commitMusicVideo(engine, intent, draft.preview.previewHash, draft.rhythmRevision, draft.sequenceContentRevision)
    expect(retry.actionId).toBe(commit.actionId)
    expect(retry.sequence.clips).toHaveLength(6)
    const restored = await engine.edits.restore({ targetRevision: intent.baseRevision, baseRevision: engine.head, actor: 'test', sourceSurface: 'ui' })
    if (!restored.ok) throw new Error(restored.error.message)
    expect(restored.value.sequence.clips).toEqual(before.clips)
  })

  it('preserves boundary clips, handles source limits and rejects stale beat maps and locked tracks', async () => {
    const { engine, master, make, video, videoTrack, rhythm, options } = await draftFixture()
    const first = await commitPlan(engine, { kind: 'append_clips', track_id: videoTrack.trackId, artifact_ids: [video.artifactId], timeline_limit_frame: 300, fit: 'source', visual_fit: 'fit' })
    expect(first.clips.find((clip) => clip.trackId === videoTrack.trackId)).toMatchObject({ durationFrames: 90, speed: { numerator: 1, denominator: 1 }, transform: { fit: 'fit' } })
    const boundary = await make({ start_frame: 60, preserve_existing: false, reuse_sources: true })
    expect(boundary.shots[0]!.startFrame).toBe(90)
    expect(boundary.sequence.clips.find((clip) => clip.trackId === videoTrack.trackId && clip.timelineStartFrame === 0)).toEqual(first.clips.find((clip) => clip.trackId === videoTrack.trackId))
    expect(boundary.sequence.clips.find((clip) => clip.clipId === master.clipId)).toEqual(master)
    const protectedDraft = await make({ preserve_existing: false, preserve_clip_ids: [first.clips.find((clip) => clip.trackId === videoTrack.trackId)!.clipId], reuse_sources: true })
    expect(protectedDraft.shots[0]!.startFrame).toBe(90)
    const short = await make({ sources: [{ artifact_id: video.artifactId, start_seconds: 1, end_seconds: 2 }], interval: 1, reuse_sources: true })
    expect(short.shots.every((shot) => shot.sourceStartSeconds >= 1 && shot.sourceEndSeconds <= 2)).toBe(true)
    const retimed = await make({ start_frame: 90, end_frame: 300, interval: 8, sources: [{ artifact_id: video.artifactId }], allow_retiming: true, reuse_sources: true })
    expect(retimed.shots.some((shot) => shot.speed !== 1)).toBe(true)
    const current = await readSequenceRhythm(engine, first.sequenceId)
    await updateSequenceRhythm(engine, first.sequenceId, current.revision, { ...current.settings, correction: { ...current.settings.correction!, bpm: 121 } })
    await expect(commitMusicVideo(engine, boundary.plan.stages[0]!.intent, boundary.preview.previewHash, boundary.rhythmRevision, boundary.sequenceContentRevision)).rejects.toThrow('beat map changed')
    await expect(planMusicVideo(engine, options, engine.head, rhythm.revision, 'test', 'ui')).rejects.toThrow('beat map changed')
    const latest = await readSequenceRhythm(engine, first.sequenceId)
    expect((await engine.sequences.updateTrack(videoTrack.trackId, { locked: true })).ok).toBe(true)
    await expect(planMusicVideo(engine, options, engine.head, latest.revision, 'test', 'ui')).rejects.toThrow('unlocked video track')
  })

})
