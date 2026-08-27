import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Engine, IndexManifest } from 'videobook-engine'
import { BookManager } from '../../server/src/book-manager.js'
import { semanticSearchDefs } from '../../server/src/tools/semantic-search.js'
import { searchReferenceStore } from '../../server/src/search-reference-store.js'

const manifest: IndexManifest = {
  manifestId: 'library-lexical-v1',
  provider: 'fixture',
  modelId: 'fixture',
  modelRevision: '1',
  license: 'test',
  embeddingSpace: 'library-lexical-space',
  dimensions: 3,
  modalities: ['visual', 'metadata'],
  supportedLanguages: ['en'],
  preprocessingVersion: '1',
  extractorVersion: '1',
  createdAt: 1,
}

describe('library moment search', () => {
  let rootDir: string | undefined
  let books: BookManager | undefined

  afterEach(async () => {
    await books?.close()
    if (rootDir) await rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })

  it('federates book-scoped results with owning-book labels and similarity ordering', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-library-search-'))
    books = new BookManager({ libraryDir: join(rootDir, 'books') })
    await books.ready()
    const alpha = await books.create('alpha')
    const beta = await books.create('beta')
    expect(alpha.ok && beta.ok).toBe(true)
    if (!alpha.ok || !beta.ok) return
    const alphaBook = books.get(alpha.value.bookId)
    const betaBook = books.get(beta.value.bookId)
    expect(alphaBook.ok && betaBook.ok).toBe(true)
    if (!alphaBook.ok || !betaBook.ok) return
    await indexStill(alphaBook.value.engine, 'red van alpha')
    await indexStill(betaBook.value.engine, 'red van beta')

    const tool = semanticSearchDefs(alphaBook.value.engine, books)
      .find((entry) => entry.name === 'search_library_moments')
    expect(tool).toBeTruthy()
    if (!tool) return
    const result = await tool.handler({ query: { text: 'red van', limit: 10 } })
    expect(result.isError).toBeUndefined()
    const payload = JSON.parse(result.content[0]!.text) as {
      hits: Array<{ owningBookId: string; owningBookName: string }>
      coverage: { state: string; indexedArtifactCount: number }
    }
    expect(payload.hits.map((hit) => hit.owningBookName)).toEqual(['alpha', 'beta'])
    expect(payload.hits.map((hit) => hit.owningBookId)).toEqual([
      alpha.value.bookId,
      beta.value.bookId,
    ])
    expect(payload.coverage).toMatchObject({
      state: 'ready',
      indexedArtifactCount: 2,
    })
    const reference = searchReferenceStore.put({
      kind: 'image',
      name: 'alpha-reference.png',
      reference: {
        kind: 'image',
        embeddingSpace: manifest.embeddingSpace,
        vector: [1, 0, 0],
      },
    })
    const reverseResult = await tool.handler({
      query: { artifactKinds: ['image'], limit: 10 },
      reference_id: reference.reference_id,
    })
    expect(reverseResult.isError).toBeUndefined()
    const reversePayload = JSON.parse(reverseResult.content[0]!.text) as {
      hits: Array<{ owningBookName: string }>
    }
    expect(reversePayload.hits[0]?.owningBookName).toBe('alpha')
    searchReferenceStore.release(reference.reference_id)
  })

  it('ranks the most similar hit first even when its book sorts last alphabetically', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-library-search-'))
    books = new BookManager({ libraryDir: join(rootDir, 'books') })
    await books.ready()
    const alpha = await books.create('alpha')
    const beta = await books.create('beta')
    expect(alpha.ok && beta.ok).toBe(true)
    if (!alpha.ok || !beta.ok) return
    const alphaBook = books.get(alpha.value.bookId)
    const betaBook = books.get(beta.value.bookId)
    expect(alphaBook.ok && betaBook.ok).toBe(true)
    if (!alphaBook.ok || !betaBook.ok) return
    await indexStill(alphaBook.value.engine, 'red van alpha')
    await indexStill(betaBook.value.engine, 'red van beta')

    const tool = semanticSearchDefs(alphaBook.value.engine, books)
      .find((entry) => entry.name === 'search_library_moments')
    expect(tool).toBeTruthy()
    if (!tool) return
    const reference = searchReferenceStore.put({
      kind: 'image',
      name: 'beta-reference.png',
      reference: {
        kind: 'image',
        embeddingSpace: manifest.embeddingSpace,
        vector: [0, 1, 0],
      },
    })
    const result = await tool.handler({
      query: { artifactKinds: ['image'], limit: 10 },
      reference_id: reference.reference_id,
    })
    expect(result.isError).toBeUndefined()
    const payload = JSON.parse(result.content[0]!.text) as {
      hits: Array<{ owningBookName: string; score: number }>
    }
    expect(payload.hits.map((hit) => hit.owningBookName)).toEqual(['beta', 'alpha'])
    expect(payload.hits[0]?.score).toBeCloseTo(1)
    expect(payload.hits[1]?.score ?? 1).toBeLessThan(0.5)
    searchReferenceStore.release(reference.reference_id)
  })

  it('surfaces an exact fingerprint match above every similarity hit', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-library-search-'))
    books = new BookManager({ libraryDir: join(rootDir, 'books') })
    await books.ready()
    const alpha = await books.create('alpha')
    const beta = await books.create('beta')
    expect(alpha.ok && beta.ok).toBe(true)
    if (!alpha.ok || !beta.ok) return
    const alphaBook = books.get(alpha.value.bookId)
    const betaBook = books.get(beta.value.bookId)
    expect(alphaBook.ok && betaBook.ok).toBe(true)
    if (!alphaBook.ok || !betaBook.ok) return
    await indexStill(alphaBook.value.engine, 'red van alpha')
    await indexStill(betaBook.value.engine, 'red van beta', 'beta-source-bytes')

    const tool = semanticSearchDefs(alphaBook.value.engine, books)
      .find((entry) => entry.name === 'search_library_moments')
    expect(tool).toBeTruthy()
    if (!tool) return
    const reference = searchReferenceStore.put({
      kind: 'image',
      name: 'beta-copy.png',
      reference: {
        kind: 'image',
        embeddingSpace: manifest.embeddingSpace,
        vector: [0, 0, 1],
        fingerprints: [{ kind: 'sha256', value: 'beta-source-bytes' }],
      },
    })
    const result = await tool.handler({
      query: { artifactKinds: ['image'], limit: 10 },
      reference_id: reference.reference_id,
    })
    expect(result.isError).toBeUndefined()
    const payload = JSON.parse(result.content[0]!.text) as {
      hits: Array<{
        owningBookName: string
        score: number
        signals: Array<{ kind: string }>
      }>
    }
    expect(payload.hits[0]?.owningBookName).toBe('beta')
    expect(payload.hits[0]?.score).toBe(1)
    expect(payload.hits[0]?.signals.some((signal) => signal.kind === 'exact')).toBe(true)
    searchReferenceStore.release(reference.reference_id)
  })
})

