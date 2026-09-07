import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  Artifact,
  Engine,
  IndexManifest,
  NotebookCell,
  NotebookDocument,
} from 'videobook-engine'
import { BookManager } from '../../server/src/book-manager.js'
import {
  copyAndAttachLibraryAsset,
  searchLibraryAssets,
  setNotebookMediaSlot,
} from '../../server/src/media-library.js'
import { searchReferenceStore } from '../../server/src/search-reference-store.js'

const reverseSearchManifest: IndexManifest = {
  manifestId: 'media-library-reverse-v1',
  provider: 'fixture',
  modelId: 'fixture',
  modelRevision: '1',
  license: 'test',
  embeddingSpace: 'media-library-reverse-space',
  dimensions: 3,
  modalities: ['visual'],
  supportedLanguages: ['en'],
  preprocessingVersion: '1',
  extractorVersion: '1',
  createdAt: 1,
}

async function readyArtifact(
  engine: Engine,
  kind: 'audio' | 'image' | 'video',
  name: string,
  filename: string,
  data: string,
): Promise<Artifact> {
  const created = await engine.artifacts.create(kind, name)
  if (!created.ok) throw new Error(created.error.message)
  const written = await engine.files.write(
    created.value.artifactId,
    filename,
    Buffer.from(data),
  )
  if (!written.ok) throw new Error(written.error.message)
  const metadata = await engine.metadata.artifacts.write(
    created.value.artifactId,
    'original',
    { prompt: name },
  )
  if (!metadata.ok) throw new Error(metadata.error.message)
  const lease = engine.jobs.artifactWork.begin(created.value.artifactId, {
    kind: 'upload',
    ownerKind: 'job',
    durationMs: 60_000,
  })
  if (!lease) throw new Error('Could not claim artifact')
  if (!engine.jobs.artifactWork.complete(
    created.value.artifactId,
    lease.ownerId,
  )) {
    throw new Error('Could not complete artifact')
  }
  return created.value
}

function cell(
  engine: Engine,
  input: Omit<NotebookCell, 'id'>,
): NotebookCell {
  return engine.notebooks.createCell(input)
}

async function writeNotebook(
  engine: Engine,
  document: NotebookDocument,
): Promise<void> {
  const written = await engine.notebooks.write(document)
  if (!written.ok) throw new Error(written.error.message)
}

async function indexReadyArtifact(
  engine: Engine,
  artifact: Artifact,
): Promise<void> {
  const files = await engine.files.manifest(artifact.artifactId)
  if (!files.ok) throw new Error(files.error.message)
  const source = files.value.files[0]!
  const registered = engine.temporalSearch.manifests.register(
    reverseSearchManifest,
  )
  if (!registered.ok) throw new Error(registered.error.message)
  const committed = engine.temporalSearch.commitBatch({
    artifactId: artifact.artifactId,
    objectHash: source.objectHash,
    manifestId: reverseSearchManifest.manifestId,
    generation: 'media-library-reverse-generation',
    phase: 'lexical',
    maxUnits: 1,
    observations: [{
      artifactId: artifact.artifactId,
      objectHash: source.objectHash,
      sourcePath: source.name,
      kind: 'frame',
      segmentationVersion: '1',
      texts: [],
      embeddings: [{
        modality: 'visual',
        embeddingSpace: reverseSearchManifest.embeddingSpace,
        vector: [1, 0, 0],
        sourceHash: source.objectHash,
      }],
      fingerprints: [],
    }],
    coveredRanges: [],
    totalUnits: 1,
    complete: true,
  })
  if (!committed.ok) throw new Error(committed.error.message)
  const activated = engine.temporalSearch.activate(
    reverseSearchManifest.manifestId,
    'media-library-reverse-generation',
  )
  if (!activated.ok) throw new Error(activated.error.message)
}

