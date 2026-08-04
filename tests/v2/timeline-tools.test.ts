import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BookManager } from '../../server/src/book-manager.js'
import { assignSlotDef } from '../../server/src/tools/assign-slot.js'
import { setTimelineDef } from '../../server/src/tools/edit-timeline.js'
import { getTimelineDef } from '../../server/src/tools/get-timeline.js'
import { removeTimelineSlotDef } from '../../server/src/tools/remove-timeline-slot.js'

function json(result: { content: Array<{ text: string }>; isError?: true }): unknown {
  expect(result.isError).toBeUndefined()
  return JSON.parse(result.content[0]!.text) as unknown
}

describe('v2 typed timeline tools', () => {
  let rootDir: string
  let books: BookManager

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-v2-timeline-'))
    books = new BookManager({ libraryDir: join(rootDir, 'books'), objectPrefix: 'test-objects' })
    await books.ready()
  })

  afterEach(async () => {
    await books.close()
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })

  it('stores only stable artifact UUID references and keeps slots dense', async () => {
    const created = await books.create('timeline')
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const managed = books.get(created.value.bookId)
    expect(managed.ok).toBe(true)
    if (!managed.ok) return
    const engine = managed.value.engine
    const image = await engine.artifacts.create('image', 'opening still')
    const video = await engine.artifacts.create('image', 'middle still')
    expect(image.ok && video.ok).toBe(true)
    if (!image.ok || !video.ok) return
    expect((await engine.files.write(
      image.value.artifactId,
      'original.png',
      Buffer.from('opening image'),
    )).ok).toBe(true)
    expect((await engine.files.write(
      video.value.artifactId,
      'original.png',
      Buffer.from('middle image'),
    )).ok).toBe(true)

    const set = setTimelineDef(engine)
    const initial = json(await set.handler({
      book_id: created.value.bookId,
      render: 'square',
      slots: [{ artifact_id: image.value.artifactId }],
    })) as { render: string; slots: Array<{ artifact_id: string; id: string }> }
    expect(initial.render).toBe('square')
    expect(initial.slots[0]?.artifact_id).toBe(image.value.artifactId)
    expect(initial.slots[0]?.id).toMatch(/^[0-9a-f-]{36}$/)

    const assigned = json(await assignSlotDef(engine).handler({
      book_id: created.value.bookId,
      asset_id: video.value.artifactId,
      slot: 's02',
    })) as { slots: Array<{ artifact_id: string }> }
    expect(assigned.slots.map((slot) => slot.artifact_id)).toEqual([
      image.value.artifactId,
      video.value.artifactId,
    ])

    const gap = await assignSlotDef(engine).handler({
      book_id: created.value.bookId,
      asset_id: image.value.artifactId,
      slot: 's04',
    })
    expect(gap.isError).toBe(true)

    const removed = json(await removeTimelineSlotDef(engine).handler({
      book_id: created.value.bookId,
      slot: 's01',
    })) as { slots: Array<{ artifact_id: string }> }
    expect(removed.slots).toEqual([{ artifact_id: video.value.artifactId, id: expect.any(String) }])

    const read = json(await getTimelineDef(engine).handler({ book_id: created.value.bookId })) as {
      slots: Array<{ artifact_id: string }>
    }
    expect(read.slots).toEqual([{ artifact_id: video.value.artifactId, id: expect.any(String) }])
  })

  it('compiles overlapping audio overlays onto canonical sequence tracks', async () => {
    const created = await books.create('timeline-audio')
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const managed = books.get(created.value.bookId)
    expect(managed.ok).toBe(true)
    if (!managed.ok) return
    const engine = managed.value.engine
    const audio = await engine.artifacts.create('audio', 'music bed')
    expect(audio.ok).toBe(true)
    if (!audio.ok) return
    expect((await engine.files.write(
      audio.value.artifactId,
      'original.wav',
      Buffer.from('audio bytes'),
    )).ok).toBe(true)
    const manifest = await engine.files.manifest(audio.value.artifactId)
    expect(manifest.ok).toBe(true)
    if (!manifest.ok) return
    const objectHash = manifest.value.files[0]?.objectHash
    expect(objectHash).toBeTruthy()
    if (!objectHash) return
    const stream = await engine.streams.register({
      artifactId: audio.value.artifactId,
      sourcePath: 'original.wav',
      objectHash,
      streamIndex: 0,
      kind: 'audio',
      timeBase: { numerator: 1, denominator: 48_000 },
      durationTicks: 96_000,
      codec: 'pcm_s16le',
      audio: {
        sampleRateHz: 48_000,
        channels: 2,
        channelLayout: 'stereo',
      },
    })
    expect(stream.ok).toBe(true)

    const result = json(await setTimelineDef(engine).handler({
      book_id: created.value.bookId,
      render: 'landscape',
      audio: [
        {
          artifact_id: audio.value.artifactId,
          startFrame: 0,
          durationFrames: 60,
          volume: 50,
          fadeIn: 500,
        },
        {
          artifact_id: audio.value.artifactId,
          startFrame: 30,
          durationFrames: 60,
        },
      ],
    })) as {
      audio: Array<{
        artifact_id: string
        volume?: number
        fadeIn?: number
      }>
    }
    expect(result.audio).toHaveLength(2)
    expect(result.audio[0]).toMatchObject({
      artifact_id: audio.value.artifactId,
      volume: 50,
      fadeIn: 500,
    })
    const sequence = engine.sequences.getPrimary()
    expect(sequence.clips).toHaveLength(2)
    expect(new Set(sequence.clips.map((clip) => clip.trackId)).size).toBe(2)
    expect(sequence.clips.every((clip) => clip.source.kind === 'timed')).toBe(true)
  })
})
