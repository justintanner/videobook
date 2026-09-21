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
    expect(firstBook.value.engine.sequences.getPrimary().tracks.filter((track) => track.kind === 'audio')).toHaveLength(1)
    expect(secondBook.value.engine.sequences.getPrimary().tracks.filter((track) => track.kind === 'audio')).toHaveLength(1)

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

    let settled = false
    const deletion = books.delete(created.value.bookId, { confirmName: 'discard-me' })
      .finally(() => { settled = true })
    while (!settled) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(() => books.list()).not.toThrow()
    }
    const deleted = await deletion
    expect(deleted.ok).toBe(true)
    await expect(access(managed.value.rootDir)).rejects.toThrow()
    expect(books.get(created.value.bookId).ok).toBe(false)
  })

  it('reopens a persisted book from the library after close', async () => {
    const created = await books.create('restart-recovery')
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const bookId = created.value.bookId
    const managed = books.get(bookId)
    if (!managed.ok) throw new Error(managed.error.message)
    const primary = managed.value.engine.sequences.getPrimary()
    const added = await managed.value.engine.sequences.addTrack(primary.sequenceId, { kind: 'audio', name: 'Ambience' })
    if (!added.ok) throw new Error(added.error.message)
    const savedTracks = added.value.tracks

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
    expect(reopened.value.engine.sequences.getPrimary().tracks).toEqual(savedTracks)
  })

  it('reserves duplicate names before concurrent creates publish any roots', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => books.create(index % 2 ? ' Shared book ' : 'SHARED BOOK')))
    const winners = results.filter((result) => result.ok)
    expect(winners).toHaveLength(1)
    for (const result of results) {
      if (!result.ok) expect(result.error.code).toBe('ALREADY_EXISTS')
    }
    const ids = books.list().map((book) => book.bookId)
    await books.close()
    expect(await books.discover()).toEqual(ids)
    await books.ready()
    expect(books.list().map((book) => book.bookId)).toEqual(ids)
  })

  it.each(['create', 'rename'] as const)('reserves names across create and rename when %s starts first', async (firstOperation) => {
    const existing = await books.create('Existing book')
    expect(existing.ok).toBe(true)
    if (!existing.ok) return
    const create = () => books.create('Shared target')
    const rename = () => books.rename(existing.value.bookId, ' SHARED TARGET ')
    const operations = firstOperation === 'create' ? [create, rename] : [rename, create]
    const results = await Promise.all(operations.map((operation) => operation()))
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results[0]!.ok).toBe(true)
    const loser = results[1]!
    if (!loser.ok) expect(loser.error.code).toBe('ALREADY_EXISTS')
    const expected = books.list().map((book) => ({ bookId: book.bookId, name: book.name }))
    await books.close()
    await books.ready()
    expect(books.list().map((book) => ({ bookId: book.bookId, name: book.name }))).toEqual(expected)
    expect(expected.filter((book) => book.name === 'shared-target')).toHaveLength(1)
  })

  it('normalizes project names before creation, rename, and collision checks', async () => {
    const created = await books.create('  My Café__Project!  ')
    expect(created).toMatchObject({ ok: true, value: { name: 'my-cafe-project' } })
    if (!created.ok) return
    expect(books.getByName('MY CAFÉ PROJECT')).toMatchObject({ ok: true, value: { bookId: created.value.bookId } })
    expect(await books.create('my-cafe---project')).toMatchObject({ ok: false, error: { code: 'ALREADY_EXISTS' } })
    const other = await books.create('Other project')
    if (!other.ok) throw new Error(other.error.message)
    expect(await books.rename(other.value.bookId, 'My Café Project')).toMatchObject({ ok: false, error: { code: 'ALREADY_EXISTS' } })
    for (const name of ['', '  ', '---___!!!', '猫🐈']) {
      expect(await books.create(name)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
      expect(await books.rename(created.value.bookId, name)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    }
    expect(books.list()).toHaveLength(2)
    const renamed = await books.rename(created.value.bookId, '  RENAMED__Story 2! ')
    expect(renamed).toMatchObject({ ok: true, value: { bookId: created.value.bookId, name: 'renamed-story-2' } })
    await books.close()
    await books.ready()
    expect(books.get(created.value.bookId)).toMatchObject({ ok: true, value: { name: 'renamed-story-2' } })
  })

  it('converts existing names without taking existing slugs or changing media identities', async () => {
    const originalNames = ['My Project', 'MY__Project', 'my-project', 'my-project-2', '猫🐈', 'project']
    const entries = []
    for (let index = 0; index < originalNames.length; index++) {
      const created = await books.create(`fixture-${index}`)
      if (!created.ok) throw new Error(created.error.message)
      const book = books.get(created.value.bookId)
      if (!book.ok) throw new Error(book.error.message)
      entries.push(book.value)
    }
    const first = entries[0]!
    const image = await first.engine.artifacts.create('image', 'Free text image label')
    if (!image.ok) throw new Error(image.error.message)
    expect((await first.engine.files.write(image.value.artifactId, 'original.png', Buffer.from('preserved media'))).ok).toBe(true)
    const notebookIds = entries.map((book) => book.engine.notebooks.list()[0]!.id)
    await books.close()
    for (const [index, book] of entries.entries()) {
      const catalog = new DatabaseSync(join(book.rootDir, 'data', 'videobook.db'))
      try {
        catalog.prepare('UPDATE book SET name=?').run(originalNames[index]!)
        catalog.prepare("SELECT dolt_add('book')").get()
        catalog.prepare("SELECT dolt_commit('-m', 'Legacy free-text project name')").get()
      } finally { catalog.close() }
    }
    const ensured = await books.ensure(first.bookId)
    expect(ensured).toMatchObject({ ok: true, value: { name: 'my-project-3' } })
    const expectedNames = ['my-project-3', 'my-project-4', 'my-project', 'my-project-2', 'project-2', 'project']
    const revisions = []
    for (const [index, entry] of entries.entries()) {
      const book = books.get(entry.bookId)
      if (!book.ok) throw new Error(book.error.message)
      expect(book.value.name).toBe(expectedNames[index])
      expect(book.value.engine.book.get()).toMatchObject({ bookId: entry.bookId, name: expectedNames[index], createdAt: entry.createdAt })
      expect(book.value.engine.notebooks.list()[0]!.id).toBe(notebookIds[index])
      revisions.push(book.value.engine.history.revisions())
    }
    if (!ensured.ok) throw new Error(ensured.error.message)
    const read = await ensured.value.engine.files.read(image.value.artifactId, 'original.png')
    expect(read).toMatchObject({ ok: true, value: Buffer.from('preserved media') })
    expect(ensured.value.engine.artifacts.get(image.value.artifactId)).toMatchObject({ ok: true, value: { label: 'Free text image label' } })
    await books.close()
    await books.ready()
    for (const [index, entry] of entries.entries()) {
      const book = books.get(entry.bookId)
      if (!book.ok) throw new Error(book.error.message)
      expect(book.value.name).toBe(expectedNames[index])
      expect(book.value.engine.history.revisions()).toEqual(revisions[index])
    }
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
    catalog.prepare('UPDATE engine_schema SET version=21 WHERE singleton=1').run()
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

  it('discovers multiple book roots without opening every catalog', async () => {
    const first = await books.create('alpha-open')
    const second = await books.create('beta-wait')
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    const firstId = first.value.bookId
    const secondId = second.value.bookId
    await books.close()

    const next = new BookManager({
      libraryDir: join(rootDir, 'books'),
      objectPrefix: 'test-objects',
    })
    const ids = await next.discover()
    expect(ids).toEqual(expect.arrayContaining([firstId, secondId]))
    expect(next.get(firstId).ok).toBe(false)
    expect(next.get(secondId).ok).toBe(false)
    expect(next.list()).toEqual([])

    const opened = await next.ensure(firstId)
    expect(opened.ok).toBe(true)
    if (!opened.ok) {
      await next.close()
      return
    }
    expect(opened.value.engine.book.get().name).toBe('alpha-open')
    expect(next.get(firstId).ok).toBe(true)
    expect(next.get(secondId).ok).toBe(false)
    expect(next.list().map((book) => book.bookId)).toEqual([firstId])

    await next.ready()
    const secondBook = next.get(secondId)
    expect(secondBook.ok).toBe(true)
    if (!secondBook.ok) {
      await next.close()
      return
    }
    expect(secondBook.value.engine.book.get().name).toBe('beta-wait')
    await next.close()
  })
})
