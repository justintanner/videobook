import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { LOCAL_CLIP_MANIFEST, type Engine, type Result } from 'videobook-engine'
import { BookManager } from '../../server/src/book-manager.js'
import { scopedBookEngine } from '../../server/src/book-context.js'
import { searchLibraryAssets } from '../../server/src/media-library.js'
import { enqueueSearchIndex } from '../../server/src/jobs/enqueue-search-index.js'
import { registerRepairSearchIndexesJob, repairSearchIndexes as runRepair } from '../../server/src/jobs/repair-search-indexes.js'
import { queue, setEngineRoot } from '../../server/src/queue.js'
import { mediaLibraryDefs } from '../../server/src/tools/media-library.js'
import { videobookDomainDefs } from '../../server/src/tools/videobook-domain.js'
import { repairSearchIndexes } from '../../src/videobook/search-index-repair.js'
import { installLocalSearchProviderFixtures, registerLocalClipSearchProvider } from '../../server/src/local-search-models.js'
import { runFfmpeg } from '../../server/src/ffmpeg.js'

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgYPgPAAEDAQBdlO9aAAAAAElFTkSuQmCC', 'base64')
let root: string
let books: BookManager
let engine: Engine
let bookId: string
let bookRoot: string
const keys = ['VIDEOBOOK_MODEL_DOWNLOAD', 'VIDEOBOOK_MODEL_CACHE_DIR']
let previous: Array<string | undefined>
beforeEach(async () => {
  previous = keys.map((key) => process.env[key])
  root = await mkdtemp(join(tmpdir(), 'videobook-search-repair-'))
  process.env.VIDEOBOOK_MODEL_DOWNLOAD = 'disabled'
  process.env.VIDEOBOOK_MODEL_CACHE_DIR = join(root, 'missing-models')
  books = new BookManager({ libraryDir: join(root, 'books') })
  bookId = value(await books.create('Repair')).bookId
  const managed = value(books.get(bookId))
  engine = managed.engine
  bookRoot = managed.rootDir
})
afterEach(async () => {
  await queue.stop()
  await books.close()
  keys.forEach((key, index) => {
    if (previous[index] === undefined) delete process.env[key]
    else process.env[key] = previous[index]
  })
  await rm(root, { recursive: true, force: true, maxRetries: 3 })
})

async function source(kind: 'image' | 'video' = 'image', bytes = png) {
  const artifact = value(await engine.artifacts.create(kind, 'Repair source'))
  const id = artifact.artifactId
  value(await engine.files.write(id, kind === 'image' ? 'original.png' : 'original.mp4', bytes))
  value(await engine.metadata.artifacts.write(id, 'original', { width: 1, height: 1, duration: 1 }))
  const lease = engine.jobs.artifactWork.begin(id, { kind: 'upload', ownerKind: 'job', durationMs: 60_000 })!
  expect(engine.jobs.artifactWork.complete(id, lease.ownerId)).toBe(true)
  return id
}

async function startQueue() {
  await setEngineRoot(bookRoot, engine)
  registerRepairSearchIndexesJob(scopedBookEngine)
}

async function repair() {
  const tool = mediaLibraryDefs(books).find((entry) => entry.name === 'repair_library_search_indexes')!
  const list = videobookDomainDefs(engine, books).find((entry) => entry.name === 'list_jobs')!
  return repairSearchIndexes({
    start: async () => {
      const started = performance.now()
      const response = await tool.handler({ kinds: ['image', 'video'] })
      expect(performance.now() - started).toBeLessThan(2_000)
      expect(response.isError).toBeUndefined()
      return JSON.parse(response.content[0]!.text)
    },
    listJobs: async (id, ids) => {
      expect(id).toBe(bookId)
      const response = await list.handler({ book_id: id, job_ids: ids })
      return JSON.parse(response.content[0]!.text)
    },
    isCancelled: () => false, intervalMs: 10, timeoutMs: 60_000,
  })
}

it('counts missing current visual coverage, including zero-vector completed indexes', async () => {
  const id = await source()
  const hash = value(await engine.files.manifest(id)).files[0]!.objectHash
  expect((await searchLibraryAssets(books, { kinds: ['image'] })).unindexed_visual_assets).toBe(1)
  value(engine.temporalSearch.manifests.register(LOCAL_CLIP_MANIFEST))
  value(engine.temporalSearch.commitBatch({
    artifactId: id, objectHash: hash, manifestId: LOCAL_CLIP_MANIFEST.manifestId, generation: LOCAL_CLIP_MANIFEST.manifestId,
    phase: 'visual', maxUnits: 1, observations: [], coveredRanges: [], totalUnits: 0, complete: true,
  }))
  expect((await searchLibraryAssets(books, { kinds: ['image'] })).unindexed_visual_assets).toBe(1)
  expect((await searchLibraryAssets(books, { kinds: ['video'] })).unindexed_visual_assets).toBe(0)
})

it('deduplicates pending index jobs by source bytes and keeps indexing detached from media health', async () => {
  const id = await source()
  await enqueueSearchIndex(engine, id)
  await enqueueSearchIndex(engine, id)
  let jobs = engine.jobs.queue.list({ type: 'semantic_index' })
  expect(jobs).toHaveLength(1)
  expect(jobs[0]).toMatchObject({ artifactId: null, payload: { assetId: id, bookId, prepareVisualMedia: true } })
  value(await engine.files.write(id, 'original.png', Buffer.concat([png, Buffer.from('new-source')])))
  await enqueueSearchIndex(engine, id)
  jobs = engine.jobs.queue.list({ type: 'semantic_index' })
  expect(jobs).toHaveLength(2)
  expect(new Set(jobs.map((job) => job.id)).size).toBe(2)
  expect(value(engine.jobs.artifactWork.read(id))).toMatchObject({ status: 'ready', ownerId: null })
})

