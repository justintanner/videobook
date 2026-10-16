import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { Engine, IndexManifest, Result } from 'videobook-engine'
import { BookManager } from '../../server/src/book-manager.js'
import { queue, setEngineRoot } from '../../server/src/queue.js'
import { registerPrepareTemporalSearchJob } from '../../server/src/jobs/prepare-temporal-search.js'
import { mediaLibraryDefs } from '../../server/src/tools/media-library.js'
import { semanticSearchDefs } from '../../server/src/tools/semantic-search.js'
import { videobookDomainDefs } from '../../server/src/tools/videobook-domain.js'
import { deleteAssetDef } from '../../server/src/tools/delete-asset.js'
import { searchReferenceStore } from '../../server/src/search-reference-store.js'
import { searchWithPreparation } from '../../src/videobook/search-preparation.js'
import type { ToolDef } from '../../server/src/tools/tool-def.js'

let root: string | undefined
let books: BookManager | undefined
let referenceId: string | undefined
afterEach(async () => {
  await queue.stop()
  if (referenceId) searchReferenceStore.release(referenceId)
  referenceId = undefined
  await books?.close()
  books = undefined
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 3 })
})

const manifest: IndexManifest = {
  manifestId: 'preparation-fixture', provider: 'fixture', modelId: 'fixture', modelRevision: '1',
  embeddingSpace: 'preparation-fixture', dimensions: 3, modalities: ['visual'], supportedLanguages: ['en'],
  preprocessingVersion: '1', extractorVersion: '1', createdAt: 1,
}

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

async function call(tool: ToolDef, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await tool.handler(args)
  expect(result.isError, result.content[0]?.text).toBeUndefined()
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>
}

async function seed(engine: Engine): Promise<string> {
  const artifact = value(await engine.artifacts.create('video', 'preparation source'))
  value(await engine.files.write(artifact.artifactId, 'original.mp4', Buffer.from('fixture-video')))
  value(await engine.metadata.artifacts.write(artifact.artifactId, 'original', { duration: 120 }))
  const objectHash = value(await engine.files.manifest(artifact.artifactId)).files[0]!.objectHash
  const stream = value(await engine.streams.register({
    artifactId: artifact.artifactId, sourcePath: 'original.mp4', objectHash, streamIndex: 0,
    kind: 'video', timeBase: { numerator: 1, denominator: 1_000 }, durationTicks: 120_000, codec: 'h264',
    video: { width: 320, height: 180, rotationDegrees: 0, pixelAspect: { numerator: 1, denominator: 1 } },
  }))
  value(engine.temporalSearch.manifests.register(manifest))
  for (let start = 0; start < 1200; start += 100) {
    const observations = Array.from({ length: 100 }, (_, offset) => {
      const index = start + offset
      return {
        artifactId: artifact.artifactId, objectHash, streamId: stream.streamId,
        range: { streamId: stream.streamId, objectHash, startTick: index * 100, durationTicks: 100, timeBase: stream.timeBase },
        kind: 'frame' as const, segmentationVersion: '1', texts: [], fingerprints: [],
        embeddings: [{ modality: 'visual' as const, embeddingSpace: manifest.embeddingSpace,
          vector: index === 123 ? [1, 0, 0] : [-1, index / 1200, 0], sourceHash: `${objectHash}:${index}` }],
      }
    })
    value(engine.temporalSearch.commitBatch({
      artifactId: artifact.artifactId, objectHash, manifestId: manifest.manifestId, generation: '1', phase: 'visual',
      cursor: String(start), maxUnits: 100, observations, coveredRanges: observations.map((item) => item.range),
      totalUnits: 1200, complete: start === 1100,
      ...(start === 1100 ? {} : { nextCursor: String(start + 100) }),
    }))
  }
  value(engine.temporalSearch.activate(manifest.manifestId, '1'))
  return artifact.artifactId
}