async function indexStill(
  engine: Engine,
  description: string,
  fingerprint?: string,
): Promise<void> {
  const artifact = await engine.artifacts.create('image', description)
  if (!artifact.ok) throw new Error(artifact.error.message)
  const written = await engine.files.write(
    artifact.value.artifactId,
    'original.jpg',
    Buffer.from(description),
  )
  if (!written.ok) throw new Error(written.error.message)
  const files = await engine.files.manifest(artifact.value.artifactId)
  if (!files.ok) throw new Error(files.error.message)
  const source = files.value.files[0]!
  const registered = engine.temporalSearch.manifests.register(manifest)
  if (!registered.ok) throw new Error(registered.error.message)
  const committed = engine.temporalSearch.commitBatch({
    artifactId: artifact.value.artifactId,
    objectHash: source.objectHash,
    manifestId: manifest.manifestId,
    generation: 'library-generation',
    phase: 'lexical',
    maxUnits: 1,
    observations: [{
      artifactId: artifact.value.artifactId,
      objectHash: source.objectHash,
      sourcePath: source.name,
      kind: 'frame',
      segmentationVersion: '1',
      texts: [{ kind: 'description', language: 'en', text: description }],
      embeddings: [{
        modality: 'visual',
        embeddingSpace: manifest.embeddingSpace,
        vector: description.includes('alpha') ? [1, 0, 0] : [0, 1, 0],
        sourceHash: source.objectHash,
      }],
      fingerprints: fingerprint
        ? [{ kind: 'sha256', value: fingerprint, extractorVersion: '1' }]
        : [],
    }],
    coveredRanges: [],
    totalUnits: 1,
    complete: true,
  })
  if (!committed.ok) throw new Error(committed.error.message)
  const activated = engine.temporalSearch.activate(
    manifest.manifestId,
    'library-generation',
  )
  if (!activated.ok) throw new Error(activated.error.message)
}