it('returns queued repair work promptly and reports missing models without failing ready media', async () => {
  const id = await source()
  await startQueue()
  const summary = await repair()
  expect(summary).toMatchObject({ indexed: 0, failed: 1 })
  expect(summary?.failures[0]?.message).toContain('prepare:search-models')
  expect(engine.jobs.queue.list({ type: 'repair_search_indexes' })).toEqual([
    expect.objectContaining({ artifactId: null, state: 'failed' }),
  ])
  expect(value(engine.jobs.artifactWork.read(id))).toMatchObject({ status: 'ready', ownerId: null })
  expect((await searchLibraryAssets(books, { kinds: ['image'] })).unindexed_visual_assets).toBe(1)
}, 20_000)

it('completes an empty repair without loading models', async () => {
  await startQueue()
  expect(await repair()).toEqual({ indexed: 0, failed: 0, failures: [] })
}, 20_000)

it('repairs images and frameless videos, continues past corrupt media, and skips repaired assets on retry', async () => {
  await startQueue()
  installLocalSearchProviderFixtures(engine)
  const imageId = await source()
  const imageHash = value(await engine.files.manifest(imageId)).files[0]!.objectHash
  value(engine.temporalSearch.manifests.register(LOCAL_CLIP_MANIFEST))
  value(engine.temporalSearch.commitBatch({
    artifactId: imageId, objectHash: imageHash, manifestId: LOCAL_CLIP_MANIFEST.manifestId, generation: LOCAL_CLIP_MANIFEST.manifestId,
    phase: 'visual', maxUnits: 1, cursor: '0', observations: [], coveredRanges: [], totalUnits: 0, complete: true,
  }))
  const brokenId = await source('image', Buffer.from('broken-image'))
  const videoPath = join(root, 'fixture.mp4')
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=10:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoPath])
  const videoId = await source('video', Buffer.from('previous-source'))
  const oldHash = value(await engine.files.manifest(videoId)).files[0]!.objectHash
  value(await engine.streams.register({
    artifactId: videoId, objectHash: oldHash, sourcePath: 'original.mp4', streamIndex: 0, kind: 'video',
    timeBase: { numerator: 1, denominator: 1_000 }, durationTicks: 1_000, codec: 'h264',
    video: { width: 64, height: 64, rotationDegrees: 0, pixelAspect: { numerator: 1, denominator: 1 } },
  }))
  value(await engine.files.write(videoId, 'original.mp4', await readFile(videoPath)))
  expect((await searchLibraryAssets(books, { kinds: ['image', 'video'] })).unindexed_visual_assets).toBe(3)
  const summary = await repair()
  expect(summary).toMatchObject({ indexed: 2, failed: 1 })
  expect(engine.jobs.queue.list({ type: 'repair_search_indexes' })[0]?.result).toMatchObject({ failures: [{ artifactId: brokenId }] })
  const after = await searchLibraryAssets(books, { kinds: ['image', 'video'] })
  expect(after.unindexed_visual_assets).toBe(1)
  expect(after.assets).toHaveLength(3)
  const provider = registerLocalClipSearchProvider(engine)
  const manifest = value(await engine.files.manifest(imageId))
  const vector = await provider.embedImage(join(manifest.path, 'original.png'))
  const found = value(await engine.temporalSearch.queryPrepared({ modalities: ['visual'], sourceArtifactIds: [imageId] }, {
    kind: 'image', embeddingSpace: provider.embeddingSpace, vector: [...vector],
  }))
  expect(found.hits[0]?.artifactId).toBe(imageId)
  const videoFiles = value(await engine.files.manifest(videoId)).files
  expect(videoFiles.some((file) => file.name.startsWith('original_frames/'))).toBe(true)
  const currentHash = videoFiles.find((file) => file.name === 'original.mp4')!.objectHash
  expect(value(engine.temporalSearch.plan(videoId, currentHash, LOCAL_CLIP_MANIFEST.manifestId, LOCAL_CLIP_MANIFEST.manifestId)).coverage).toEqual(expect.arrayContaining([
    expect.objectContaining({ phase: 'visual', state: 'ready', indexedUnits: expect.any(Number) }),
  ]))
  expect(value(engine.temporalSearch.coverage(videoId)).modalities).toEqual(expect.arrayContaining([
    expect.objectContaining({ modality: 'visual', state: 'ready', indexedUnits: expect.any(Number) }),
  ]))
  const counts = engine.catalogIntegrity().tableRowCounts
  expect(await repair()).toMatchObject({ indexed: 0, failed: 1 })
  expect(engine.catalogIntegrity().tableRowCounts.runtime_segment_embeddings).toBe(counts.runtime_segment_embeddings)
  for (const id of [imageId, videoId, brokenId]) expect(value(engine.jobs.artifactWork.read(id))).toMatchObject({ status: 'ready', ownerId: null })
}, 120_000)

it('honors cancellation before changing index coverage or media', async () => {
  const id = await source()
  const abort = new AbortController()
  abort.abort(new Error('Cancelled indexing'))
  await expect(runRepair(engine, ['image'], {
    jobId: 1,
    signal: abort.signal, setLease: () => undefined, getOwnerId: () => '', markAssetFailureHandled: () => undefined,
  })).rejects.toThrow('Cancelled indexing')
  expect((await searchLibraryAssets(books, { kinds: ['image'] })).unindexed_visual_assets).toBe(1)
  expect(value(engine.jobs.artifactWork.read(id))).toMatchObject({ status: 'ready', ownerId: null })
})
