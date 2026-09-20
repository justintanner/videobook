import { createServer } from 'node:http'
import { mkdtemp, rm, stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { MVP_CONTRACT_VERSION, type EditIntent, type Engine, type Result } from 'videobook-engine'
import { scopedBookEngine } from '../../server/src/book-context.js'
import { BookManager } from '../../server/src/book-manager.js'
import { contentStoreFromEnvironment } from '../../server/src/content-store.js'
import { searchLibraryAssets } from '../../server/src/media-library.js'
import { indexArtifact, registerSemanticIndexJob } from '../../server/src/jobs/semantic-index.js'
import { registerPrepareSearchReferenceJob } from '../../server/src/jobs/prepare-search-reference.js'
import { queue, setEngineRoot } from '../../server/src/queue.js'
import { semanticSearchDefs } from '../../server/src/tools/semantic-search.js'
import { searchReferenceStore } from '../../server/src/search-reference-store.js'
import { installLocalSearchProviderFixtures } from '../../server/src/local-search-models.js'

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

interface TransformersRuntime { env: { remoteHost: string } }
const runtime: TransformersRuntime = await import(new URL('./transformers-runtime.js', import.meta.resolve('videobook-engine')).href)

it.each(['direct-index', 'migration-index', 'semantic_index', 'prepare_search_reference', 'browse', 'ingest-status', 'retry-ingest', 'edit-history', 'library-moments'])(
  '%s does not hydrate missing media from the application object store', runWorkflow, 20_000,
)
it(
  'runs cached-model search, indexing, edits and history without model or object requests, then backs up explicitly',
  () => runWorkflow('cached'), 60_000,
)

async function runWorkflow(operation: string) {
  const root = await mkdtemp(join(tmpdir(), 'videobook-local-workflow-'))
  const keys = ['B2_ACCESS_KEY_ID', 'B2_SECRET_ACCESS_KEY', 'B2_REGION', 'B2_BUCKET', 'B2_ENDPOINT', 'VIDEOBOOK_MODEL_DOWNLOAD', 'VIDEOBOOK_MODEL_CACHE_DIR']
  const previous = new Map(keys.map((key) => [key, process.env[key]]))
  const requests: string[] = []
  const uploaded = new Map<string, Buffer>()
  const originalModelHost = runtime.env.remoteHost
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgYPgPAAEDAQBdlO9aAAAAAElFTkSuQmCC', 'base64')
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`)
    if (request.method === 'HEAD') {
      const stored = uploaded.get(request.url ?? '')
      if (stored) response.setHeader('Content-Length', stored.length)
      response.writeHead(stored ? 200 : 404).end()
      return
    }
    if (request.method === 'PUT') {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      request.on('end', () => {
        uploaded.set(request.url ?? '', Buffer.concat(chunks))
        response.setHeader('ETag', 'fixture')
        response.end()
      })
      return
    }
    response.setHeader('Content-Length', bytes.length)
    response.end(bytes)
  })
  let books: BookManager | undefined
  let referenceId: string | undefined
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No fixture address')
    process.env.B2_ACCESS_KEY_ID = 'fixture-access'
    process.env.B2_SECRET_ACCESS_KEY = 'fixture-secret'
    process.env.B2_REGION = 'us-west-004'
    process.env.B2_BUCKET = 'fixture-bucket'
    process.env.B2_ENDPOINT = `http://127.0.0.1:${address.port}`
    process.env.VIDEOBOOK_MODEL_DOWNLOAD = 'disabled'
    process.env.VIDEOBOOK_MODEL_CACHE_DIR = join(root, 'missing-models')
    runtime.env.remoteHost = `http://127.0.0.1:${address.port}/models/`
    const remoteObjects = contentStoreFromEnvironment()
    if (!remoteObjects) throw new Error('No remote adapter')
    const options = { libraryDir: join(root, 'books'), remoteObjects, objectPrefix: 'media' }
    books = new BookManager(options)
    const summary = value(await books.create('Local workflow'))
    let managed = value(books.get(summary.bookId))
    const kind = operation === 'migration-index' ? 'video' : 'image'
    const sourceName = kind === 'video' ? 'original.mp4' : 'original.png'
    const artifact = value(await managed.engine.artifacts.create(kind, 'Original'))
    const id = artifact.artifactId
    value(await managed.engine.files.write(id, sourceName, bytes))
    value(await managed.engine.metadata.artifacts.write(id, 'original', { width: 1, height: 1 }))
    const lease = managed.engine.jobs.artifactWork.begin(id, { kind: 'upload', ownerKind: 'job', durationMs: 60_000 })!
    expect(managed.engine.jobs.artifactWork.complete(id, lease.ownerId)).toBe(true)
    const manifest = value(await managed.engine.files.manifest(id))
    const hash = manifest.files[0]!.objectHash
    if (kind === 'video') value(await managed.engine.streams.register({
      artifactId: id, objectHash: hash, sourcePath: sourceName, streamIndex: 0, kind: 'video',
      timeBase: { numerator: 1, denominator: 1_000 }, durationTicks: 1_000, codec: 'h264',
      video: { width: 1, height: 1, rotationDegrees: 0, pixelAspect: { numerator: 1, denominator: 1 } },
    }))
    const cas = join(managed.rootDir, 'data', 'objects', 'sha256', hash.slice(0, 2), hash)
    value(await managed.engine.workspaces.evict(id))
    await books.close()
    if (operation !== 'cached') await unlink(cas)
    books = new BookManager(options)
    await books.ready()
    managed = value(books.get(summary.bookId))
    const engine = managed.engine
    const head = engine.head
    await setEngineRoot(managed.rootDir, engine)
    registerSemanticIndexJob(scopedBookEngine)
    registerPrepareSearchReferenceJob(scopedBookEngine)
    if (operation === 'cached') {
      installLocalSearchProviderFixtures(engine)
      expect(await queue.enqueueAndWait('offline-index', { type: 'semantic_index', assetId: id, bookId: summary.bookId }, 30_000)).toMatchObject({ semanticVisual: 'ready' })
      const descriptor = await queue.enqueueAndWait('offline-reference', {
        type: 'prepare_search_reference', assetId: id, bookId: summary.bookId, mediaKind: 'image', name: 'Reference',
      }, 30_000) as { reference_id: string }
      referenceId = descriptor.reference_id
      const prepared = searchReferenceStore.get(referenceId).reference
      expect((await engine.temporalSearch.prepare()).ok).toBe(true)
      expect(value(await engine.temporalSearch.queryPrepared({ modalities: ['visual'] }, prepared)).hits[0]?.artifactId).toBe(id)
      expect((await engine.temporalSearch.query({ text: 'a blue image', modalities: ['visual'] })).ok).toBe(true)
      const library = await searchLibraryAssets(books, { referenceId, kinds: ['image'] })
      expect(library.assets[0]?.artifact_id).toBe(id)
      expect(library.books_with_errors).toEqual([])
      await exerciseEdits(engine, id, hash, head)
      expect(requests).toEqual([])
      expect(value(await engine.files.read(id, sourceName))).toEqual(bytes)
      const beforeBackup = engine.head
      expect(value(await engine.storage.backup()).state).toBe('backed_up')
      expect(engine.head).toBe(beforeBackup)
      expect(requests.some((request) => request.startsWith('HEAD '))).toBe(true)
      expect(requests.some((request) => request.startsWith('PUT '))).toBe(true)
      expect(requests.some((request) => request.includes('/models/'))).toBe(false)
      return
    } else if (operation === 'edit-history') {
      await exerciseEdits(engine, id, hash, head)
      expect((await engine.temporalSearch.query({ text: 'Original', modalities: ['metadata'] })).ok).toBe(true)
    } else if (operation === 'direct-index') {
      await expect(indexArtifact(engine, id)).rejects.toMatchObject({ error: { code: 'MEDIA_MISSING' } })
    } else if (operation === 'semantic_index' || operation === 'prepare_search_reference' || operation === 'migration-index') {
      const type = operation === 'migration-index' ? 'semantic_index' : operation
      await expect(queue.enqueueAndWait('missing-media', {
        type, migration: operation === 'migration-index', assetId: id, bookId: summary.bookId, mediaKind: 'image', name: 'Reference',
      }, 10_000)).rejects.toThrow('not available locally')
      expect(engine.jobs.queue.list({ states: ['failed'] })).toEqual([
        expect.objectContaining({ type, artifactId: null, error: expect.objectContaining({ code: 'MEDIA_MISSING' }) }),
      ])
    } else if (operation === 'browse') {
      const result = await searchLibraryAssets(books, { kinds: ['image'] })
      expect(result.assets).toEqual([])
    } else {
      const name = operation === 'ingest-status' ? 'list_ingest_status' : operation === 'retry-ingest' ? 'retry_ingest' : 'search_library_moments'
      const tool = semanticSearchDefs(engine, books).find((entry) => entry.name === name)!
      referenceId = searchReferenceStore.put({ kind: 'image', name: 'Reference', reference: { kind: 'image', embeddingSpace: 'fixture', vector: [1, 0, 0] } }).reference_id
      const result = await tool.handler({ book_id: summary.bookId, artifact_id: id, reference_id: referenceId, query: { modalities: ['visual'] } })
      if (operation === 'retry-ingest') {
        expect(result.isError).toBe(true)
        expect(result.content[0]?.text).toContain('not available locally')
      } else expect(result.isError).toBeUndefined()
    }
    expect(requests).toEqual([])
    if (operation !== 'edit-history') expect(engine.head).toBe(head)
    expect(engine.jobs.artifactWork.read(id)).toMatchObject({ ok: true, value: { status: 'ready', ownerId: null } })
    await expect(stat(cas)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(manifest.path, sourceName))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(value(await engine.files.read(id, sourceName))).toEqual(bytes)
    expect(requests).toEqual([`GET /fixture-bucket/media/${hash.slice(0, 2)}/${hash}`])
  } finally {
    await queue.stop()
    runtime.env.remoteHost = originalModelHost
    if (referenceId) searchReferenceStore.release(referenceId)
    await books?.close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    for (const [key, entry] of previous) {
      if (entry === undefined) delete process.env[key]
      else process.env[key] = entry
    }
    await rm(root, { recursive: true, force: true, maxRetries: 3 })
  }
}

