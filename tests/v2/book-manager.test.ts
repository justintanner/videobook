import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from '@dolthub/doltlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

  it('requires a typed name confirmation before permanently deleting the book root', async () => {
    const created = await books.create('discard-me')
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const managed = books.get(created.value.bookId)
    expect(managed.ok).toBe(true)
    if (!managed.ok) return

    const rejected = await books.delete(created.value.bookId, { confirmName: 'wrong' })
    expect(rejected.ok).toBe(false)
    expect(books.get(created.value.bookId).ok).toBe(true)

    const deleted = await books.delete(created.value.bookId, { confirmName: 'discard-me' })
    expect(deleted.ok).toBe(true)
    await expect(access(managed.value.rootDir)).rejects.toThrow()
    expect(books.get(created.value.bookId).ok).toBe(false)
  })

  it('reopens a persisted book from the library after close', async () => {
    const created = await books.create('restart-recovery')
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const bookId = created.value.bookId

    await books.close()
    books = new BookManager({
      libraryDir: join(rootDir, 'books'),
      objectPrefix: 'test-objects',
    })
    await books.ready()
    const reopened = books.get(bookId)
    expect(reopened.ok).toBe(true)
    if (!reopened.ok) return
    expect(reopened.value.engine.book.get().name).toBe('restart-recovery')
  })

  it('skips books whose catalog schema the engine no longer supports', async () => {
    const current = await books.create('current-schema')
    const stale = await books.create('stale-schema')
    expect(current.ok && stale.ok).toBe(true)
    if (!current.ok || !stale.ok) return
    const staleRoot = books.get(stale.value.bookId)
    expect(staleRoot.ok).toBe(true)
    if (!staleRoot.ok) return
    const catalogPath = join(staleRoot.value.rootDir, 'data', 'videobook.db')
    await books.close()

    const catalog = new DatabaseSync(catalogPath)
    catalog.prepare('UPDATE engine_schema SET version=22 WHERE singleton=1').run()
    catalog.close()

    books = new BookManager({
      libraryDir: join(rootDir, 'books'),
      objectPrefix: 'test-objects',
    })
    await books.ready()
    expect(books.get(stale.value.bookId).ok).toBe(false)
    const remaining = books.get(current.value.bookId)
    expect(remaining.ok).toBe(true)
    if (!remaining.ok) return
    expect(remaining.value.engine.book.get().name).toBe('current-schema')
  })
})
