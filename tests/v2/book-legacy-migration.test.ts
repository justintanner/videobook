import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from '@dolthub/doltlite'
import { v7 as uuidv7 } from 'uuid'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BookManager } from '../../server/src/book-manager.js'
import { videobookDomainDefs } from '../../server/src/tools/videobook-domain.js'
import { scopedBookEngine } from '../../server/src/book-context.js'
import { notebookCellIsRunnable, prepareNotebookGeneration } from '../../server/src/jobs/run-notebook.js'
import { normalizeCellActionFields, selectedCellDetails, validateCellConfiguration } from '../../server/src/notebook-action-catalog.js'
import { findGenerateImageOutput, migrateStackedGenerationResults } from '../../server/src/notebook-cell-outputs.js'
import { runFfmpeg } from '../../server/src/ffmpeg.js'
import { prepareMigrationFrames } from '../../server/src/migration-media.js'
import { indexArtifact } from '../../server/src/jobs/semantic-index.js'

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

  async function source(options: { generators?: boolean; imageCount?: number; timed?: boolean } = {}) {
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
    const imageCount = options.imageCount ?? 1
    if (imageCount === 0) {
      for (const table of ['timeline_slots', 'cells', 'artifact_files', 'artifacts', 'objects']) database.exec(`DELETE FROM ${table}`)
    }
    for (let index = 1; index < imageCount; index++) {
      const id = uuidv7()
      database.prepare("INSERT INTO artifacts VALUES (?, ?, 'image', 1)").run(id, `Image ${index}`)
      database.prepare("INSERT INTO artifact_files VALUES (?, 'original.png', ?, 1, 1)").run(id, hash)
    }
    const timed: Array<{ id: string; kind: 'video' | 'audio'; name: string; bytes: Buffer; hash: string }> = []
    if (options.timed) {
      for (const kind of ['video', 'audio'] as const) {
        const id = uuidv7()
        const name = kind === 'video' ? 'original.mp4' : 'original.wav'
        const path = join(library, `.fixture-${name}`)
        await runFfmpeg(kind === 'video'
          ? ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=10', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path]
          : ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000', '-t', '2', '-c:a', 'pcm_s16le', path])
        const bytes = await readFile(path)
        await rm(path, { force: true })
        const mediaHash = createHash('sha256').update(bytes).digest('hex')
        const directory = join(data, 'objects', 'sha256', mediaHash.slice(0, 2))
        await mkdir(directory, { recursive: true })
        await writeFile(join(directory, mediaHash), bytes)
        database.prepare('INSERT INTO artifacts VALUES (?, ?, ?, 1)').run(id, `Legacy ${kind}`, kind)
        database.prepare('INSERT INTO objects VALUES (?, ?, 1)').run(mediaHash, bytes.length)
        database.prepare('INSERT INTO artifact_files VALUES (?, ?, ?, 1, 1)').run(id, name, mediaHash)
        timed.push({ id, kind, name, bytes, hash: mediaHash })
      }
    }
    database.prepare("SELECT dolt_add('.') AS result").get()
    database.prepare("SELECT dolt_commit('-m', 'Legacy fixture') AS hash").get()
    database.close()
    const catalog = join(data, 'videobook.db')
    await copyFile(writer, catalog)
    await rm(writer, { force: true })
    return { bookId, notebookId, cellId, artifactId, root, catalog, image, hash, promptId, defaultImageId, videoId, unknownId, connectedImageId, edgeId, timed }
  }

  async function waitForMigration(bookId: string, key: string, predicate: (status: Awaited<ReturnType<BookManager['legacyMigrationStatus']>>) => boolean) {
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      const status = await books.legacyMigrationStatus(bookId, key)
      if (predicate(status)) return status
      if (status.job?.state === 'failed') throw new Error(JSON.stringify(status.job.error))
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error('Migration did not reach the expected durable state')
  }

  it('registers off-timeline video and audio and recovers frames for current indexing without rewriting originals', async () => {
    const legacy = await source({ timed: true })
    const before = await readFile(legacy.catalog)
    await books.ready()
    const preview = books.listLegacy()[0]!
    await books.enqueueLegacyMigration(legacy.bookId, preview.sourceHeadRevision, preview.migrationKey)
    const completed = await waitForMigration(legacy.bookId, preview.migrationKey, (status) => status.phase === 'complete')
    const managed = books.get(legacy.bookId)
    if (!managed.ok) throw new Error(managed.error.message)
    const engine = managed.value.engine
    expect(completed.result!.reindexJobIds).toHaveLength(3)
    for (const media of legacy.timed) {
      expect(engine.streams.list(media.id)).toMatchObject({ ok: true, value: [expect.objectContaining({ kind: media.kind, objectHash: media.hash })] })
      await prepareMigrationFrames(engine, media.id)
      const first = await engine.files.manifest(media.id)
      if (!first.ok) throw new Error(first.error.message)
      const frames = first.value.files.filter((file) => file.name.startsWith('original_frames/'))
      expect(frames).toHaveLength(media.kind === 'video' ? 3 : 0)
      if (media.kind === 'video') {
        expect((await engine.files.delete(media.id, frames[1]!.name)).ok).toBe(true)
        await prepareMigrationFrames(engine, media.id)
      }
      await prepareMigrationFrames(engine, media.id)
      const repeated = await engine.files.manifest(media.id)
      if (!repeated.ok) throw new Error(repeated.error.message)
      expect(repeated.value.files.map(({ name, objectHash }) => ({ name, objectHash })))
        .toEqual(first.value.files.map(({ name, objectHash }) => ({ name, objectHash })))
      expect(await engine.files.read(media.id, media.name)).toMatchObject({ ok: true, value: media.bytes })
      expect(await indexArtifact(engine, media.id, { semanticVisual: false })).toMatchObject({
        success: true, artifactId: media.id, observationCount: media.kind === 'video' ? 3 : 1,
      })
      expect(await readFile(join(completed.result!.legacyArchiveRoot, 'data', 'objects', 'sha256', media.hash.slice(0, 2), media.hash))).toEqual(media.bytes)
    }
    expect((await readFile(join(completed.result!.legacyArchiveRoot, 'data', 'videobook.db'))).equals(before)).toBe(true)
    expect(engine.sequences.getPrimary().clips).toHaveLength(1)
    expect(engine.jobs.queue.list().every((job) => job.type === 'semantic_index')).toBe(true)
  })

  it.each([0, 1001])('queues exactly one current index job per media artifact in a %i-image legacy book', async (imageCount) => {
    const legacy = await source({ imageCount })
    const before = await readFile(legacy.catalog)
    await books.ready()
    const preview = books.listLegacy()[0]!
    await books.enqueueLegacyMigration(legacy.bookId, preview.sourceHeadRevision, preview.migrationKey)
    const completed = await waitForMigration(legacy.bookId, preview.migrationKey, (status) => status.phase === 'complete' && status.job?.state === 'done')
    const managed = books.get(legacy.bookId)
    if (!managed.ok) throw new Error(managed.error.message)
    const jobs = managed.value.engine.jobs.queue.list({ limit: 2000 })
    expect(jobs).toHaveLength(imageCount)
    expect(new Set(jobs.map((job) => job.externalTaskId)).size).toBe(imageCount)
    expect(jobs.every((job) => job.payload.bookId === legacy.bookId && job.type === 'semantic_index')).toBe(true)
    expect(completed.result!.reindexJobIds).toEqual(jobs.map((job) => job.id).sort((a, b) => a - b))
    expect(managed.value.engine.artifacts.list()).toHaveLength(imageCount + 1)
    await books.enqueueLegacyMigration(legacy.bookId, preview.sourceHeadRevision, preview.migrationKey)
    expect(managed.value.engine.jobs.queue.list({ limit: 2000 })).toHaveLength(imageCount)
    expect((await readFile(join(completed.result!.legacyArchiveRoot, 'data', 'videobook.db'))).equals(before)).toBe(true)
  }, 120_000)

  it('rejects missing source objects without publishing placeholders or modifying the source', async () => {
    const legacy = await source()
    await rm(join(legacy.root, 'data', 'objects', 'sha256', legacy.hash.slice(0, 2), legacy.hash), { force: true })
    const before = await readFile(legacy.catalog)
    await books.ready()
    const preview = books.listLegacy()[0]!
    const result = await books.migrateLegacy(legacy.bookId, preview.sourceHeadRevision)
    expect(result).toMatchObject({ ok: false, error: { code: 'OBJECT_UNAVAILABLE' } })
    expect(books.list()).toHaveLength(0)
    expect(books.listLegacy()).toHaveLength(1)
    expect((await readFile(legacy.catalog)).equals(before)).toBe(true)
    expect(await readdir(library)).not.toContain('.legacy-v4')
  })

  it('stops in-flight copying during shutdown and resumes the durable job after reopen', async () => {
    const legacy = await source()
    const before = await readFile(legacy.catalog)
    let release: () => void = () => {}
    const hold = new Promise<void>((resolve) => { release = resolve })
    let reached = false
    books = new BookManager({ libraryDir: library, onMigrationCheckpoint: async (phase) => {
      if (phase === 'copying') { reached = true; await hold }
    } })
    try {
      await books.ready()
      const preview = books.listLegacy()[0]!
      const queued = await books.enqueueLegacyMigration(legacy.bookId, preview.sourceHeadRevision, preview.migrationKey)
      await waitForMigration(legacy.bookId, preview.migrationKey, () => reached)
      const stopping = books.close()
      release()
      await stopping
      expect((await readFile(legacy.catalog)).equals(before)).toBe(true)
      books = new BookManager({ libraryDir: library })
      await books.ready()
      const completed = await waitForMigration(legacy.bookId, preview.migrationKey, (status) => status.phase === 'complete' && status.job?.state === 'done')
      expect(completed.job?.id).toBe(queued.job?.id)
      expect(completed.job?.attempts).toBeGreaterThan(1)
      expect((await readFile(join(completed.result!.legacyArchiveRoot, 'data', 'videobook.db'))).equals(before)).toBe(true)
    } finally { release() }
  })

  it('rechecks edits at the switch barrier and allows a newly confirmed migration after reopening', async () => {
    const legacy = await source()
    books = new BookManager({ libraryDir: library, onMigrationCheckpoint: async (phase) => {
      if (phase !== 'prepared') return
      const writer = join(library, '.late-edit-writer.db')
      await copyFile(legacy.catalog, writer)
      const database = new DatabaseSync(writer)
      database.prepare("UPDATE cells SET prompt='Edited immediately before switch'").run()
      database.close()
      await copyFile(writer, legacy.catalog)
      await rm(writer, { force: true })
    } })
    await books.ready()
    const preview = books.listLegacy()[0]!
    expect(await books.migrateLegacy(legacy.bookId, preview.sourceHeadRevision)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } })
    const before = await readFile(legacy.catalog)
    expect(books.list()).toHaveLength(0)
    expect((await books.legacyMigrationStatus(legacy.bookId, preview.migrationKey)).phase).toBe('copying')
    await books.close()
    books = new BookManager({ libraryDir: library })
    await books.ready()
    const refreshed = books.listLegacy()[0]!
    expect(refreshed.migrationKey).not.toBe(preview.migrationKey)
    const migrated = await books.migrateLegacy(legacy.bookId, refreshed.sourceHeadRevision)
    if (!migrated.ok) throw new Error(migrated.error.message)
    expect((await readFile(join(migrated.value.legacyArchiveRoot, 'data', 'videobook.db'))).equals(before)).toBe(true)
  })

  it('rejects cancellation once the durable switch barrier is crossed', async () => {
    const legacy = await source()
    let release: () => void = () => {}
    const hold = new Promise<void>((resolve) => { release = resolve })
    let reached = false
    books = new BookManager({ libraryDir: library, onMigrationCheckpoint: async (phase) => {
      if (phase === 'prepared') { reached = true; await hold }
    } })
    try {
      await books.ready()
      const preview = books.listLegacy()[0]!
      await books.enqueueLegacyMigration(legacy.bookId, preview.sourceHeadRevision, preview.migrationKey)
      const switching = await waitForMigration(legacy.bookId, preview.migrationKey, () => reached)
      expect(switching.phase).toBe('switching')
      await expect(books.cancelLegacyMigration(legacy.bookId, preview.migrationKey)).rejects.toThrow('cannot be cancelled')
      release()
      await waitForMigration(legacy.bookId, preview.migrationKey, (status) => status.phase === 'complete' && status.job?.state === 'done')
      expect(books.list()).toHaveLength(1)
    } finally { release() }
  })

  it('queues a confirmed migration through the tool and keeps status, archive links and index jobs across reopen', async () => {
    const legacy = await source()
    const before = await readFile(legacy.catalog)
    const published: string[] = []
    books = new BookManager({ libraryDir: library, onMigrationPublished: async (bookId) => { published.push(bookId) } })
    await books.ready()
    const preview = books.listLegacy()[0]!
    const defs = videobookDomainDefs(scopedBookEngine, books)
    const tool = defs.find((def) => def.name === 'migrate_legacy_book')!
    const args = { book_id: legacy.bookId, expected_source_head: preview.sourceHeadRevision, expected_migration_key: preview.migrationKey }
    const queued = await tool.handler(args)
    expect(queued.isError).not.toBe(true)
    const submitted = JSON.parse(queued.content[0]!.text)
    expect(submitted.job).toMatchObject({ type: 'migrate_legacy_book', payload: {
      bookId: legacy.bookId, sourceHead: preview.sourceHeadRevision, migrationKey: preview.migrationKey,
    } })
    const complete = await waitForMigration(legacy.bookId, preview.migrationKey, (status) => status.phase === 'complete' && status.job?.state === 'done')
    expect(complete.progress).not.toBeNull()
    expect(published).toEqual([legacy.bookId])
    expect(books.list()).toHaveLength(1)
    const result = complete.result!
    const managed = books.get(legacy.bookId)
    if (!managed.ok) throw new Error(managed.error.message)
    const jobs = managed.value.engine.jobs.queue.list()
    expect(jobs).toEqual([expect.objectContaining({ type: 'semantic_index', state: 'queued', artifactId: null,
      externalTaskId: `migration:${preview.migrationKey}:${legacy.artifactId}`,
      payload: { type: 'semantic_index', bookId: legacy.bookId, assetId: legacy.artifactId, migration: true } })])
    expect(result.reindexJobIds).toEqual(jobs.map((job) => job.id))
    expect(await managed.value.engine.metadata.book.read('legacySource')).toMatchObject({ ok: true, value: {
      bookId: legacy.bookId, sourceHeadRevision: preview.sourceHeadRevision, archiveRoot: result.legacyArchiveRoot,
    } })
    expect((await readFile(join(result.legacyArchiveRoot, 'data', 'videobook.db'))).equals(before)).toBe(true)
    expect(await books.enqueueLegacyMigration(legacy.bookId, preview.sourceHeadRevision, preview.migrationKey)).toEqual(complete)
    await books.close()
    books = new BookManager({ libraryDir: library })
    await books.ready()
    expect(await books.legacyMigrationStatus(legacy.bookId, preview.migrationKey)).toEqual(complete)
    const repeated = await books.enqueueLegacyMigration(legacy.bookId, preview.sourceHeadRevision, preview.migrationKey)
    expect(repeated.result).toEqual(result)
    expect(repeated.job?.id).toBe(submitted.job.id)
    expect(books.list()).toHaveLength(1)
  })

  it('deduplicates active confirmations and persists cancellation until an explicit retry', async () => {
    const legacy = await source()
    const before = await readFile(legacy.catalog)
    let release: () => void = () => {}
    const hold = new Promise<void>((resolve) => { release = resolve })
    let reached = false
    books = new BookManager({ libraryDir: library, onMigrationCheckpoint: async (phase) => {
      if (phase === 'copying') { reached = true; await hold }
    } })
    try {
      await books.ready()
      const preview = books.listLegacy()[0]!
      const first = await books.enqueueLegacyMigration(legacy.bookId, preview.sourceHeadRevision, preview.migrationKey)
      const duplicate = await books.enqueueLegacyMigration(legacy.bookId, preview.sourceHeadRevision, preview.migrationKey)
      expect(duplicate.job?.id).toBe(first.job?.id)
      await waitForMigration(legacy.bookId, preview.migrationKey, () => reached)
      const defs = videobookDomainDefs(scopedBookEngine, books)
      const cancel = await defs.find((def) => def.name === 'cancel_legacy_migration')!.handler({ book_id: legacy.bookId, migration_key: preview.migrationKey })
      expect(cancel.isError).not.toBe(true)
      expect(JSON.parse(cancel.content[0]!.text).job.state).toBe('aborted')
      release()
      await books.close()
      expect((await readFile(legacy.catalog)).equals(before)).toBe(true)
      books = new BookManager({ libraryDir: library })
      await books.ready()
      expect((await books.legacyMigrationStatus(legacy.bookId, preview.migrationKey)).job?.state).toBe('aborted')
      expect(books.listLegacy()).toHaveLength(1)
      const retry = await books.enqueueLegacyMigration(legacy.bookId, preview.sourceHeadRevision, preview.migrationKey)
      expect(retry.job?.id).not.toBe(first.job?.id)
      await waitForMigration(legacy.bookId, preview.migrationKey, (status) => status.phase === 'complete')
      expect(books.list()).toHaveLength(1)
    } finally { release() }
  })

  it.each(['copying', 'prepared', 'archived', 'published', 'indexed'])('recovers a killed migration at %s without losing the source or duplicating indexing', async (checkpoint) => {
    const legacy = await source()
    const before = await readFile(legacy.catalog)
    const script = `
      import { BookManager } from './server/src/book-manager.ts';
      const [libraryDir, checkpoint] = process.argv.slice(1);
      setTimeout(() => process.exit(94), 60000);
      const books = new BookManager({ libraryDir,
        onMigrationCheckpoint: (phase) => { if (phase === checkpoint) process.exit(93); } });
      await books.ready();
      const preview = books.listLegacy()[0];
      await books.enqueueLegacyMigration(preview.sourceBookId, preview.sourceHeadRevision, preview.migrationKey);
    `
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, library, checkpoint], {
      cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
    const exitCode = await new Promise<number | null>((resolve, reject) => { child.on('exit', resolve); child.on('error', reject) })
    expect(exitCode, output).toBe(93)
    books = new BookManager({ libraryDir: library })
    await books.ready()
    const { dryRunV4Migration } = await import('videobook-engine')
    const sourceRoot = books.listLegacy().length ? legacy.root
      : join(library, '.legacy-v4', (await readdir(join(library, '.legacy-v4')))[0]!)
    const preview = dryRunV4Migration(sourceRoot)
    if (!preview.ok) throw new Error(preview.error.message)
    const completed = await waitForMigration(legacy.bookId, preview.value.migrationKey, (status) => status.phase === 'complete' && status.job?.state === 'done')
    expect(completed.job?.attempts).toBeGreaterThan(1)
    const result = completed.result!
    expect((await readFile(join(result.legacyArchiveRoot, 'data', 'videobook.db'))).equals(before)).toBe(true)
    const managed = books.get(legacy.bookId)
    if (!managed.ok) throw new Error(managed.error.message)
    expect(managed.value.engine.artifacts.list()).toHaveLength(2)
    expect(managed.value.engine.sequences.getPrimary().clips).toHaveLength(1)
    expect(managed.value.engine.jobs.queue.list()).toHaveLength(1)
    expect((await books.enqueueLegacyMigration(legacy.bookId, preview.value.sourceHeadRevision, preview.value.migrationKey)).result).toEqual(result)
    expect(managed.value.engine.jobs.queue.list().map((job) => job.id)).toEqual(result.reindexJobIds)
    expect(books.list()).toHaveLength(1)
  }, 120_000)

  it.each(['archived', 'published'] as const)('safely retries an ordinary failure after %s', async (checkpoint) => {
    const legacy = await source()
    const before = await readFile(legacy.catalog)
    let fail = true
    books = new BookManager({ libraryDir: library, onMigrationCheckpoint: (phase) => {
      if (phase === checkpoint && fail) { fail = false; throw new Error('Injected switch failure') }
    } })
    await books.ready()
    const preview = books.listLegacy()[0]!
    const failed = await books.migrateLegacy(legacy.bookId, preview.sourceHeadRevision)
    expect(failed).toMatchObject({ ok: false, error: { message: 'Injected switch failure' } })
    if (checkpoint === 'archived') expect((await readFile(legacy.catalog)).equals(before)).toBe(true)
    const completed = await books.migrateLegacy(legacy.bookId, preview.sourceHeadRevision)
    expect(completed.ok, JSON.stringify(completed)).toBe(true)
    if (!completed.ok) return
    expect((await readFile(join(completed.value.legacyArchiveRoot, 'data', 'videobook.db'))).equals(before)).toBe(true)
    expect(books.list()).toHaveLength(1)
    const managed = books.get(legacy.bookId)
    if (!managed.ok) throw new Error(managed.error.message)
    expect(managed.value.engine.artifacts.list()).toHaveLength(2)
    expect(managed.value.engine.jobs.queue.list()).toHaveLength(1)
  })

  it('retains an unrelated archive directory and leaves the legacy source unchanged', async () => {
    const legacy = await source()
    const before = await readFile(legacy.catalog)
    await books.ready()
    const preview = books.listLegacy()[0]!
    const archive = join(library, '.legacy-v4', `${legacy.bookId}-${preview.migrationKey.slice(7)}`)
    await mkdir(archive, { recursive: true })
    await writeFile(join(archive, 'unrelated.txt'), 'Keep this directory')
    const failed = await books.migrateLegacy(legacy.bookId, preview.sourceHeadRevision)
    expect(failed.ok).toBe(false)
    expect((await readFile(legacy.catalog)).equals(before)).toBe(true)
    expect(await readFile(join(archive, 'unrelated.txt'), 'utf8')).toBe('Keep this directory')
    expect(books.listLegacy()).toHaveLength(1)
    expect(books.list()).toEqual([])
  })

  it('does not duplicate an index job completed before the migration receipt is finalized', async () => {
    const legacy = await source()
    let interrupted = false
    let indexId: number | undefined
    books = new BookManager({ libraryDir: library, onMigrationCheckpoint: async (phase) => {
      if (phase !== 'indexed' || interrupted) return
      interrupted = true
      const managed = books.get(legacy.bookId)
      if (!managed.ok) throw new Error(managed.error.message)
      const job = managed.value.engine.jobs.queue.dequeue(process.pid, 30_000)
      if (!job) throw new Error('Expected the scheduled index job')
      indexId = job.id
      await managed.value.engine.jobs.queue.complete(job.id, { result: { fixture: 'completed index boundary' } }, job.fence)
      throw new Error('Interrupted after index completion')
    } })
    await books.ready()
    const preview = books.listLegacy()[0]!
    expect((await books.migrateLegacy(legacy.bookId, preview.sourceHeadRevision)).ok).toBe(false)
    const repeated = await books.migrateLegacy(legacy.bookId, preview.sourceHeadRevision)
    expect(repeated.ok, JSON.stringify(repeated)).toBe(true)
    if (!repeated.ok) return
    expect(repeated.value.reindexJobIds).toEqual([indexId])
    const managed = books.get(legacy.bookId)
    if (!managed.ok) throw new Error(managed.error.message)
    expect(managed.value.engine.jobs.queue.list()).toEqual([expect.objectContaining({ id: indexId, state: 'done' })])
  })

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
    expect((await readFile(legacy.catalog)).equals(before)).toBe(true)
    expect((await readdir(legacy.root)).sort()).toEqual(['data'])
  })

  it('rejects a mismatched legacy directory identity without mutating its catalog', async () => {
    const legacy = await source()
    const before = await readFile(legacy.catalog)
    const wrongRoot = join(library, uuidv7())
    await rename(legacy.root, wrongRoot)
    await expect(books.ready()).rejects.toThrow('mismatched legacy book identity')
    expect(books.listLegacy()).toEqual([])
    expect((await readFile(join(wrongRoot, 'data', 'videobook.db'))).equals(before)).toBe(true)
  })

  it('keeps source bytes and media while switching a completed migration', async () => {
    const legacy = await source()
    const before = await readFile(legacy.catalog)
    await books.ready()
    const preview = books.listLegacy()[0]!
    const migrated = await books.migrateLegacy(legacy.bookId, preview.sourceHeadRevision)
    expect(migrated.ok, JSON.stringify(migrated)).toBe(true)
    if (!migrated.ok) return
    expect((await readFile(join(migrated.value.legacyArchiveRoot, 'data', 'videobook.db'))).equals(before)).toBe(true)
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
    expect((await readFile(legacy.catalog)).equals(before)).toBe(true)
    expect((await readdir(library)).sort()).toEqual([...entries, '.migration-runtime'].sort())
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
    expect(engine.jobs.queue.list()).toEqual([expect.objectContaining({
      type: 'semantic_index', payload: { type: 'semantic_index', bookId: legacy.bookId, assetId: legacy.artifactId, migration: true },
    })])
    expect((await readFile(join(migrated.value.legacyArchiveRoot, 'data', 'videobook.db'))).equals(before)).toBe(true)
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
    expect((await readFile(legacy.catalog)).equals(before)).toBe(true)
    expect((await readdir(library)).sort()).toEqual([...entries, '.migration-runtime'].sort())
    expect(books.get(legacy.bookId).ok).toBe(false)
  })
})