async function exerciseEdits(engine: Engine, id: string, hash: string, revision: string) {
  const sequence = engine.sequences.getPrimary()
  const track = sequence.tracks.find((entry) => entry.kind === 'video')!
  const intent: EditIntent = {
    intentVersion: MVP_CONTRACT_VERSION, commandId: 'offline-edit', sequenceId: sequence.sequenceId,
    baseRevision: sequence.revision, actor: 'test', sourceSurface: 'ui', confirmationPolicy: 'risk-based',
    operations: [{ kind: 'insert-clip', mode: 'overwrite', placement: {
      trackId: track.trackId, timelineStartFrame: 0, durationFrames: 30,
      source: { kind: 'still', artifactId: id, sourcePath: 'original.png', objectHash: hash },
      speed: { numerator: 1, denominator: 1 }, reverse: false, audioPolicy: 'preserve-pitch',
    } }],
  }
  const preview = value(engine.edits.preview(intent))
  const edit = value(await engine.edits.commit(intent, preview.previewHash))
  expect(edit.sequence.clips).toHaveLength(1)
  expect(engine.edits.get(edit.actionId).ok).toBe(true)
  expect((await engine.edits.restore({ targetActionId: edit.actionId, baseRevision: engine.head, actor: 'test', sourceSurface: 'ui' })).ok).toBe(true)
  expect((await engine.history.restoreArtifact(id, revision)).ok).toBe(true)
  expect((await engine.history.restore(revision)).ok).toBe(true)
  expect(engine.history.revisions().length).toBeGreaterThan(1)
}