describe('media Library slots', () => {
  let rootDir: string
  let books: BookManager

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-media-library-'))
    books = new BookManager({
      libraryDir: join(rootDir, 'books'),
      objectPrefix: 'test-objects',
    })
    await books.ready()
  })

  afterEach(async () => {
    await books.close()
    await rm(rootDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    })
  })

  it('clears and refills a media slot without deleting its graph position or artifact', async () => {
    const created = await books.create('slot-book')
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const managed = books.get(created.value.bookId)
    expect(managed.ok).toBe(true)
    if (!managed.ok) return
    const engine = managed.value.engine
    const artifact = await readyArtifact(
      engine,
      'video',
      'source',
      'original.mp4',
      'video bytes',
    )
    const notebook = engine.notebooks.list()[0]!
    const producer = cell(engine, {
      type: 'split_video',
      label: 'split video source',
      slot: { row: 0, column: 0 },
    })
    const media = cell(engine, {
      type: 'video',
      label: 'source clip',
      slot: { row: 0, column: 1 },
      outputArtifactId: artifact.artifactId,
    })
    const downstream = cell(engine, {
      type: 'analyze',
      label: 'analyze source',
      slot: { row: 0, column: 2 },
    })
    const incoming = engine.notebooks.createEdge({
      source: producer.id,
      target: media.id,
      targetInput: 'media',
    })
    const outgoing = engine.notebooks.createEdge({
      source: media.id,
      target: downstream.id,
      targetInput: 'video',
    })
    await writeNotebook(engine, {
      ...notebook,
      cells: [producer, media, downstream],
      edges: [incoming, outgoing],
    })

    const cleared = await setNotebookMediaSlot(engine, {
      notebookId: notebook.id,
      cellId: media.id,
      artifactRef: null,
    })
    expect(cleared.outputArtifactId).toBeNull()
    const afterClear = engine.notebooks.read(notebook.id)
    expect(afterClear.ok).toBe(true)
    if (!afterClear.ok) return
    const clearedCell = afterClear.value.cells.find((item) =>
      item.id === media.id)
    expect(clearedCell).toMatchObject({
      id: media.id,
      label: 'source clip',
      slot: { row: 0, column: 1 },
    })
    expect(clearedCell?.outputArtifactId).toBeUndefined()
    expect(afterClear.value.edges).toEqual([outgoing])
    expect(engine.artifacts.get(artifact.artifactId).ok).toBe(true)
    expect(
      (afterClear.value.execution as Record<string, {
        stale?: boolean
      }>)[downstream.id]?.stale,
    ).toBe(true)

    const attached = await setNotebookMediaSlot(engine, {
      notebookId: notebook.id,
      cellId: media.id,
      artifactRef: artifact.artifactId,
    })
    expect(attached.outputArtifactId).toBe(artifact.artifactId)
    const afterAttach = engine.notebooks.read(notebook.id)
    expect(afterAttach.ok).toBe(true)
    if (!afterAttach.ok) return
    expect(afterAttach.value.cells.find((item) => item.id === media.id))
      .toMatchObject({
        outputArtifactId: artifact.artifactId,
        inputs: { state: 'completed' },
      })
  })

  it('filters Library search by exact tags without an embedding index', async () => {
    const alpha = await books.create('tag-alpha')
    const beta = await books.create('tag-beta')
    expect(alpha.ok && beta.ok).toBe(true)
    if (!alpha.ok || !beta.ok) return
    const alphaBook = books.get(alpha.value.bookId)
    const betaBook = books.get(beta.value.bookId)
    expect(alphaBook.ok && betaBook.ok).toBe(true)
    if (!alphaBook.ok || !betaBook.ok) return

    const kitchen = await readyArtifact(
      alphaBook.value.engine,
      'image',
      'kitchen still',
      'original.png',
      'alpha image',
    )
    const street = await readyArtifact(
      betaBook.value.engine,
      'image',
      'street still',
      'original.png',
      'beta image',
    )
    const untagged = await readyArtifact(
      betaBook.value.engine,
      'image',
      'plain still',
      'original.png',
      'beta plain',
    )
    const tagKitchen = await alphaBook.value.engine.tags.add(
      kitchen.artifactId,
      { facet: 'places', label: 'Kitchen' },
    )
    expect(tagKitchen.ok).toBe(true)
    const tagStreet = await betaBook.value.engine.tags.add(
      street.artifactId,
      { facet: 'places', label: 'Street' },
    )
    expect(tagStreet.ok).toBe(true)
    const tagWide = await betaBook.value.engine.tags.add(
      street.artifactId,
      { facet: 'editing', label: 'Wide shot' },
    )
    expect(tagWide.ok).toBe(true)

    // No query and no reference: an exact tag lookup answers immediately,
    // without waiting on any visual index.
    const kitchens = await searchLibraryAssets(books, {
      kinds: ['image'],
      tags: { all: [{ facet: 'places', label: 'kitchen' }] },
      limit: 10,
    })
    expect(kitchens.assets.map((asset) => asset.artifact_id)).toEqual([
      kitchen.artifactId,
    ])
    expect(kitchens.page.total).toBe(1)
    expect(kitchens.assets[0]?.tags?.effective.map((tag) => tag.label))
      .toEqual(['Kitchen'])

    const either = await searchLibraryAssets(books, {
      kinds: ['image'],
      tags: {
        any: [
          { facet: 'places', label: 'Kitchen' },
          { facet: 'places', label: 'Street' },
        ],
      },
      limit: 10,
    })
    expect(either.assets.map((asset) => asset.artifact_id).sort()).toEqual(
      [kitchen.artifactId, street.artifactId].sort(),
    )
    expect(either.assets.some((asset) => asset.artifact_id === untagged.artifactId))
      .toBe(false)
    // Facet counts describe the filtered result, not the whole library.
    expect(either.tag_facets).toEqual(expect.arrayContaining([
      { facet: 'places', key: 'kitchen', label: 'Kitchen', assets: 1 },
      { facet: 'editing', key: 'wide shot', label: 'Wide shot', assets: 1 },
    ]))

    // Tag filters compose with text search: both must hold.
    const composed = await searchLibraryAssets(books, {
      query: 'street',
      kinds: ['image'],
      tags: { all: [{ facet: 'places', label: 'Kitchen' }] },
      limit: 10,
    })
    expect(composed.assets).toEqual([])
    expect(composed.page.total).toBe(0)
  })

  it('searches ready compatible assets across books with owning-book labels', async () => {
    const alpha = await books.create('alpha')
    const beta = await books.create('beta')
    expect(alpha.ok && beta.ok).toBe(true)
    if (!alpha.ok || !beta.ok) return
    const alphaBook = books.get(alpha.value.bookId)
    const betaBook = books.get(beta.value.bookId)
    expect(alphaBook.ok && betaBook.ok).toBe(true)
    if (!alphaBook.ok || !betaBook.ok) return
    const moonGarden = await readyArtifact(
      alphaBook.value.engine,
      'image',
      'moon garden',
      'original.png',
      'alpha image',
    )
    await readyArtifact(
      betaBook.value.engine,
      'audio',
      'moon score',
      'original.mp3',
      'beta audio',
    )

    const images = await searchLibraryAssets(books, {
      query: 'moon',
      kinds: ['image'],
      limit: 10,
    })
    expect(images.assets).toHaveLength(1)
    expect(images.assets[0]).toMatchObject({
      id: moonGarden.artifactId,
      artifact_id: moonGarden.artifactId,
      label: 'moon garden',
      owning_book_id: alpha.value.bookId,
      owning_book_name: 'alpha',
      type: 'image',
    })
    expect(images.page).toMatchObject({
      offset: 0,
      limit: 10,
      total: 1,
      hasMore: false,
    })
    expect(images.books_with_errors).toEqual([])
  })

  it('returns indexed matches without admitting unrelated assets during reverse search', async () => {
    const alpha = await books.create('reverse-alpha')
    const beta = await books.create('reverse-beta')
    expect(alpha.ok && beta.ok).toBe(true)
    if (!alpha.ok || !beta.ok) return
    const alphaBook = books.get(alpha.value.bookId)
    const betaBook = books.get(beta.value.bookId)
    expect(alphaBook.ok && betaBook.ok).toBe(true)
    if (!alphaBook.ok || !betaBook.ok) return
    const indexed = await readyArtifact(
      alphaBook.value.engine,
      'image',
      'indexed match',
      'original.png',
      'indexed image',
    )
    await indexReadyArtifact(alphaBook.value.engine, indexed)
    await readyArtifact(
      betaBook.value.engine,
      'image',
      'unindexed asset',
      'original.png',
      'unindexed image',
    )
    const reference = searchReferenceStore.put({
      kind: 'image',
      name: 'reference.png',
      reference: {
        kind: 'image',
        embeddingSpace: reverseSearchManifest.embeddingSpace,
        vector: [1, 0, 0],
      },
    })

    const result = await searchLibraryAssets(books, {
      referenceId: reference.reference_id,
      kinds: ['image'],
      limit: 10,
    })
    searchReferenceStore.release(reference.reference_id)

    expect(result.assets.map((asset) => asset.artifact_id)).toEqual([
      indexed.artifactId,
    ])
    expect(result.assets[0]?.search_match?.score).toBeGreaterThan(0)
  })

  it('copies a foreign asset through Engine files and attaches its canonical target UUID', async () => {
    const source = await books.create('source-book')
    const target = await books.create('target-book')
    expect(source.ok && target.ok).toBe(true)
    if (!source.ok || !target.ok) return
    const sourceBook = books.get(source.value.bookId)
    const targetBook = books.get(target.value.bookId)
    expect(sourceBook.ok && targetBook.ok).toBe(true)
    if (!sourceBook.ok || !targetBook.ok) return
    const sourceArtifact = await readyArtifact(
      sourceBook.value.engine,
      'image',
      'hero frame',
      'original.png',
      'hero image',
    )
    expect((await sourceBook.value.engine.files.write(
      sourceArtifact.artifactId,
      'nested/.palette',
      Buffer.from('hidden palette'),
    )).ok).toBe(true)
    const notebook = targetBook.value.engine.notebooks.list()[0]!
    const media = cell(targetBook.value.engine, {
      type: 'image',
      label: 'image slot',
      slot: { row: 0, column: 0 },
    })
    await writeNotebook(targetBook.value.engine, {
      ...notebook,
      cells: [media],
      edges: [],
    })

    const copied = await copyAndAttachLibraryAsset(books, {
      sourceBookId: source.value.bookId,
      sourceArtifactId: sourceArtifact.artifactId,
      targetBookId: target.value.bookId,
      notebookId: notebook.id,
      cellId: media.id,
      expectedOutputArtifactId: null,
    })
    expect(targetBook.value.engine.jobs.queue.list({ type: 'semantic_index' })).toEqual([
      expect.objectContaining({ artifactId: null, payload: expect.objectContaining({ assetId: copied.targetArtifactId, prepareVisualMedia: true }) }),
    ])
    const targetArtifact = targetBook.value.engine.artifacts.get(
      copied.targetArtifactId,
    )
    expect(targetArtifact.ok).toBe(true)
    expect(copied.targetArtifactId).not.toBe(sourceArtifact.artifactId)
    const targetManifest = await targetBook.value.engine.files.manifest(
      copied.targetArtifactId,
      { includeDotfiles: true },
    )
    expect(targetManifest.ok).toBe(true)
    if (!targetManifest.ok) return
    expect(targetManifest.value.files.map((file) => [
      file.name,
      file.objectHash,
    ])).toEqual(expect.arrayContaining([
      ['original.png', expect.any(String)],
      ['nested/.palette', expect.any(String)],
    ]))
    const hidden = await targetBook.value.engine.files.read(
      copied.targetArtifactId,
      'nested/.palette',
    )
    expect(hidden.ok && hidden.value.toString()).toBe('hidden palette')
    const metadata = await targetBook.value.engine.metadata.artifacts.read<
      Record<string, unknown>
    >(copied.targetArtifactId, 'original')
    expect(metadata.ok && metadata.value).toMatchObject({
      origin: 'library-copy',
      source_book_id: source.value.bookId,
      source_artifact_id: sourceArtifact.artifactId,
    })
    const attached = targetBook.value.engine.notebooks.read(notebook.id)
    expect(attached.ok).toBe(true)
    if (!attached.ok) return
    expect(attached.value.cells[0]?.outputArtifactId)
      .toBe(copied.targetArtifactId)
    expect(sourceBook.value.engine.artifacts.get(sourceArtifact.artifactId).ok)
      .toBe(true)
  })

  it('rejects incompatible foreign media before creating a target artifact', async () => {
    const source = await books.create('mismatch-source')
    const target = await books.create('mismatch-target')
    expect(source.ok && target.ok).toBe(true)
    if (!source.ok || !target.ok) return
    const sourceBook = books.get(source.value.bookId)
    const targetBook = books.get(target.value.bookId)
    expect(sourceBook.ok && targetBook.ok).toBe(true)
    if (!sourceBook.ok || !targetBook.ok) return
    const audio = await readyArtifact(
      sourceBook.value.engine,
      'audio',
      'score',
      'original.mp3',
      'audio bytes',
    )
    const notebook = targetBook.value.engine.notebooks.list()[0]!
    const media = cell(targetBook.value.engine, {
      type: 'image',
      label: 'image slot',
      slot: { row: 0, column: 0 },
    })
    await writeNotebook(targetBook.value.engine, {
      ...notebook,
      cells: [media],
      edges: [],
    })

    await expect(copyAndAttachLibraryAsset(books, {
      sourceBookId: source.value.bookId,
      sourceArtifactId: audio.artifactId,
      targetBookId: target.value.bookId,
      notebookId: notebook.id,
      cellId: media.id,
      expectedOutputArtifactId: null,
    })).rejects.toThrow('cannot use')
    expect(targetBook.value.engine.artifacts.list()).toEqual([])
  })
})
