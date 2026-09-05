import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from '@dolthub/doltlite'
import { v7 as uuidv7 } from 'uuid'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BookManager } from '../../server/src/book-manager.js'
import { notebookCellIsRunnable, prepareNotebookGeneration } from '../../server/src/jobs/run-notebook.js'
import { normalizeCellActionFields, selectedCellDetails, validateCellConfiguration } from '../../server/src/notebook-action-catalog.js'
import { findGenerateImageOutput, migrateStackedGenerationResults } from '../../server/src/notebook-cell-outputs.js'

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

  async function source(options: { generators?: boolean } = {}) {
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
    const promptId = uuidv7()
    const defaultImageId = uuidv7()
    const videoId = uuidv7()
    const unknownId = uuidv7()
    const connectedImageId = uuidv7()
    const edgeId = uuidv7()
    if (options.generators) {
      database.prepare("UPDATE cells SET type='image', model='generate_kie_gpt_image_2_text_to_image', inputs_json='{\"aspect_ratio\":\"1:1\"}' WHERE cell_id=?").run(cellId)
      database.prepare("INSERT INTO cells VALUES (?, ?, 'prompt', 'Context', 0, 0, NULL, 'In a quiet harbor', NULL, '{\"resolvedPrompt\":\"Unrelated cached value\"}', NULL)").run(notebookId, promptId)
      database.prepare("INSERT INTO cells VALUES (?, ?, 'image', 'Default image', 80, 40, NULL, 'A lighthouse', NULL, '{}', NULL)").run(notebookId, defaultImageId)
      database.prepare("INSERT INTO cells VALUES (?, ?, 'video', 'Default video', 120, 40, NULL, 'Gentle waves', NULL, '{}', NULL)").run(notebookId, videoId)
      database.prepare("INSERT INTO cells VALUES (?, ?, 'video', 'Custom video', 160, 40, NULL, 'A ship', 'custom-legacy-video-tool', '{}', NULL)").run(notebookId, unknownId)
      database.prepare("INSERT INTO cells VALUES (?, ?, 'image', 'Connected prompt only', 200, 40, NULL, NULL, NULL, '{}', NULL)").run(notebookId, connectedImageId)
      database.prepare("INSERT INTO edges VALUES (?, ?, ?, ?, 'prompt')").run(notebookId, edgeId, promptId, cellId)
      database.prepare("INSERT INTO edges VALUES (?, ?, ?, ?, 'prompt')").run(notebookId, uuidv7(), promptId, connectedImageId)
    }
    database.prepare("INSERT INTO timeline VALUES (?, 'square')").run(bookId)
    database.prepare('INSERT INTO timeline_slots VALUES (?, ?, 0, NULL, NULL, NULL)').run(uuidv7(), artifactId)
    database.prepare("SELECT dolt_add('.') AS result").get()
    database.prepare("SELECT dolt_commit('-m', 'Legacy fixture') AS hash").get()
    database.close()
    const catalog = join(data, 'videobook.db')
    await copyFile(writer, catalog)
    await rm(writer, { force: true })
    return { bookId, notebookId, cellId, artifactId, root, catalog, image, hash, promptId, defaultImageId, videoId, unknownId, connectedImageId, edgeId }
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

  it('keeps migrated generators executable, prepares the original prompts and adopts existing results without submitting jobs', async () => {
    const legacy = await source({ generators: true })
    const before = await readFile(legacy.catalog)
    await books.ready()
    const preview = books.listLegacy()[0]!
    const migrated = await books.migrateLegacy(legacy.bookId, preview.sourceHeadRevision)
    expect(migrated.ok, JSON.stringify(migrated)).toBe(true)
    if (!migrated.ok) return
    const managed = books.get(legacy.bookId)
    if (!managed.ok) throw new Error(managed.error.message)
    const engine = managed.value.engine
    const read = engine.notebooks.read(legacy.notebookId)
    if (!read.ok) throw new Error(read.error.message)
    const document = read.value
    const image = document.cells.find((cell) => cell.id === legacy.cellId)!
    const defaultImage = document.cells.find((cell) => cell.id === legacy.defaultImageId)!
    const video = document.cells.find((cell) => cell.id === legacy.videoId)!
    const unknown = document.cells.find((cell) => cell.id === legacy.unknownId)!
    const connectedImage = document.cells.find((cell) => cell.id === legacy.connectedImageId)!
    for (const generator of [image, defaultImage, video, unknown, connectedImage]) expect(notebookCellIsRunnable(generator)).toBe(true)
    expect(validateCellConfiguration(image, document).ok).toBe(true)
    const normalized = normalizeCellActionFields(image, document)
    expect(normalized).toMatchObject({ type: 'generate_image', provider: 'kie', operation: 'text_to_image', tool: 'generate_kie_gpt_image_2_text_to_image' })
    const prepared = await prepareNotebookGeneration(engine, document, normalized, legacy.bookId)
    expect(prepared).toMatchObject({ tool: 'generate_kie_gpt_image_2_text_to_image', input: { prompt: 'Blue square\n\nIn a quiet harbor', aspect_ratio: '1:1' } })
    const preparedDefault = await prepareNotebookGeneration(engine, document, defaultImage, legacy.bookId)
    expect(preparedDefault).toMatchObject({ tool: 'generate_kie_gpt_image_2_text_to_image', input: { prompt: 'A lighthouse' } })
    expect(await prepareNotebookGeneration(engine, document, connectedImage, legacy.bookId)).toMatchObject({
      tool: 'generate_kie_gpt_image_2_text_to_image', input: { prompt: 'In a quiet harbor' },
    })
    expect(video.tool).toBe('generate_kie_wan_2_7_text_to_video')
    expect(selectedCellDetails(legacy.notebookId, document, video.id)).toMatchObject({
      action: { tool: video.tool }, resolvedRequest: { tool: video.tool },
    })
    await expect(prepareNotebookGeneration(engine, document, video, legacy.bookId)).rejects.toThrow('Unknown notebook generation model: generate_kie_wan_2_7_text_to_video')
    expect(validateCellConfiguration(unknown, document).ok).toBe(false)
    expect(selectedCellDetails(legacy.notebookId, document, unknown.id)).toMatchObject({
      action: null, resolvedRequest: { tool: 'custom-legacy-video-tool' },
    })
    await expect(prepareNotebookGeneration(engine, document, unknown, legacy.bookId)).rejects.toThrow('Unknown notebook generation model: custom-legacy-video-tool')
    const adopted = migrateStackedGenerationResults(engine, document)
    const result = findGenerateImageOutput(adopted, image.id)
    expect(result?.outputCell).toMatchObject({ type: 'image', outputArtifactId: legacy.artifactId })
    expect(adopted.cells.find((cell) => cell.id === image.id)?.outputArtifactId).toBeUndefined()
    expect(adopted.edges).toEqual(expect.arrayContaining(document.edges))
    expect((await engine.notebooks.write(adopted)).ok).toBe(true)
    const persisted = engine.notebooks.read(legacy.notebookId)
    if (!persisted.ok) throw new Error(persisted.error.message)
    expect(findGenerateImageOutput(persisted.value, image.id)?.outputCell.outputArtifactId).toBe(legacy.artifactId)
    expect(migrateStackedGenerationResults(engine, persisted.value)).toEqual(persisted.value)
    expect(engine.jobs.queue.list()).toEqual([])
    expect(await readFile(join(migrated.value.legacyArchiveRoot, 'data', 'videobook.db'))).toEqual(before)
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
