import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from '@dolthub/doltlite'
import { v7 as uuidv7 } from 'uuid'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BookManager } from '../../server/src/book-manager.js'

const schema = await readFile(new URL('./fixtures/schema-v4.sql', import.meta.url), 'utf8')

describe('legacy book discovery and migration', () => {
  let library: string
  let books: BookManager

  beforeEach(async () => {
    library = await mkdtemp(join(tmpdir(), 'videobook-legacy-library-'))
    books = new BookManager({ libraryDir: library })
  })

  afterEach(async () => {
    await books.close()
    await rm(library, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })

  async function source() {
    const bookId = uuidv7()
    const notebookId = uuidv7()
    const cellId = uuidv7()
    const artifactId = uuidv7()
    const root = join(library, bookId)
    const data = join(root, 'data')
    await mkdir(data, { recursive: true })
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgYPgPAAEDAQBdlO9aAAAAAElFTkSuQmCC', 'base64')
    const hash = createHash('sha256').update(image).digest('hex')
    const objectDir = join(data, 'objects', 'sha256', hash.slice(0, 2))
    await mkdir(objectDir, { recursive: true })
    await writeFile(join(objectDir, hash), image)
    const writer = join(library, '.fixture-writer.db')
    const database = new DatabaseSync(writer)
    database.exec(schema)
    database.prepare('INSERT INTO engine_schema VALUES (1, 4, 1)').run()
    database.prepare("INSERT INTO book VALUES (?, 'legacy-story', 1)").run(bookId)
    database.prepare("INSERT INTO notebooks VALUES (?, 'Main', '{}', 1)").run(notebookId)
    database.prepare("INSERT INTO artifacts VALUES (?, 'blue-image', 'image', 1)").run(artifactId)
    database.prepare('INSERT INTO objects VALUES (?, ?, 1)').run(hash, image.length)
    database.prepare("INSERT INTO artifact_files VALUES (?, 'original.png', ?, 1, 1)").run(artifactId, hash)
    database.prepare("INSERT INTO cells VALUES (?, ?, 'asset', 'Image', 40, 40, NULL, 'Blue square', 'legacy-model', '{}', ?)")
      .run(notebookId, cellId, artifactId)
    database.prepare("INSERT INTO timeline VALUES (?, 'square')").run(bookId)
    database.prepare('INSERT INTO timeline_slots VALUES (?, ?, 0, NULL, NULL, NULL)').run(uuidv7(), artifactId)
    database.prepare("SELECT dolt_add('.') AS result").get()
    database.prepare("SELECT dolt_commit('-m', 'Legacy fixture') AS hash").get()
    database.close()
    const catalog = join(data, 'videobook.db')
    await copyFile(writer, catalog)
    await rm(writer, { force: true })
    return { bookId, notebookId, cellId, artifactId, root, catalog, image, hash }
  }

  it('discovers a real v4 catalog without opening or changing the source', async () => {
    const legacy = await source()
    const before = await readFile(legacy.catalog)
    expect(await books.discover()).toEqual([legacy.bookId])
    expect(books.listLegacy()).toEqual([])
    await books.ready()
    expect(books.get(legacy.bookId).ok).toBe(false)
    expect(books.list()).toEqual([])
    expect(books.listLegacy()).toEqual([expect.objectContaining({ sourceBookId: legacy.bookId, slug: 'legacy-story', artifactCount: 1, notebookCount: 1 })])
    await books.close()
    expect(await readFile(legacy.catalog)).toEqual(before)
    expect((await readdir(legacy.root)).sort()).toEqual(['data'])
  })

  it('rejects a mismatched legacy directory identity without mutating its catalog', async () => {
    const legacy = await source()
    const before = await readFile(legacy.catalog)
    const wrongRoot = join(library, uuidv7())
    await rename(legacy.root, wrongRoot)
    await expect(books.ready()).rejects.toThrow('mismatched legacy book identity')
    expect(books.listLegacy()).toEqual([])
    expect(await readFile(join(wrongRoot, 'data', 'videobook.db'))).toEqual(before)
  })

  it('keeps source bytes and media while switching a completed migration', async () => {
    const legacy = await source()
    const before = await readFile(legacy.catalog)
    await books.ready()
    const preview = books.listLegacy()[0]!
    const migrated = await books.migrateLegacy(legacy.bookId, preview.sourceHeadRevision)
    expect(migrated.ok, JSON.stringify(migrated)).toBe(true)
    if (!migrated.ok) return
    expect(await readFile(join(migrated.value.legacyArchiveRoot, 'data', 'videobook.db'))).toEqual(before)
    expect(await readFile(join(migrated.value.legacyArchiveRoot, 'data', 'objects', 'sha256', legacy.hash.slice(0, 2), legacy.hash))).toEqual(legacy.image)
    const managed = books.get(legacy.bookId)
    expect(managed.ok).toBe(true)
    if (!managed.ok) return
    const document = managed.value.engine.notebooks.read(legacy.notebookId)
    expect(document).toMatchObject({ ok: true, value: { cells: [{ id: legacy.cellId, type: 'image', label: 'Image', prompt: 'Blue square', model: 'legacy-model', outputArtifactId: legacy.artifactId }] } })
    expect(managed.value.engine.sequences.getPrimary().clips).toHaveLength(1)
    expect(books.listLegacy()).toEqual([])
    await books.close()
    books = new BookManager({ libraryDir: library })
    await books.ready()
    expect(books.list()).toHaveLength(1)
    expect(books.get(legacy.bookId).ok).toBe(true)
  })

  it('cancels before switching and permits a clean retry', async () => {
    const legacy = await source()
    const before = await readFile(legacy.catalog)
    await books.ready()
    const preview = books.listLegacy()[0]!
    const controller = new AbortController()
    const entries = (await readdir(library)).sort()
    const phases: string[] = []
    const cancelled = await books.migrateLegacy(legacy.bookId, preview.sourceHeadRevision, {
      signal: controller.signal,
      onProgress(progress) {
        phases.push(progress.phase)
        if (progress.phase === 'copy-objects') controller.abort()
      },
    })
    expect(cancelled).toMatchObject({ ok: false, error: { code: 'CANCELLED' } })
    expect(phases).toContain('copy-objects')
    expect(await readFile(legacy.catalog)).toEqual(before)
    expect((await readdir(library)).sort()).toEqual(entries)
    expect(books.listLegacy()).toHaveLength(1)
    expect((await books.migrateLegacy(legacy.bookId, preview.sourceHeadRevision)).ok).toBe(true)
  })

  it('detects uncommitted edits made after confirmation even when the head is unchanged', async () => {
    const legacy = await source()
    await books.ready()
    const preview = books.listLegacy()[0]!
    const writer = join(library, '.edit-writer.db')
    await copyFile(legacy.catalog, writer)
    const database = new DatabaseSync(writer)
    database.prepare("UPDATE cells SET prompt='Changed after confirmation'").run()
    database.close()
    await copyFile(writer, legacy.catalog)
    await rm(writer, { force: true })
    const before = await readFile(legacy.catalog)
    const entries = (await readdir(library)).sort()
    const rejected = await books.migrateLegacy(legacy.bookId, preview.sourceHeadRevision)
    expect(rejected).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } })
    expect(await readFile(legacy.catalog)).toEqual(before)
    expect((await readdir(library)).sort()).toEqual(entries)
    expect(books.get(legacy.bookId).ok).toBe(false)
  })
})
