import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { v7 as uuidv7 } from 'uuid'
import { MVP_CONTRACT_VERSION, type EditIntent, type EditOperation, type Sequence, type SequenceClip } from 'videobook-engine'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FFMPEG, probeVideo } from '../../server/src/ffmpeg.js'
import { callTool, startServer, stopServer, type StartedServer } from './mcp-http-test-server.js'

const execFileAsync = promisify(execFile)

interface Job { type: string; state: string; result?: { artifactId: string } }
interface TimelineResult {
  render: string
  slots: Array<{ id: string; artifact_id: string }>
  audio: Array<{ id: string; artifact_id: string; start_frame: number; duration_frames: number; volume?: number; fadeIn?: number; fadeOut?: number }>
}

describe('timeline endpoints over HTTP MCP', () => {
  let rootDir: string
  let server: StartedServer | undefined
  let client: Client
  let bookId: string
  let fixtureId = 0

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-timeline-endpoints-'))
    server = await startServer(rootDir)
    client = new Client({ name: 'timeline-endpoints-e2e', version: '1' }, {
      capabilities: {}, supportedProtocolVersions: ['2026-07-28'],
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    })
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
    bookId = (await callTool<{ bookId: string }>(client, 'create_book', { name: 'Timeline fixture' })).bookId
  })

  afterEach(async () => {
    await client?.close()
    await stopServer(server)
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3 })
  })

  const call = <T>(name: string, args: Record<string, unknown> = {}) => callTool<T>(client, name, { book_id: bookId, ...args })
  const sequence = () => call<Sequence>('get_primary_sequence')
  const jobs = () => call<Job[]>('list_jobs')
  const idle = async () => {
    await expect.poll(async () => (await jobs()).every((job) => ['done', 'failed', 'aborted'].includes(job.state)), { timeout: 60_000 }).toBe(true)
    expect((await jobs()).filter((job) => job.state !== 'done')).toEqual([])
  }
  const upload = async (kind: 'video' | 'audio', duration = 4, frequency = 440) => {
    const filename = `${++fixtureId}.${kind === 'video' ? 'mp4' : 'wav'}`
    const path = join(rootDir, filename)
    await execFileAsync(FFMPEG, ['-y', '-f', 'lavfi', '-i',
      kind === 'video' ? `testsrc2=s=160x90:r=30:d=${duration}` : `sine=frequency=${frequency}:duration=${duration}`,
      ...(kind === 'video' ? ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'] : ['-c:a', 'pcm_s16le']), path])
    const result = await call<{ assetId: string; processingError?: string }>('upload_file', { filename, data: (await readFile(path)).toString('base64') })
    expect(result.processingError).toBeUndefined()
    await idle()
    return result.assetId
  }
  const edit = async (operations: EditOperation[]) => {
    const current = await sequence()
    const intent: EditIntent = {
      intentVersion: MVP_CONTRACT_VERSION, commandId: uuidv7(), sequenceId: current.sequenceId,
      baseRevision: current.revision, actor: 'timeline-e2e', sourceSurface: 'ui',
      confirmationPolicy: 'reversible-single-step', operations,
    }
    const preview = await call<{ valid: boolean; previewHash: string }>('preview_edit_intent', { intent })
    expect(preview.valid, JSON.stringify(preview)).toBe(true)
    await call('commit_edit_intent', { intent, preview_hash: preview.previewHash })
    return sequence()
  }
  const setup = async (slots = 1) => {
    const video = await upload('video')
    const audio = await upload('audio')
    const timeline = await call<TimelineResult>('set_timeline', { render: 'landscape',
      slots: Array.from({ length: slots }, () => ({ artifact_id: video })),
      audio: [{ artifact_id: audio, startFrame: 0, durationFrames: 60 }] })
    return { video, audio, audioId: timeline.audio[0]!.id }
  }
  const primaryClips = (current: Sequence) => current.clips.filter((clip) => clip.trackId === current.tracks.find((track) => track.kind === 'video')!.trackId)
  const trim = (clip: SequenceClip, startFrame = clip.timelineStartFrame): Extract<EditOperation, { kind: 'trim-clip' }> => {
    if (clip.source.kind !== 'timed') throw new Error('Expected a timed fixture')
    return { kind: 'trim-clip', clipId: clip.clipId, timelineStartFrame: startFrame, durationFrames: 60,
      sourceRange: { ...clip.source.range, startTick: clip.source.range.durationTicks / 4, durationTicks: clip.source.range.durationTicks / 2 } }
  }

  it('rejects missing source assets without changing the sequence canvas or revision', async () => {
    await setup()
    const before = await sequence()
    const rejected = await client.callTool({ name: 'set_timeline', arguments: { book_id: bookId, render: 'portrait', slots: [{ artifact_id: uuidv7() }] } })
    expect(rejected.isError).toBe(true)
    expect(await sequence()).toEqual(before)
  })

  it('preserves canonical transitions when the same timeline is written back', async () => {
    const { audioId } = await setup(2)
    const [first, second] = primaryClips(await sequence())
    await edit([{ kind: 'set-transition', outgoingClipId: first!.clipId, incomingClipId: second!.clipId,
      transition: { transitionId: uuidv7(), trackId: first!.trackId, outgoingClipId: first!.clipId, incomingClipId: second!.clipId,
        kind: 'dissolve', durationFrames: 10, alignment: 'center' } }])
    const before = await sequence()
    expect(before.transitions).toHaveLength(1)
    expect(before.clips.some((clip) => clip.clipId === audioId)).toBe(true)
    const timeline = await call<TimelineResult>('get_timeline')
    await call('set_timeline', { render: timeline.render, slots: timeline.slots,
      audio: timeline.audio.map(({ start_frame, duration_frames, ...clip }) => ({ ...clip, startFrame: start_frame, durationFrames: duration_frames })) })
    expect(await sequence()).toEqual(before)
  })

  it('reorders existing slots without losing their canonical source ranges', async () => {
    await setup(2)
    const original = primaryClips(await sequence())
    const before = await edit([trim(original[0]!), trim(original[1]!, 60)])
    await edit([{ kind: 'set-transition', outgoingClipId: original[0]!.clipId, incomingClipId: original[1]!.clipId,
      transition: { transitionId: uuidv7(), trackId: original[0]!.trackId, outgoingClipId: original[0]!.clipId, incomingClipId: original[1]!.clipId,
        kind: 'dissolve', durationFrames: 10, alignment: 'center' } }])
    const timeline = await call<TimelineResult>('get_timeline')
    await call('set_timeline', { render: timeline.render, slots: [...timeline.slots].reverse(),
      audio: timeline.audio.map(({ start_frame, duration_frames, ...clip }) => ({ ...clip, startFrame: start_frame, durationFrames: duration_frames })) })
    const after = primaryClips(await sequence()).sort((left, right) => left.timelineStartFrame - right.timelineStartFrame)
    expect(after).toEqual([...primaryClips(before)].reverse().map((clip, index) => ({ ...clip, timelineStartFrame: index * 60 })))
    expect((await sequence()).transitions).toEqual([])
  })

  it('rejects a clip ID belonging to an extra video track without changing that track', async () => {
    const { video } = await setup()
    const tracked = await call<Sequence>('add_sequence_track', { kind: 'video' })
    const clipId = uuidv7()
    const before = await edit([{ kind: 'insert-clip', clipId, mode: 'overwrite', placement: {
      trackId: tracked.tracks.filter((track) => track.kind === 'video').at(-1)!.trackId,
      timelineStartFrame: 0, durationFrames: 120, source: primaryClips(tracked)[0]!.source, audioPolicy: 'mute',
    } }])
    const result = await client.callTool({ name: 'set_timeline', arguments: { book_id: bookId, render: 'portrait', slots: [{ id: clipId, artifact_id: video }] } })
    expect(result.isError).toBe(true)
    expect(await sequence()).toEqual(before)
  })

  it('rejects duplicate clip IDs without leaving new lanes or a changed canvas', async () => {
    const { audio, audioId } = await setup()
    const before = await sequence()
    const rejected = await client.callTool({ name: 'set_timeline', arguments: {
      book_id: bookId, render: 'square', slots: [],
      audio: [0, 10].map((startFrame) => ({ id: audioId, artifact_id: audio, startFrame, durationFrames: 60 })),
    } })
    expect(rejected.isError).toBe(true)
    expect(await sequence()).toEqual(before)
  })

  it('exports full-length Timeline appends with original video sound and multiple audio tracks', async () => {
    const path = join(rootDir, 'video-with-sound.mp4')
    await execFileAsync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=30:d=1',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path])
    const video = await call<{ assetId: string }>('upload_file', { filename: 'video-with-sound.mp4', data: (await readFile(path)).toString('base64') })
    await idle()
    const audio = await upload('audio', 2, 880)
    const longAudio = await upload('audio', 3, 1320)
    await call('add_sequence_track', { kind: 'audio' })
    const current = await sequence()
    const mainTrack = current.tracks.find((track) => track.kind === 'video')!
    const audioTracks = current.tracks.filter((track) => track.kind === 'audio')
    for (const [trackId, artifactId] of [
      [mainTrack.trackId, video.assetId], [mainTrack.trackId, video.assetId],
      [audioTracks[0]!.trackId, audio], [audioTracks[1]!.trackId, longAudio],
    ]) {
      const planned = await call<{ stages: Array<{ intent: EditIntent }> }>('plan_sequence_edit', {
        source_surface: 'ui', actor: 'timeline-test', expected_revision: (await sequence()).revision,
        edits: [{ kind: 'append', track_id: trackId, artifact_id: artifactId }],
      })
      const intent = planned.stages[0]!.intent
      const preview = await call<{ valid: boolean; previewHash: string }>('preview_edit_intent', { intent })
      expect(preview.valid).toBe(true)
      await call('commit_edit_intent', { intent, preview_hash: preview.previewHash })
    }
    expect(primaryClips(await sequence()).map((clip) => clip.timelineStartFrame).sort((a, b) => a - b)).toEqual([0, 30])
    const settings = { sequence_revision: 'current', orientation: 'landscape', captions: 'omit' }
    const validation = await call<{ revision: string }>('validate_sequence_export', settings)
    await call('enqueue_sequence_export', { ...settings, sequence_revision: validation.revision, confirm: true })
    await idle()
    const output = (await jobs()).find((job) => job.type === 'export_sequence')!.result!.artifactId
    const response = await fetch(`${server!.url.replace('/mcp', '')}/files/${bookId}/${output}/original.mp4`)
    expect(response.status).toBe(200)
    const exported = join(rootDir, 'timeline-export.mp4')
    await writeFile(exported, Buffer.from(await response.arrayBuffer()))
    const probe = await probeVideo(exported)
    expect(probe.videoDuration).toBeCloseTo(3, 1)
    expect(probe.audioDuration).toBeCloseTo(3, 1)
    const signal = async (start: string) => (await execFileAsync(FFMPEG, ['-v', 'error', '-ss', start, '-i', exported,
      '-t', '0.5', '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1'], { encoding: 'buffer', maxBuffer: 2_000_000 })).stdout
    const amplitude = (pcm: Buffer, frequency: number) => {
      let real = 0
      let imaginary = 0
      const samples = pcm.length / 4
      for (let index = 0; index < samples; index += 1) {
        const angle = 2 * Math.PI * frequency * index / 16000
        const sample = pcm.readFloatLE(index * 4)
        real += sample * Math.cos(angle)
        imaginary += sample * Math.sin(angle)
      }
      return 2 * Math.hypot(real, imaginary) / samples
    }
    const mixed = await signal('0.25')
    for (const frequency of [440, 880, 1320]) expect(amplitude(mixed, frequency)).toBeGreaterThan(0.004)
    const tail = await signal('2.25')
    expect(amplitude(tail, 1320)).toBeGreaterThan(0.004)
    expect(amplitude(tail, 440)).toBeLessThan(0.001)
    expect(amplitude(tail, 880)).toBeLessThan(0.001)
  })

  it('exports the trimmed duration after editing audio fades', async () => {
    const { audioId } = await setup()
    await edit([trim(primaryClips(await sequence())[0]!)])
    await edit([{ kind: 'set-clip-audio', clipId: audioId, audio: { gainDb: 20 * Math.log10(0.4), muted: false, fadeInFrames: 6, fadeOutFrames: 6 } }])
    const settings = { sequence_revision: 'current', orientation: 'landscape', captions: 'omit' }
    const validation = await call<{ revision: string }>('validate_sequence_export', settings)
    await call('enqueue_sequence_export', { ...settings, sequence_revision: validation.revision, confirm: true })
    await idle()
    const output = (await jobs()).find((job) => job.type === 'export_sequence')!.result!.artifactId
    const response = await fetch(`${server!.url.replace('/mcp', '')}/files/${bookId}/${output}/original.mp4`)
    expect(response.status).toBe(200)
    const path = join(rootDir, 'export.mp4')
    await writeFile(path, Buffer.from(await response.arrayBuffer()))
    const probe = await probeVideo(path)
    expect(probe.videoDuration).toBeCloseTo(2, 1)
    expect(probe.audioDuration).toBeCloseTo(2, 1)
  })
})
