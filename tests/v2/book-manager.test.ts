import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BookManager } from '../../server/src/book-manager.js'

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

    const artifact = await firstBook.value.engine.artifacts.create('image', 'moon garden')
    expect(artifact.ok).toBe(true)
    if (!artifact.ok) return
    expect((await firstBook.value.engine.files.write(
      artifact.value.artifactId,
      'original.png',
      Buffer.from('image bytes'),
    )).ok).toBe(true)

    const timeline = await firstBook.value.engine.timeline.set({
      render: 'portrait',
      slots: [{ artifactId: artifact.value.artifactId }],
    })
    expect(timeline.ok).toBe(true)
    if (!timeline.ok) return
    expect(timeline.value.render).toBe('portrait')
    expect(timeline.value.slots[0]?.artifactId).toBe(artifact.value.artifactId)
    expect(timeline.value.slots[0]?.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(secondBook.value.engine.artifacts.list()).toEqual([])
    expect(secondBook.value.engine.timeline.get().slots).toEqual([])
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
})
