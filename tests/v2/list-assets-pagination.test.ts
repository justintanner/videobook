import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createEngine, type Engine } from 'videobook-engine'
import { buildAssetList } from '../../server/src/tools/reconcile-project-work.js'
import { listAssetsDef } from '../../server/src/tools/list-assets.js'

type ListingCounts = {
  pendingRead: number
  pendingFindAll: number
  failuresRead: number
  failuresFindAll: number
  artifactWorkRead: number
  artifactWorkList: number
  streamsByArtifact: number
  streamsAll: number
  sidecarReads: number
}

/**
 * Count what a listing asks the engine for, then hand back a restore so the
 * shared engine leaves the test as it found it.
 *
 * Per-artifact reads scale with the catalog and batch reads do not, so four
 * artifacts separate the two as decisively as forty would: a round trip per
 * asset reads four, a batch reads one.
 */
function countListingReads(engine: Engine): {
  counts: ListingCounts
  restore: () => void
} {
  const counts: ListingCounts = {
    pendingRead: 0,
    pendingFindAll: 0,
    failuresRead: 0,
    failuresFindAll: 0,
    artifactWorkRead: 0,
    artifactWorkList: 0,
    streamsByArtifact: 0,
    streamsAll: 0,
    sidecarReads: 0,
  }
  const pendingRead = engine.jobs.pending.read.bind(engine.jobs.pending)
  const pendingFindAll = engine.jobs.pending.findAll.bind(engine.jobs.pending)
  const failuresRead = engine.jobs.failures.read.bind(engine.jobs.failures)
  const failuresFindAll = engine.jobs.failures.findAll.bind(engine.jobs.failures)
  const workRead = engine.jobs.artifactWork.read.bind(engine.jobs.artifactWork)
  const workList = engine.jobs.artifactWork.list.bind(engine.jobs.artifactWork)
  const streamsList = engine.streams.list.bind(engine.streams)
  const filesRead = engine.files.read.bind(engine.files)

  engine.jobs.pending.read = ((artifact: string) => {
    counts.pendingRead += 1
    return pendingRead(artifact)
  }) as typeof engine.jobs.pending.read
  engine.jobs.pending.findAll = (() => {
    counts.pendingFindAll += 1
    return pendingFindAll()
  }) as typeof engine.jobs.pending.findAll
  engine.jobs.failures.read = ((artifact: string) => {
    counts.failuresRead += 1
    return failuresRead(artifact)
  }) as typeof engine.jobs.failures.read
  engine.jobs.failures.findAll = (() => {
    counts.failuresFindAll += 1
    return failuresFindAll()
  }) as typeof engine.jobs.failures.findAll
  engine.jobs.artifactWork.read = ((artifact: string) => {
    counts.artifactWorkRead += 1
    return workRead(artifact)
  }) as typeof engine.jobs.artifactWork.read
  engine.jobs.artifactWork.list = (() => {
    counts.artifactWorkList += 1
    return workList()
  }) as typeof engine.jobs.artifactWork.list
  engine.streams.list = ((artifact?: string) => {
    if (artifact) counts.streamsByArtifact += 1
    else counts.streamsAll += 1
    return streamsList(artifact)
  }) as typeof engine.streams.list
  engine.files.read = (async (artifact: string, filename: string) => {
    if (
      filename === 'elevenlabs.json'
      || filename === '.analysis.gpt4otrans.json'
      || filename === '.original.analysis.json'
    ) {
      counts.sidecarReads += 1
    }
    return filesRead(artifact, filename)
  }) as typeof engine.files.read

  return {
    counts,
    restore: () => {
      engine.jobs.pending.read = pendingRead
      engine.jobs.pending.findAll = pendingFindAll
      engine.jobs.failures.read = failuresRead
      engine.jobs.failures.findAll = failuresFindAll
      engine.jobs.artifactWork.read = workRead
      engine.jobs.artifactWork.list = workList
      engine.streams.list = streamsList
      engine.files.read = filesRead
    },
  }
}

// One engine and one catalog for both cases: each builds a Dolt-backed book,
// and the properties under test are about how a listing reads that book, not
// about how large it is.
describe('bounded asset listing', () => {
  const labels = ['one', 'two', 'three', 'four']
  let rootDir: string
  let engine: Engine
  let bookId: string
  let artifactIds: string[]

  beforeAll(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-asset-listing-'))
    engine = createEngine({ rootDir, initialBookName: 'asset-listing' })
    await engine.ready
    bookId = engine.book.get().bookId
    artifactIds = []
    for (const label of labels) {
      const artifact = await engine.artifacts.create('image', label)
      if (!artifact.ok) throw new Error(artifact.error.message)
      const written = await engine.files.write(
        artifact.value.artifactId,
        'original.png',
        Buffer.from(label),
      )
      if (!written.ok) throw new Error(written.error.message)
      artifactIds.push(artifact.value.artifactId)
    }
  })

  afterAll(async () => {
    engine?.close()
    if (rootDir) await rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })

  it('returns page metadata and never sends the full catalog by default', async () => {
    const result = await listAssetsDef(engine).handler({
      book_id: bookId,
      sort: 'newest',
      limit: 2,
      offset: 1,
    })
    expect(result.isError, result.content[0]?.text).toBeUndefined()
    const payload = JSON.parse(result.content[0]!.text) as {
      assets: unknown[]
      page: { offset: number, limit: number, total: number, hasMore: boolean }
    }
    expect(payload.assets).toHaveLength(2)
    expect(payload.page).toMatchObject({
      offset: 1,
      limit: 2,
      total: labels.length,
      hasMore: true,
    })
    expect(payload.page.total).toBeGreaterThan(payload.assets.length)
  })

  it('lists every artifact without a per-asset sidecar and job-table round trip', async () => {
    const { counts, restore } = countListingReads(engine)
    try {
      const listed = await buildAssetList(engine, bookId, 'newest')
      const images = listed.filter((asset) => asset.type === 'image')
      expect(images).toHaveLength(labels.length)
      expect(images.map((asset) => asset.artifact_id).sort())
        .toEqual([...artifactIds].sort())
      expect(images.every((asset) =>
        typeof asset.media_url === 'string'
        && asset.media_url.includes(asset.artifact_id))).toBe(true)
    } finally {
      restore()
    }
    // One batch read per table, whatever the catalog holds.
    expect(counts.pendingFindAll).toBe(1)
    expect(counts.failuresFindAll).toBe(1)
    expect(counts.artifactWorkList).toBe(1)
    expect(counts.streamsAll).toBe(1)
    // Nothing that would grow with it.
    expect(counts.pendingRead).toBe(0)
    expect(counts.failuresRead).toBe(0)
    expect(counts.artifactWorkRead).toBe(0)
    expect(counts.streamsByArtifact).toBe(0)
    expect(counts.sidecarReads).toBe(0)
  })
})