it.each([
  ['search_moments', 'book'],
  ['search_moments', 'library'],
  ['search_library_assets', 'library'],
] as const)(
  '%s (%s) returns deduplicated preparation work, then the client retries successfully', async (name, scope) => {
    root = await mkdtemp(join(tmpdir(), 'videobook-preparation-tools-'))
    books = new BookManager({ libraryDir: join(root, 'books') })
    await books.ready()
    const summary = value(await books.create('preparation'))
    const managed = value(books.get(summary.bookId))
    const engine = managed.engine
    const artifactId = await seed(engine)
    const lease = engine.jobs.artifactWork.begin(artifactId, { kind: 'upload', ownerKind: 'job', durationMs: 60_000 })!
    expect(engine.jobs.artifactWork.complete(artifactId, lease.ownerId)).toBe(true)
    await setEngineRoot(managed.rootDir, engine)
    registerPrepareTemporalSearchJob(engine)
    const searchTool = [...semanticSearchDefs(engine, books), ...mediaLibraryDefs(books)].find((tool) => tool.name === name)!
    const listTool = videobookDomainDefs(engine, books).find((tool) => tool.name === 'list_jobs')!
    const reference = searchReferenceStore.put({
      kind: 'image', name: 'fixture.png', reference: {
        kind: 'image', embeddingSpace: manifest.embeddingSpace, vector: [1, 0, 0],
      },
    })
    referenceId = reference.reference_id
    const args = {
      book_id: summary.bookId,
      ...(name === 'search_moments' && scope === 'library' ? { scope } : {}),
      query: { modalities: ['visual'], limit: 10 }, kinds: ['video'], reference_id: referenceId,
    }
    const started = performance.now()
    const [first, duplicate] = await Promise.all([call(searchTool, args), call(searchTool, args)])
    expect(performance.now() - started).toBeLessThan(2_000)
    expect(first.preparationJobs).toEqual(duplicate.preparationJobs)
    expect(first.preparationJobs).toHaveLength(1)
    const jobs = first.preparationJobs as Array<{ bookId: string; jobId: number }>
    expect(jobs[0]?.bookId).toBe(summary.bookId)
    expect(engine.jobs.queue.list({ type: 'prepare_temporal_search' })).toHaveLength(1)
    const states: boolean[] = []
    const result = await searchWithPreparation({
      search: () => call(searchTool, args),
      listJobs: async (bookId, jobIds) => call(listTool, { book_id: bookId, job_ids: jobIds }),
      onPreparing: (state) => { states.push(state) },
      isCancelled: () => false,
      intervalMs: 5,
      timeoutMs: 10_000,
    }) as { hits?: Array<{ artifactId: string }>; assets?: Array<{ artifact_id: string }> }
    expect(name === 'search_library_assets' ? result.assets?.[0]?.artifact_id : result.hits?.[0]?.artifactId).toBe(artifactId)
    expect(states).toContain(true)
    expect(states.at(-1)).toBe(false)
    expect(engine.jobs.queue.get(jobs[0]!.jobId)?.state).toBe('done')
    const selected = await call(listTool, { job_ids: [jobs[0]!.jobId] })
    expect(selected).toHaveLength(1)
    expect((selected as unknown as Array<{ id: number }>)[0]?.id).toBe(jobs[0]!.jobId)
    await queue.stop()
    await books.close()
    books = new BookManager({ libraryDir: join(root, 'books') })
    await books.ready()
    const reopened = value(books.get(summary.bookId)).engine
    const page = value(await reopened.temporalSearch.queryPrepared(
      { modalities: ['visual'] }, searchReferenceStore.get(referenceId).reference,
    ))
    expect(page.hits[0]?.artifactId).toBe(artifactId)
    await call(deleteAssetDef(reopened), { book_id: summary.bookId, asset_id: artifactId })
    const counts = reopened.catalogIntegrity().tableRowCounts
    for (const table of ['runtime_media_segments', 'runtime_segment_embeddings', 'runtime_index_coverage', 'runtime_index_batches']) {
      expect(counts[table], table).toBe(0)
    }
    const empty = value(await reopened.temporalSearch.queryPrepared(
      { modalities: ['visual'] }, searchReferenceStore.get(referenceId).reference,
    ))
    expect(empty.hits).toEqual([])
    expect(empty.coverage).toMatchObject({ totalArtifactCount: 0, indexedArtifactCount: 0 })
    const replacementId = await seed(reopened)
    value(await reopened.temporalSearch.prepare())
    const replacement = value(await reopened.temporalSearch.queryPrepared(
      { modalities: ['visual'] }, searchReferenceStore.get(referenceId).reference,
    ))
    expect(replacement.hits[0]?.artifactId).toBe(replacementId)
  }, 30_000,
)
