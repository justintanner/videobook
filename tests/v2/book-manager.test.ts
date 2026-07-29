import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MVP_SCHEMA_VERSION, SCHEMA_VERSION } from 'videobook-engine'
import { BookManager } from '../../server/src/book-manager.js'
import { readTimeline, writeTimeline } from '../../server/src/timeline-helpers.js'

describe('v2 book manager', () => {
  let rootDir: string
  let books: BookManager

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-v2-books-'))
    books = new BookManager({
      libraryDir: join(rootDir, 'books'),
      objectPrefix: 'test-objects',
    })
    await books.ready()
  })

  afterEach(async () => {
    await books.close()
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })

  it('creates isolated books with a Main notebook and stable typed timeline', async () => {
    const first = await books.create('first-story')
    const second = await books.create('second-story')

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) return

    const firstBook = books.get(first.value.bookId)
    const secondBook = books.get(second.value.bookId)
    expect(firstBook.ok).toBe(true)
    expect(secondBook.ok).toBe(true)
    if (!firstBook.ok || !secondBook.ok) return

    expect(firstBook.value.engine.notebooks.list().map((entry) => entry.name)).toEqual(['Main'])
    expect(secondBook.value.engine.notebooks.list().map((entry) => entry.name)).toEqual(['Main'])
    expect(SCHEMA_VERSION).toBe(MVP_SCHEMA_VERSION)
    const sequence = firstBook.value.engine.sequences.getPrimary()
    expect(sequence).toMatchObject({
      name: 'Main',
      width: 1920,
      height: 1080,
      frameRate: { numerator: 30, denominator: 1 },
      audioSampleRateHz: 48_000,
    })
    expect(sequence.tracks.filter((track) => track.kind === 'video')).toHaveLength(2)
    expect(sequence.tracks.filter((track) => track.kind === 'audio')).toHaveLength(4)
    expect(sequence.tracks.filter((track) => track.kind === 'caption')).toHaveLength(1)

    const artifact = await firstBook.value.engine.artifacts.create('image', 'moon garden')
    expect(artifact.ok).toBe(true)
    if (!artifact.ok) return
    expect((await firstBook.value.engine.files.write(
      artifact.value.artifactId,
      'original.png',
      Buffer.from('image bytes'),
    )).ok).toBe(true)

    const timeline = await writeTimeline(firstBook.value.engine, {
      render: 'portrait',
      slots: [{ artifactId: artifact.value.artifactId }],
    })
    expect(timeline.ok).toBe(true)
    if (!timeline.ok) return
    expect(timeline.value.render).toBe('portrait')
    expect(timeline.value.slots[0]?.artifactId).toBe(artifact.value.artifactId)
    expect(timeline.value.slots[0]?.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(secondBook.value.engine.artifacts.list()).toEqual([])
    expect(readTimeline(secondBook.value.engine).slots).toEqual([])
  })

  it('requires a typed slug confirmation before permanently deleting the book root', async () => {
    const created = await books.create('discard-me')
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const managed = books.get(created.value.bookId)
    expect(managed.ok).toBe(true)
    if (!managed.ok) return

    const rejected = await books.delete(created.value.bookId, { confirmSlug: 'wrong' })
    expect(rejected.ok).toBe(false)
    expect(books.get(created.value.bookId).ok).toBe(true)

    const deleted = await books.delete(created.value.bookId, { confirmSlug: 'discard-me' })
    expect(deleted.ok).toBe(true)
    await expect(access(managed.value.rootDir)).rejects.toThrow()
    expect(books.get(created.value.bookId).ok).toBe(false)
  })

  it('reconciles an expired running job after a server restart', async () => {
    const created = await books.create('restart-recovery')
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const managed = books.get(created.value.bookId)
    expect(managed.ok).toBe(true)
    if (!managed.ok) return
    const queued = [
      'process_upload',
      'semantic_index',
      'preview_render',
      'final_render',
    ].map((type) => managed.value.engine.jobs.queue.enqueue({
      type,
      payload: {
        type,
        bookId: created.value.bookId,
      },
      maxAttempts: 2,
    }))
    const leased = queued.map(() =>
      managed.value.engine.jobs.queue.dequeue(process.pid, -1))
    expect(leased.map((job) => job?.id)).toEqual(
      queued.map((result) => result.job.id),
    )
    expect(leased.every((job) => job?.state === 'running')).toBe(true)

    await books.close()
    books = new BookManager({
      libraryDir: join(rootDir, 'books'),
      objectPrefix: 'test-objects',
    })
    await books.ready()
    const reopened = books.get(created.value.bookId)
    expect(reopened.ok).toBe(true)
    if (!reopened.ok) return
    expect(reopened.value.engine.book.get().slug).toBe('restart-recovery')

    const recovery = await reopened.value.engine.jobs.queue.reap()
    expect(recovery).toEqual({ requeued: 4, failed: 0 })
    for (const result of queued) {
      expect(reopened.value.engine.jobs.queue.get(result.job.id)).toMatchObject({
        state: 'queued',
        attempts: 1,
        maxAttempts: 2,
      })
    }
  })
})
