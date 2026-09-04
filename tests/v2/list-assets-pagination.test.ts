import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createEngine, type Engine } from 'videobook-engine'
import { buildAssetList } from '../../server/src/tools/reconcile-project-work.js'
import { listAssetsDef } from '../../server/src/tools/list-assets.js'

function countListingReads(engine: Engine) {
  const counts = {
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
  engine.jobs.pending.read = ((artifact: string) => {
    counts.pendingRead += 1
    return pendingRead(artifact)
  }) as typeof engine.jobs.pending.read
  engine.jobs.pending.findAll = (() => {
    counts.pendingFindAll += 1
    return pendingFindAll()
  }) as typeof engine.jobs.pending.findAll

  const failuresRead = engine.jobs.failures.read.bind(engine.jobs.failures)
  const failuresFindAll = engine.jobs.failures.findAll.bind(engine.jobs.failures)
  engine.jobs.failures.read = ((artifact: string) => {
    counts.failuresRead += 1
    return failuresRead(artifact)
  }) as typeof engine.jobs.failures.read
  engine.jobs.failures.findAll = (() => {
    counts.failuresFindAll += 1
    return failuresFindAll()
  }) as typeof engine.jobs.failures.findAll

  const workRead = engine.jobs.artifactWork.read.bind(engine.jobs.artifactWork)
  const workList = engine.jobs.artifactWork.list.bind(engine.jobs.artifactWork)
  engine.jobs.artifactWork.read = ((artifact: string) => {
    counts.artifactWorkRead += 1
    return workRead(artifact)
  }) as typeof engine.jobs.artifactWork.read
  engine.jobs.artifactWork.list = (() => {
    counts.artifactWorkList += 1
    return workList()
  }) as typeof engine.jobs.artifactWork.list

  const streamsList = engine.streams.list.bind(engine.streams)
  engine.streams.list = ((artifact?: string) => {
    if (artifact) counts.streamsByArtifact += 1
    else counts.streamsAll += 1
    return streamsList(artifact)
  }) as typeof engine.streams.list

  const filesRead = engine.files.read.bind(engine.files)
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

  return counts
}

describe('bounded asset listing', () => {
  let rootDir: string | undefined

  afterEach(async () => {
    if (rootDir) await rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })

  it('returns page metadata and never sends the full catalog by default', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-asset-page-'))
    const engine = createEngine({ rootDir, initialBookName: 'asset-page' })
    await engine.ready
    for (const label of ['one', 'two', 'three', 'four']) {
      const artifact = await engine.artifacts.create('image', label)
      expect(artifact.ok).toBe(true)
      if (!artifact.ok) return
      expect((await engine.files.write(
        artifact.value.artifactId,
        'original.png',
        Buffer.from(label),
      )).ok).toBe(true)
    }
    const result = await listAssetsDef(engine).handler({
      book_id: engine.book.get().bookId,
      sort: 'newest',
      limit: 2,
      offset: 1,
    })
    expect(result.isError, result.content[0]?.text).toBeUndefined()
    const payload = JSON.parse(result.content[0]!.text) as {
      assets: unknown[]
      page: {
        offset: number
        limit: number
        total: number
        hasMore: boolean
      }
    }
    expect(payload.assets).toHaveLength(2)
    expect(payload.page).toMatchObject({
      offset: 1,
      limit: 2,
      hasMore: true,
    })
    expect(payload.page.total).toBeGreaterThan(payload.assets.length)
    engine.close()
  })

  it('lists many artifacts without a per-asset sidecar and job-table round trip', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-asset-list-batch-'))
    const engine = createEngine({ rootDir, initialBookName: 'asset-list-batch' })
    await engine.ready
    const ids: string[] = []
    for (const label of [
      'one', 'two', 'three', 'four', 'five', 'six',
      'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
    ]) {
      const artifact = await engine.artifacts.create('image', label)
      expect(artifact.ok).toBe(true)
      if (!artifact.ok) return
      expect((await engine.files.write(
        artifact.value.artifactId,
        'original.png',
        Buffer.from(label),
      )).ok).toBe(true)
      ids.push(artifact.value.artifactId)
    }
    const counts = countListingReads(engine)
    const listed = await buildAssetList(engine, engine.book.get().bookId, 'newest')
    const images = listed.filter((asset) => asset.type === 'image')
    expect(images).toHaveLength(12)
    expect(images.map((asset) => asset.artifact_id).sort()).toEqual([...ids].sort())
    expect(images.every((asset) =>
      typeof asset.media_url === 'string'
      && asset.media_url.includes(asset.artifact_id))).toBe(true)
    expect(counts.pendingRead).toBe(0)
    expect(counts.pendingFindAll).toBe(1)
    expect(counts.failuresRead).toBe(0)
    expect(counts.failuresFindAll).toBe(1)
    expect(counts.artifactWorkRead).toBe(0)
    expect(counts.artifactWorkList).toBe(1)
    expect(counts.streamsByArtifact).toBe(0)
    expect(counts.streamsAll).toBe(1)
    expect(counts.sidecarReads).toBe(0)
    engine.close()
  })
})
