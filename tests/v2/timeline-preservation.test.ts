import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import sharp from 'sharp'
import { createEngine, type Engine } from 'videobook-engine'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FFMPEG } from '../../server/src/ffmpeg.js'
import { readTimeline, timelineInput, writeTimeline } from '../../server/src/timeline-helpers.js'

const execFileAsync = promisify(execFile)

describe('canonical track settings through compatibility edits', () => {
  let rootDir: string
  let engine: Engine
  let imageId: string
  let audioId: string

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'timeline-preservation-'))
    engine = createEngine({ rootDir: join(rootDir, 'book'), initialBookName: 'Timeline preservation' })
    await engine.ready
    const image = await engine.artifacts.create('image', 'Still')
    const audio = await engine.artifacts.create('audio', 'Tone')
    if (!image.ok || !audio.ok) throw new Error('Fixture creation failed')
    imageId = image.value.artifactId
    audioId = audio.value.artifactId
    expect((await engine.files.write(imageId, 'original.png', await sharp({ create: { width: 16, height: 16, channels: 3, background: 'red' } }).png().toBuffer())).ok).toBe(true)
    const path = join(rootDir, 'tone.wav')
    await execFileAsync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'pcm_s16le', path])
    expect((await engine.files.write(audioId, 'original.wav', await readFile(path))).ok).toBe(true)
    expect((await writeTimeline(engine, { render: 'landscape', slots: [{ artifactId: imageId }],
      audio: [0, 90].map((startFrame) => ({ artifactId: audioId, startFrame, durationFrames: 60 })) })).ok).toBe(true)
  })

  afterEach(async () => {
    engine?.close()
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3 })
  })

  it.each([{ muted: true }, { solo: true }, { enabled: false }])('preserves audio routing when an overlap needs another lane: %s', async (settings) => {
    const original = engine.sequences.getPrimary()
    const track = original.tracks.find((item) => item.kind === 'audio')!
    expect((await engine.sequences.updateTrack(track.trackId, settings)).ok).toBe(true)
    const input = timelineInput(readTimeline(engine))
    input.audio![1]!.startFrame = 30
    expect(await writeTimeline(engine, input)).toMatchObject({ ok: true })
    const current = engine.sequences.getPrimary()
    for (const clip of current.clips.filter((item) => item.source.artifactId === audioId)) {
      expect(current.tracks.find((item) => item.trackId === clip.trackId)).toMatchObject(settings)
    }
  })

  it('leaves locked video tracks untouched while updating audio', async () => {
    const track = engine.sequences.getPrimary().tracks.find((item) => item.kind === 'video')!
    expect((await engine.sequences.updateTrack(track.trackId, { locked: true })).ok).toBe(true)
    const before = engine.sequences.getPrimary().clips.filter((clip) => clip.trackId === track.trackId)
    const input = timelineInput(readTimeline(engine))
    input.audio![0]!.volume = 40
    expect(await writeTimeline(engine, input)).toMatchObject({ ok: true })
    expect(engine.sequences.getPrimary().clips.filter((clip) => clip.trackId === track.trackId)).toEqual(before)
  })

  it('rejects locked video edits before adding audio lanes or changing orientation', async () => {
    const track = engine.sequences.getPrimary().tracks.find((item) => item.kind === 'video')!
    expect((await engine.sequences.updateTrack(track.trackId, { locked: true })).ok).toBe(true)
    const before = engine.sequences.getPrimary()
    const input = timelineInput(readTimeline(engine))
    input.render = 'portrait'
    input.slots = []
    input.audio![1]!.startFrame = 30
    expect(await writeTimeline(engine, input)).toMatchObject({ ok: false })
    expect(engine.sequences.getPrimary()).toEqual(before)
  })

  it('preserves a custom canvas during an audio-only update', async () => {
    expect((await engine.sequences.updateCanvas(engine.sequences.getPrimary().sequenceId, { width: 1280, height: 720 })).ok).toBe(true)
    const input = timelineInput(readTimeline(engine))
    input.audio![0]!.volume = 40
    expect(await writeTimeline(engine, input)).toMatchObject({ ok: true })
    expect(engine.sequences.getPrimary()).toMatchObject({ width: 1280, height: 720 })
  })
})
