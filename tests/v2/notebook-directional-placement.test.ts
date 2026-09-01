import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  resolveGeneratedVideoArtifact,
  resolveNotebookCellArtifactId,
  type NotebookDocument,
} from 'videobook-engine'
import { BookManager } from '../../server/src/book-manager.js'
import { scopedBookEngine, withBookContext } from '../../server/src/book-context.js'
import {
  collapseLegacyExtractPairs,
  migrateLegacyExtractFrameCells,
  allocateGenerateImageResult,
  allocateGenerateVideoResult,
  ensureGenerateAudioOutput,
  ensureGenerateImageOutput,
  ensureGenerateVideoOutput,
  findGenerateAudioOutput,
  findGenerateImageOutput,
  findGenerateVideoOutput,
  listGenerateImageOutputs,
} from '../../server/src/notebook-cell-outputs.js'
import {
  notebookDocumentsEqual,
  relayoutNotebookDocument,
} from '../../server/src/notebook-relayout.js'
import { executeRelayoutNotebook } from '../../server/src/jobs/relayout-notebook.js'
import {
  notebookCellFingerprint,
  notebookCellIsStale,
  reconcileGenerationMediaOutputs,
  registerRunNotebookJob,
  runNotebookCell,
} from '../../server/src/jobs/run-notebook.js'
import { DEFAULT_VIDEO_TOOL } from '../../server/src/notebook-action-catalog.js'
import {
  queue,
  setEngineRoot,
  stopBookQueue,
} from '../../server/src/queue.js'
import { videobookDomainDefs } from '../../server/src/tools/videobook-domain.js'
import type { ToolDef } from '../../server/src/tools/tool-def.js'
import {
  allocateNotebookVideoGenerationSlots,
  nextNotebookHorizontalGenerationSlot,
  nextNotebookVideoGenerationSlot,
} from '../../src/videobook/notebook-grid.js'

function resultJson(result: Awaited<ReturnType<ToolDef['handler']>>): unknown {
  expect(result.isError, result.content[0]?.text).toBeUndefined()
  return JSON.parse(result.content[0]!.text) as unknown
}

function value<T>(
  result: { ok: true; value: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

describe('directional canvas placement', () => {
  let rootDir: string
  let books: BookManager

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-directional-'))
    books = new BookManager({
      libraryDir: join(rootDir, 'books'),
      objectPrefix: 'test-objects',
    })
    await books.ready()
  })

  afterEach(async () => {
    await books.close()
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })

  it('packs generation waves under the image band and frame work beside sources', () => {
    const images = [
      { type: 'image', slot: { row: 0, column: 0 } },
      { type: 'image', slot: { row: 0, column: 1 } },
      { type: 'image', slot: { row: 0, column: 2 } },
      { type: 'image', slot: { row: 0, column: 3 } },
    ]
    const first = allocateNotebookVideoGenerationSlots(images)
    expect(first).toEqual({
      tile: { row: 1, column: 0 },
      output: { row: 2, column: 0 },
    })
    // Sibling generation joins the wave row beside the first tile, its
    // output directly beneath — never drifting right of the sources band.
    const second = allocateNotebookVideoGenerationSlots([
      ...images,
      { type: 'generate_video', slot: first.tile },
      { type: 'video', slot: first.output },
    ])
    expect(second).toEqual({
      tile: { row: 1, column: 1 },
      output: { row: 2, column: 1 },
    })

    expect(nextNotebookHorizontalGenerationSlot(
      [{ type: 'video', slot: { row: 2, column: 0 } }],
      [{ row: 2, column: 0 }],
    )).toEqual({ row: 2, column: 1 })

    // A derived image source starts a lane straight down its own column.
    expect(nextNotebookVideoGenerationSlot(
      [
        { type: 'image', slot: { row: 3, column: 2 } },
        { type: 'generate_video', slot: { row: 1, column: 0 } },
        { type: 'video', slot: { row: 2, column: 0 } },
      ],
      [{ row: 3, column: 2 }],
    )).toEqual({ row: 4, column: 2 })
  })

  it('creates generate_video with a video output cell directly below', async () => {
    const defs = videobookDomainDefs(scopedBookEngine, books)
    const byName = new Map(defs.map((def) => [def.name, def]))
    const created = resultJson(await byName.get('create_book')!.handler({
      name: 'directional-video',
    })) as { bookId: string }
    const managed = books.get(created.bookId)
    expect(managed.ok).toBe(true)
    if (!managed.ok) return
    const engine = managed.value.engine

    const invoke = async (name: string, args: Record<string, unknown>) => {
      const def = byName.get(name)
      if (!def) throw new Error(`Missing ${name}`)
      return await withBookContext(
        { bookId: created.bookId, engine },
        () => def.handler({ book_id: created.bookId, ...args }),
      )
    }

    const notebooks = resultJson(await invoke('list_notebooks', {})) as Array<{
      id: string
    }>
    const notebookId = notebooks[0]!.id
    const generated = resultJson(await invoke('create_notebook_cell', {
      notebook_id: notebookId,
      cell: {
        type: 'generate_video',
        label: 'gen-video',
        slot: { row: 0, column: 0 },
        prompt: 'a cat walks',
      },
    })) as {
      id: string
      output_cell?: {
        id: string
        type: string
        slot: { row: number; column: number }
        inputs?: Record<string, unknown>
      }
      output_edge?: {
        source: string
        target: string
        targetInput: string
      }
    }

    expect(generated.output_cell).toBeUndefined()
    expect(generated.output_edge).toBeUndefined()
    const createdNotebook = value(engine.notebooks.read(notebookId))
    const allocated = allocateGenerateVideoResult(
      engine,
      createdNotebook,
      generated.id,
      { runId: 'run-video-1', acceptedAt: '2026-08-22T00:00:00.000Z' },
    )
    expect(allocated.outputCell).toMatchObject({
      type: 'video',
      slot: { row: 1, column: 0 },
      inputs: {
        mediaRole: 'generate-video-output',
        producerCellId: generated.id,
      },
    })
    expect(allocated.outputEdge).toMatchObject({
      source: generated.id,
      target: allocated.outputCell.id,
      targetInput: 'media',
    })

    const tile = createdNotebook.cells.find((cell) => cell.id === generated.id)!
    expect(tile.outputArtifactId).toBeUndefined()
    expect(allocated.outputCell.slot).toEqual({ row: 1, column: 0 })
  })

  it('resolves generated video from output cell and legacy inline artifact', async () => {
    const defs = videobookDomainDefs(scopedBookEngine, books)
    const byName = new Map(defs.map((def) => [def.name, def]))
    const created = resultJson(await byName.get('create_book')!.handler({
      name: 'resolver-book',
    })) as { bookId: string }
    const managed = books.get(created.bookId)
    expect(managed.ok).toBe(true)
    if (!managed.ok) return
    const engine = managed.value.engine
    const notebook = value(engine.notebooks.read(engine.notebooks.list()[0]!.id))
    const legacyArtifact = value(await engine.artifacts.create({
      kind: 'video',
      label: 'legacy-video',
    }))
    const newArtifact = value(await engine.artifacts.create({
      kind: 'video',
      label: 'new-video',
    }))

    const legacyTile = engine.notebooks.createCell({
      type: 'generate_video',
      slot: { row: 0, column: 0 },
      prompt: 'legacy',
      outputArtifactId: legacyArtifact.artifactId,
    })
    const newTile = engine.notebooks.createCell({
      type: 'generate_video',
      slot: { row: 2, column: 0 },
      prompt: 'new style',
    })
    const outputCell = engine.notebooks.createCell({
      type: 'video',
      slot: { row: 3, column: 0 },
      outputArtifactId: newArtifact.artifactId,
      inputs: {
        mediaRole: 'generate-video-output',
        producerCellId: newTile.id,
      },
    })
    const document: NotebookDocument = {
      ...notebook,
      cells: [legacyTile, newTile, outputCell],
      edges: [
        engine.notebooks.createEdge({
          source: newTile.id,
          target: outputCell.id,
          targetInput: 'media',
        }),
      ],
    }
    value(await engine.notebooks.write(document))

    const reloaded = value(engine.notebooks.read(notebook.id))
    const legacy = reloaded.cells.find((cell) => cell.id === legacyTile.id)!
    const modern = reloaded.cells.find((cell) => cell.id === newTile.id)!
    expect(resolveGeneratedVideoArtifact(reloaded, legacy)).toBe(
      legacyArtifact.artifactId,
    )
    expect(resolveGeneratedVideoArtifact(reloaded, modern)).toBe(
      newArtifact.artifactId,
    )
    expect(modern.outputArtifactId).toBeUndefined()
  })

  it('relayouts a bam-shaped notebook into directional compact form idempotently', async () => {
    const defs = videobookDomainDefs(scopedBookEngine, books)
    const byName = new Map(defs.map((def) => [def.name, def]))
    const created = resultJson(await byName.get('create_book')!.handler({
      name: 'bam-shaped',
    })) as { bookId: string }
    const managed = books.get(created.bookId)
    expect(managed.ok).toBe(true)
    if (!managed.ok) return
    const engine = managed.value.engine
    const notebook = value(engine.notebooks.read(engine.notebooks.list()[0]!.id))
    const images = [0, 1, 2, 3].map((column) =>
      engine.notebooks.createCell({
        type: 'image',
        label: `img-${column}`,
        slot: { row: 0, column },
      }))
    const videoArtifacts = await Promise.all(
      [0, 1, 2, 3, 4].map(async (index) =>
        value(await engine.artifacts.create({
          kind: 'video',
          label: `video-${index}`,
        }))),
    )
    const generateSlots = [
      { row: 1, column: 0 },
      { row: 1, column: 7 },
      { row: 2, column: 0 },
      { row: 2, column: 1 },
      { row: 3, column: 3 },
    ]
    const generateVideos = generateSlots.map((slot, index) =>
      engine.notebooks.createCell({
        type: 'generate_video',
        label: `gen-${index}`,
        slot,
        prompt: `video ${index}`,
        outputArtifactId: videoArtifacts[index]!.artifactId,
      }))
    const extractA = engine.notebooks.createCell({
      type: 'image',
      label: 'frame-a',
      slot: { row: 0, column: 4 },
      inputs: { mediaRole: 'extract-frame-output', frameMode: 'first' },
    })
    const extractB = engine.notebooks.createCell({
      type: 'image',
      label: 'frame-b',
      slot: { row: 2, column: 2 },
      inputs: { mediaRole: 'extract-frame-output', frameMode: 'first' },
    })

    const edges = [
      ...generateVideos.flatMap((tile, index) =>
        index < 3
          ? images.slice(0, 3).map((image, imageIndex) =>
            engine.notebooks.createEdge({
              source: image.id,
              target: tile.id,
              targetInput: `image${imageIndex + 1}`,
            }))
          : []),
      engine.notebooks.createEdge({
        source: generateVideos[2]!.id,
        target: extractA.id,
        targetInput: 'segment',
      }),
      engine.notebooks.createEdge({
        source: generateVideos[3]!.id,
        target: extractB.id,
        targetInput: 'segment',
      }),
    ]

    const originalEdgeCount = edges.length
    value(await engine.notebooks.write({
      ...notebook,
      cells: [
        ...images,
        ...generateVideos,
        extractA,
        extractB,
      ],
      edges,
    }))

    const first = await executeRelayoutNotebook(engine, {
      type: 'relayout_notebook',
      bookId: created.bookId,
      notebookId: notebook.id,
    })
    expect(first.changed).toBe(true)

    const after = value(engine.notebooks.read(notebook.id))
    const generateTiles = after.cells
      .filter((cell) => cell.type === 'generate_video')
      .sort((left, right) => left.slot.row - right.slot.row
        || left.slot.column - right.slot.column)
    expect(generateTiles).toHaveLength(5)
    for (const tile of generateTiles) {
      const output = findGenerateVideoOutput(after, tile.id)
      expect(output).not.toBeNull()
      expect(output!.outputCell.slot.column).toBe(tile.slot.column)
      expect(output!.outputCell.slot.row).toBe(tile.slot.row + 1)
      expect(output!.outputCell.outputArtifactId).toBeTruthy()
      expect(tile.outputArtifactId).toBeUndefined()
      expect(tile.slot.column).toBeLessThan(9)
    }
    expect(Math.max(...after.cells.map((cell) => cell.slot.column)))
      .toBeLessThan(9)
    expect(after.edges.length).toBe(originalEdgeCount + 5)

    const sourceImages = after.cells
      .filter((cell) => cell.type === 'image'
        && cell.inputs?.mediaRole !== 'extract-frame-output')
      .sort((left, right) => left.slot.column - right.slot.column)
    expect(sourceImages.map((cell) => cell.slot)).toEqual([
      { row: 0, column: 0 },
      { row: 0, column: 1 },
      { row: 0, column: 2 },
      { row: 0, column: 3 },
    ])

    for (const extract of after.cells.filter((cell) =>
      cell.inputs?.mediaRole === 'extract-frame-output')) {
      const sourceEdge = after.edges.find((edge) =>
        edge.target === extract.id && edge.targetInput === 'segment')
      expect(sourceEdge).toBeTruthy()
      const sourceCell = after.cells.find((cell) => cell.id === sourceEdge!.source)!
      const videoAnchor = sourceCell.type === 'generate_video'
        ? findGenerateVideoOutput(after, sourceCell.id)!.outputCell
        : sourceCell
      expect(extract.slot.row).toBe(videoAnchor.slot.row)
      expect(extract.slot.column).toBeGreaterThan(videoAnchor.slot.column)
    }

    const secondDoc = relayoutNotebookDocument(engine, after)
    expect(notebookDocumentsEqual(after, secondDoc)).toBe(true)

    const second = await executeRelayoutNotebook(engine, {
      type: 'relayout_notebook',
      bookId: created.bookId,
      notebookId: notebook.id,
    })
    expect(second.changed).toBe(false)
    expect(second.cell_count).toBe(after.cells.length)
    expect(second.edge_count).toBe(after.edges.length)
  })

  it('matches the hand-tuned bam default layout (golden fixture)', async () => {
    const fixture = JSON.parse(readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        'fixtures/bam-canvas-default.json',
      ),
      'utf8',
    )) as {
      cells: NotebookDocument['cells']
      edges: NotebookDocument['edges']
    }
    const defs = videobookDomainDefs(scopedBookEngine, books)
    const byName = new Map(defs.map((def) => [def.name, def]))
    const created = resultJson(await byName.get('create_book')!.handler({
      name: 'bam-golden',
    })) as { bookId: string }
    const managed = books.get(created.bookId)
    expect(managed.ok).toBe(true)
    if (!managed.ok) return
    const engine = managed.value.engine
    const notebook = value(engine.notebooks.read(engine.notebooks.list()[0]!.id))
    const document = {
      ...notebook,
      cells: fixture.cells.map((cell) =>
        (cell.type as string) === 'extract_frame'
          ? { ...cell, type: 'image' as const, operation: 'extract_frame' }
          : cell),
      edges: fixture.edges,
    }

    const relaid = relayoutNotebookDocument(
      engine,
      migrateLegacyExtractFrameCells(collapseLegacyExtractPairs(document)),
    )
    const slotByUserAddress = new Map(fixture.cells.map((cell) => [
      `@${String.fromCharCode(97 + cell.slot.row)}${cell.slot.column + 1}`,
      cell.id,
    ]))
    const relaidAddress = (userAddress: string): string => {
      const cellId = slotByUserAddress.get(userAddress)!
      const cell = relaid.cells.find((candidate) => candidate.id === cellId)!
      return `@${String.fromCharCode(97 + cell.slot.row)}${cell.slot.column + 1}`
    }

    expect(relaid.cells.some((cell) =>
      cell.operation === 'extract_frame')).toBe(false)
    expect(relaid.cells.filter((cell) =>
      cell.inputs?.mediaRole === 'extract-frame-output')).toHaveLength(2)
    for (const stable of [
      '@a1', '@a2', '@a3', '@a4',
      '@b1', '@b2', '@b3',
      '@c1', '@c2', '@c3',
    ]) {
      expect(relaidAddress(stable), `cell placed at ${stable} by hand`)
        .toBe(stable)
    }
    expect(relaidAddress('@d3')).toBe('@c4')
    expect(relaidAddress('@e3')).toBe('@d4')
    expect(relaidAddress('@f3')).toBe('@e4')
    expect(relaidAddress('@e5')).toBe('@e5')
    expect(relaidAddress('@f5')).toBe('@f5')
    expect(relaidAddress('@g5')).toBe('@g5')

    const again = relayoutNotebookDocument(engine, relaid)
    expect(notebookDocumentsEqual(relaid, again)).toBe(true)
  })

  it('does not treat completed generate_video with output-cell artifact as stale', async () => {
    const defs = videobookDomainDefs(scopedBookEngine, books)
    const byName = new Map(defs.map((def) => [def.name, def]))
    const created = resultJson(await byName.get('create_book')!.handler({
      name: 'stale-check',
    })) as { bookId: string }
    const managed = books.get(created.bookId)
    expect(managed.ok).toBe(true)
    if (!managed.ok) return
    const engine = managed.value.engine
    const notebook = value(engine.notebooks.read(engine.notebooks.list()[0]!.id))
    const artifact = value(await engine.artifacts.create({
      kind: 'video',
      label: 'completed-output',
    }))
    const tile = engine.notebooks.createCell({
      type: 'generate_video',
      slot: { row: 0, column: 0 },
      prompt: 'a cat walks',
      tool: DEFAULT_VIDEO_TOOL,
      provider: 'kie',
      model: 'GeminiOmniVideoRequestSchema',
      operation: 'image_to_video',
    })
    const outputCell = engine.notebooks.createCell({
      type: 'video',
      slot: { row: 1, column: 0 },
      outputArtifactId: artifact.artifactId,
      inputs: {
        mediaRole: 'generate-video-output',
        producerCellId: tile.id,
        state: 'completed',
      },
    })
    const draft: NotebookDocument = {
      ...notebook,
      cells: [tile, outputCell],
      edges: [
        engine.notebooks.createEdge({
          source: tile.id,
          target: outputCell.id,
          targetInput: 'media',
        }),
      ],
    }
    const fingerprint = notebookCellFingerprint(draft, tile)
    const completed: NotebookDocument = {
      ...draft,
      execution: {
        [tile.id]: {
          fingerprint,
          status: 'completed',
          outputArtifactId: artifact.artifactId,
          completedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tool: DEFAULT_VIDEO_TOOL,
        },
      },
    }
    value(await engine.notebooks.write(completed))
    const loaded = value(engine.notebooks.read(notebook.id))
    const liveTile = loaded.cells.find((cell) => cell.id === tile.id)!
    expect(liveTile.outputArtifactId).toBeUndefined()
    expect(resolveGeneratedVideoArtifact(loaded, liveTile)).toBe(
      artifact.artifactId,
    )
    expect(notebookCellIsStale(engine, loaded, liveTile)).toBe(false)

    // Re-run without force must skip (not re-execute paid generation).
    registerRunNotebookJob(engine)
    await setEngineRoot(rootDir, engine)
    try {
      const result = await queue.enqueueAndWait<{
        status: string
        outputs: Record<string, string>
        errors?: string[]
      }>(`run-notebook-skip-${tile.id}`, {
        type: 'run_notebook',
        bookId: created.bookId,
        notebookId: notebook.id,
        cellIds: [tile.id],
        force: false,
      })
      expect(result.status).toBe('completed')
      expect(result.outputs[tile.id]).toBe(artifact.artifactId)
      expect(result.errors ?? []).toEqual([])
      // Still not stale after the skip path.
      const after = value(engine.notebooks.read(notebook.id))
      const afterTile = after.cells.find((cell) => cell.id === tile.id)!
      expect(notebookCellIsStale(engine, after, afterTile)).toBe(false)
      expect(afterTile.outputArtifactId).toBeUndefined()
    } finally {
      await stopBookQueue(created.bookId)
    }
  })

  it('ensureGenerateVideoOutput is idempotent for existing output cells', async () => {
    const defs = videobookDomainDefs(scopedBookEngine, books)
    const byName = new Map(defs.map((def) => [def.name, def]))
    const created = resultJson(await byName.get('create_book')!.handler({
      name: 'ensure-idempotent',
    })) as { bookId: string }
    const managed = books.get(created.bookId)
    expect(managed.ok).toBe(true)
    if (!managed.ok) return
    const engine = managed.value.engine
    const notebook = value(engine.notebooks.read(engine.notebooks.list()[0]!.id))
    const tile = engine.notebooks.createCell({
      type: 'generate_video',
      slot: { row: 0, column: 0 },
      prompt: 'walk',
    })
    const initial: NotebookDocument = {
      ...notebook,
      cells: [tile],
      edges: [],
    }
    value(await engine.notebooks.write(initial))
    const first = ensureGenerateVideoOutput(engine, initial, tile.id)
    expect(first.created).toBe(true)
    const second = ensureGenerateVideoOutput(engine, first.document, tile.id)
    expect(second.created).toBe(false)
    expect(second.outputCell.id).toBe(first.outputCell.id)
  })

  it('creates generate_image with an image output cell to the right', async () => {
    const defs = videobookDomainDefs(scopedBookEngine, books)
    const byName = new Map(defs.map((def) => [def.name, def]))
    const created = resultJson(await byName.get('create_book')!.handler({
      name: 'directional-image',
    })) as { bookId: string }
    const managed = books.get(created.bookId)
    expect(managed.ok).toBe(true)
    if (!managed.ok) return
    const engine = managed.value.engine

    const invoke = async (name: string, args: Record<string, unknown>) => {
      const def = byName.get(name)
      if (!def) throw new Error(`Missing ${name}`)
      return await withBookContext(
        { bookId: created.bookId, engine },
        () => def.handler({ book_id: created.bookId, ...args }),
      )
    }

    const notebooks = resultJson(await invoke('list_notebooks', {})) as Array<{
      id: string
    }>
    const notebookId = notebooks[0]!.id
    const generated = resultJson(await invoke('create_notebook_cell', {
      notebook_id: notebookId,
      cell: {
        type: 'generate_image',
        label: 'gen-image',
        slot: { row: 0, column: 0 },
        prompt: 'a kitten',
      },
    })) as {
      id: string
      output_cell?: {
        id: string
        type: string
        slot: { row: number; column: number }
        inputs?: Record<string, unknown>
      }
      output_edge?: {
        source: string
        target: string
        targetInput: string
      }
    }

    expect(generated.output_cell).toBeUndefined()
    expect(generated.output_edge).toBeUndefined()
    const createdNotebook = value(engine.notebooks.read(notebookId))
    const allocated = allocateGenerateImageResult(
      engine,
      createdNotebook,
      generated.id,
      { runId: 'run-image-1', acceptedAt: '2026-08-22T00:00:00.000Z' },
    )
    expect(allocated.outputCell).toMatchObject({
      type: 'image',
      slot: { row: 0, column: 1 },
      inputs: {
        mediaRole: 'generate-image-output',
        producerCellId: generated.id,
      },
    })
    expect(allocated.outputEdge).toMatchObject({
      source: generated.id,
      target: allocated.outputCell.id,
      targetInput: 'media',
    })
    const tile = createdNotebook.cells.find((cell) => cell.id === generated.id)!
    expect(tile.outputArtifactId).toBeUndefined()
    expect(allocated.outputCell.slot).toEqual({ row: 0, column: 1 })
  })

  it('resolves generated image from output cell and legacy inline artifact', async () => {
    const defs = videobookDomainDefs(scopedBookEngine, books)
    const byName = new Map(defs.map((def) => [def.name, def]))
    const created = resultJson(await byName.get('create_book')!.handler({
      name: 'image-resolver-book',
    })) as { bookId: string }
    const managed = books.get(created.bookId)
    expect(managed.ok).toBe(true)
    if (!managed.ok) return
    const engine = managed.value.engine
    const notebook = value(engine.notebooks.read(engine.notebooks.list()[0]!.id))
    const legacyArtifact = value(await engine.artifacts.create({
      kind: 'image',
      label: 'legacy-image',
    }))
    const newArtifact = value(await engine.artifacts.create({
      kind: 'image',
      label: 'new-image',
    }))

    const legacyTile = engine.notebooks.createCell({
      type: 'generate_image',
      slot: { row: 0, column: 0 },
      prompt: 'legacy',
      outputArtifactId: legacyArtifact.artifactId,
    })
    const newTile = engine.notebooks.createCell({
      type: 'generate_image',
      slot: { row: 2, column: 0 },
      prompt: 'new style',
    })
    const outputCell = engine.notebooks.createCell({
      type: 'image',
      slot: { row: 3, column: 0 },
      outputArtifactId: newArtifact.artifactId,
      inputs: {
        mediaRole: 'generate-image-output',
        producerCellId: newTile.id,
      },
    })
    const document: NotebookDocument = {
      ...notebook,
      cells: [legacyTile, newTile, outputCell],
      edges: [
        engine.notebooks.createEdge({
          source: newTile.id,
          target: outputCell.id,
          targetInput: 'media',
        }),
      ],
    }
    value(await engine.notebooks.write(document))

    const reloaded = value(engine.notebooks.read(notebook.id))
    const legacy = reloaded.cells.find((cell) => cell.id === legacyTile.id)!
    const modern = reloaded.cells.find((cell) => cell.id === newTile.id)!
    expect(resolveNotebookCellArtifactId(reloaded, legacy)).toBe(
      legacyArtifact.artifactId,
    )
    expect(resolveNotebookCellArtifactId(reloaded, modern)).toBe(
      newArtifact.artifactId,
    )
    expect(modern.outputArtifactId).toBeUndefined()
  })

  it('does not treat completed generate_image with output-cell artifact as stale', async () => {
    const defs = videobookDomainDefs(scopedBookEngine, books)
    const byName = new Map(defs.map((def) => [def.name, def]))
    const created = resultJson(await byName.get('create_book')!.handler({
      name: 'image-stale-check',
    })) as { bookId: string }
    const managed = books.get(created.bookId)
    expect(managed.ok).toBe(true)
    if (!managed.ok) return
    const engine = managed.value.engine
    const notebook = value(engine.notebooks.read(engine.notebooks.list()[0]!.id))
    const artifact = value(await engine.artifacts.create({
      kind: 'image',
      label: 'completed-image-output',
    }))
    const tile = engine.notebooks.createCell({
      type: 'generate_image',
      slot: { row: 0, column: 0 },
      prompt: 'a kitten',
      tool: 'generate_kie_nano_banana_pro_text_to_image',
      provider: 'kie',
      model: 'NanoBananaProRequestSchema',
      operation: 'text_to_image',
    })
    const outputCell = engine.notebooks.createCell({
      type: 'image',
      slot: { row: 1, column: 0 },
      outputArtifactId: artifact.artifactId,
      inputs: {
        mediaRole: 'generate-image-output',
        producerCellId: tile.id,
        state: 'completed',
      },
    })
    const draft: NotebookDocument = {
      ...notebook,
      cells: [tile, outputCell],
      edges: [
        engine.notebooks.createEdge({
          source: tile.id,
          target: outputCell.id,
          targetInput: 'media',
        }),
      ],
    }
    const fingerprint = notebookCellFingerprint(draft, tile)
    const completed: NotebookDocument = {
      ...draft,
      execution: {
        [tile.id]: {
          fingerprint,
          status: 'completed',
          outputArtifactId: artifact.artifactId,
          completedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tool: 'generate_kie_nano_banana_pro_text_to_image',
        },
      },
    }
    value(await engine.notebooks.write(completed))
    const loaded = value(engine.notebooks.read(notebook.id))
    const liveTile = loaded.cells.find((cell) => cell.id === tile.id)!
    expect(liveTile.outputArtifactId).toBeUndefined()
    expect(resolveNotebookCellArtifactId(loaded, liveTile)).toBe(
      artifact.artifactId,
    )
    expect(notebookCellIsStale(engine, loaded, liveTile)).toBe(false)

    registerRunNotebookJob(engine)
    await setEngineRoot(rootDir, engine)
    try {
      const result = await queue.enqueueAndWait<{
        status: string
        outputs: Record<string, string>
        errors?: string[]
      }>(`run-notebook-skip-image-${tile.id}`, {
        type: 'run_notebook',
        bookId: created.bookId,
        notebookId: notebook.id,
        cellIds: [tile.id],
        force: false,
      })
      expect(result.status).toBe('completed')
      expect(result.outputs[tile.id]).toBe(artifact.artifactId)
      expect(result.errors ?? []).toEqual([])
      const after = value(engine.notebooks.read(notebook.id))
      const afterTile = after.cells.find((cell) => cell.id === tile.id)!
      expect(notebookCellIsStale(engine, after, afterTile)).toBe(false)
      expect(afterTile.outputArtifactId).toBeUndefined()
    } finally {
      await stopBookQueue(created.bookId)
    }
  })

  it('ensureGenerateImageOutput is idempotent for existing output cells', async () => {
    const defs = videobookDomainDefs(scopedBookEngine, books)
    const byName = new Map(defs.map((def) => [def.name, def]))
    const created = resultJson(await byName.get('create_book')!.handler({
      name: 'ensure-image-idempotent',
    })) as { bookId: string }
    const managed = books.get(created.bookId)
    expect(managed.ok).toBe(true)
    if (!managed.ok) return
    const engine = managed.value.engine
    const notebook = value(engine.notebooks.read(engine.notebooks.list()[0]!.id))
    const tile = engine.notebooks.createCell({
      type: 'generate_image',
      slot: { row: 0, column: 0 },
      prompt: 'kitten',
    })
    const initial: NotebookDocument = {
      ...notebook,
      cells: [tile],
      edges: [],
    }
    value(await engine.notebooks.write(initial))
    const first = ensureGenerateImageOutput(engine, initial, tile.id)
    expect(first.created).toBe(true)
    const second = ensureGenerateImageOutput(engine, first.document, tile.id)
    expect(second.created).toBe(false)
    expect(second.updated).toBe(false)
    expect(second.outputCell.id).toBe(first.outputCell.id)
  })

  it('moves inline generated images into their output cell without replacing a newer output', async () => {
    const defs = videobookDomainDefs(scopedBookEngine, books)
    const byName = new Map(defs.map((def) => [def.name, def]))
    const created = resultJson(await byName.get('create_book')!.handler({
      name: 'ensure-image-inline-output',
    })) as { bookId: string }
    const managed = books.get(created.bookId)
    expect(managed.ok).toBe(true)
    if (!managed.ok) return
    const engine = managed.value.engine
    const notebook = value(engine.notebooks.read(engine.notebooks.list()[0]!.id))
    const inlineArtifact = value(await engine.artifacts.create({
      kind: 'image',
      label: 'inline-image',
    }))
    const newerArtifact = value(await engine.artifacts.create({
      kind: 'image',
      label: 'newer-image',
    }))
    const tile = engine.notebooks.createCell({
      type: 'generate_image',
      slot: { row: 0, column: 0 },
      prompt: 'kitten',
      outputArtifactId: inlineArtifact.artifactId,
    })
    const initial: NotebookDocument = {
      ...notebook,
      cells: [tile],
      edges: [],
    }
    const first = ensureGenerateImageOutput(engine, initial, tile.id)
    expect(first.document.cells.find((cell) => cell.id === tile.id)?.outputArtifactId)
      .toBeUndefined()
    expect(first.outputCell.outputArtifactId).toBe(inlineArtifact.artifactId)
    expect(first.outputCell.inputs?.state).toBe('completed')

    const withNewerOutput: NotebookDocument = {
      ...first.document,
      cells: first.document.cells.map((cell) => {
        if (cell.id === tile.id) {
          return { ...cell, outputArtifactId: inlineArtifact.artifactId }
        }
        if (cell.id === first.outputCell.id) {
          return { ...cell, outputArtifactId: newerArtifact.artifactId }
        }
        return cell
      }),
    }
    value(await engine.notebooks.write(withNewerOutput))
    expect(await reconcileGenerationMediaOutputs(engine)).toBe(1)
    const repaired = value(engine.notebooks.read(notebook.id))
    const repairedTile = repaired.cells.find((cell) => cell.id === tile.id)
    const repairedOutput = findGenerateImageOutput(repaired, tile.id)?.outputCell
    expect(repairedTile?.outputArtifactId)
      .toBeUndefined()
    expect(repairedOutput?.outputArtifactId).toBe(newerArtifact.artifactId)
    expect(repairedOutput?.inputs?.outputVersionArtifactIds).toBeUndefined()
    const results = listGenerateImageOutputs(repaired, tile.id)
    expect(results.map((item) => item.outputCell.outputArtifactId).sort()).toEqual(
      [inlineArtifact.artifactId, newerArtifact.artifactId].sort(),
    )
    expect(await reconcileGenerationMediaOutputs(engine)).toBe(0)
  })

  it('relayouts a legacy inline generate_image into a pair and stacks video beneath it', async () => {
    const defs = videobookDomainDefs(scopedBookEngine, books)
    const byName = new Map(defs.map((def) => [def.name, def]))
    const created = resultJson(await byName.get('create_book')!.handler({
      name: 'image-relayout',
    })) as { bookId: string }
    const managed = books.get(created.bookId)
    expect(managed.ok).toBe(true)
    if (!managed.ok) return
    const engine = managed.value.engine
    const notebook = value(engine.notebooks.read(engine.notebooks.list()[0]!.id))
    const imageArtifact = value(await engine.artifacts.create({
      kind: 'image',
      label: 'legacy-gen-image',
    }))
    const videoArtifact = value(await engine.artifacts.create({
      kind: 'video',
      label: 'fed-video',
    }))
    const genImage = engine.notebooks.createCell({
      type: 'generate_image',
      label: 'legacy-image-tile',
      slot: { row: 4, column: 5 },
      prompt: 'a kitten on a freeway',
      outputArtifactId: imageArtifact.artifactId,
    })
    value(await engine.notebooks.write({
      ...notebook,
      cells: [genImage],
      edges: [],
    }))

    const migrated = await executeRelayoutNotebook(engine, {
      type: 'relayout_notebook',
      bookId: created.bookId,
      notebookId: notebook.id,
    })
    expect(migrated.changed).toBe(true)

    const afterMigrate = value(engine.notebooks.read(notebook.id))
    const tile = afterMigrate.cells.find((cell) => cell.id === genImage.id)!
    const imageOutput = findGenerateImageOutput(afterMigrate, genImage.id)
    expect(imageOutput).not.toBeNull()
    expect(tile.outputArtifactId).toBeUndefined()
    expect(imageOutput!.outputCell.outputArtifactId).toBe(imageArtifact.artifactId)
    expect(imageOutput!.outputCell.inputs?.mediaRole).toBe('generate-image-output')
    expect(imageOutput!.outputCell.inputs?.producerCellId).toBe(genImage.id)
    expect(imageOutput!.outputEdge.targetInput).toBe('media')
    expect(imageOutput!.outputCell.slot.row).toBe(tile.slot.row)
    expect(imageOutput!.outputCell.slot.column).toBe(tile.slot.column + 1)

    const genVideo = engine.notebooks.createCell({
      type: 'generate_video',
      label: 'motion',
      slot: { row: 6, column: 6 },
      prompt: 'the kitten dances',
      outputArtifactId: videoArtifact.artifactId,
    })
    value(await engine.notebooks.write({
      ...afterMigrate,
      cells: [...afterMigrate.cells, genVideo],
      edges: [
        ...afterMigrate.edges,
        engine.notebooks.createEdge({
          source: imageOutput!.outputCell.id,
          target: genVideo.id,
          targetInput: 'image',
        }),
      ],
    }))

    const first = await executeRelayoutNotebook(engine, {
      type: 'relayout_notebook',
      bookId: created.bookId,
      notebookId: notebook.id,
    })
    expect(first.changed).toBe(true)

    const after = value(engine.notebooks.read(notebook.id))
    const liveImageOutput = findGenerateImageOutput(after, genImage.id)!
    const videoTile = after.cells.find((cell) => cell.id === genVideo.id)!
    const videoOutput = findGenerateVideoOutput(after, genVideo.id)!
    expect(videoTile.outputArtifactId).toBeUndefined()
    expect(videoOutput.outputCell.outputArtifactId).toBe(videoArtifact.artifactId)
    expect(videoTile.slot.column).toBe(liveImageOutput.outputCell.slot.column)
    expect(videoTile.slot.row).toBeGreaterThan(liveImageOutput.outputCell.slot.row)
    expect(videoOutput.outputCell.slot.column).toBe(videoTile.slot.column)
    expect(videoOutput.outputCell.slot.row).toBe(videoTile.slot.row + 1)

    const again = relayoutNotebookDocument(engine, after)
    expect(notebookDocumentsEqual(after, again)).toBe(true)

    const second = await executeRelayoutNotebook(engine, {
      type: 'relayout_notebook',
      bookId: created.bookId,
      notebookId: notebook.id,
    })
    expect(second.changed).toBe(false)
  })

  it('creates generate_audio with an audio output cell to the right', async () => {
    const defs = videobookDomainDefs(scopedBookEngine, books)
    const byName = new Map(defs.map((def) => [def.name, def]))
    const created = resultJson(await byName.get('create_book')!.handler({
      name: 'directional-audio',
    })) as { bookId: string }
    const managed = books.get(created.bookId)
    expect(managed.ok).toBe(true)
    if (!managed.ok) return
    const engine = managed.value.engine

    const invoke = async (name: string, args: Record<string, unknown>) => {
      const def = byName.get(name)
      if (!def) throw new Error(`Missing ${name}`)
      return await withBookContext(
        { bookId: created.bookId, engine },
        () => def.handler({ book_id: created.bookId, ...args }),
      )
    }

    const notebooks = resultJson(await invoke('list_notebooks', {})) as Array<{
      id: string
    }>
    const notebookId = notebooks[0]!.id
    const generated = resultJson(await invoke('create_notebook_cell', {
      notebook_id: notebookId,
      cell: {
        type: 'generate_audio',
        label: 'gen-audio',
        slot: { row: 0, column: 0 },
        prompt: 'hello from the grid',
      },
    })) as {
      id: string
      output_cell?: {
        id: string
        type: string
        slot: { row: number; column: number }
        inputs?: Record<string, unknown>
      }
      output_edge?: {
        source: string
        target: string
        targetInput: string
      }
    }

    expect(generated.output_cell).toMatchObject({
      type: 'audio',
      slot: { row: 0, column: 1 },
      inputs: {
        mediaRole: 'generate-audio-output',
        producerCellId: generated.id,
      },
    })
    expect(generated.output_edge).toMatchObject({
      source: generated.id,
      target: generated.output_cell!.id,
      targetInput: 'media',
    })

    const notebook = value(engine.notebooks.read(notebookId))
    const tile = notebook.cells.find((cell) => cell.id === generated.id)!
    const output = findGenerateAudioOutput(notebook, generated.id)!
    expect(tile.outputArtifactId).toBeUndefined()
    expect(output.outputCell.slot).toEqual({ row: 0, column: 1 })
  })

  it('ensureGenerateAudioOutput is idempotent for existing output cells', async () => {
    const defs = videobookDomainDefs(scopedBookEngine, books)
    const byName = new Map(defs.map((def) => [def.name, def]))
    const created = resultJson(await byName.get('create_book')!.handler({
      name: 'ensure-audio-idempotent',
    })) as { bookId: string }
    const managed = books.get(created.bookId)
    expect(managed.ok).toBe(true)
    if (!managed.ok) return
    const engine = managed.value.engine
    const notebook = value(engine.notebooks.read(engine.notebooks.list()[0]!.id))
    const tile = engine.notebooks.createCell({
      type: 'generate_audio',
      slot: { row: 0, column: 0 },
      prompt: 'hello',
    })
    const initial: NotebookDocument = {
      ...notebook,
      cells: [tile],
      edges: [],
    }
    value(await engine.notebooks.write(initial))
    const first = ensureGenerateAudioOutput(engine, initial, tile.id)
    expect(first.created).toBe(true)
    const second = ensureGenerateAudioOutput(engine, first.document, tile.id)
    expect(second.created).toBe(false)
    expect(second.updated).toBe(false)
    expect(second.outputCell.id).toBe(first.outputCell.id)
  })

  it('relayouts a legacy inline generate_audio into a pair', async () => {
    const defs = videobookDomainDefs(scopedBookEngine, books)
    const byName = new Map(defs.map((def) => [def.name, def]))
    const created = resultJson(await byName.get('create_book')!.handler({
      name: 'audio-relayout',
    })) as { bookId: string }
    const managed = books.get(created.bookId)
    expect(managed.ok).toBe(true)
    if (!managed.ok) return
    const engine = managed.value.engine
    const notebook = value(engine.notebooks.read(engine.notebooks.list()[0]!.id))
    const audioArtifact = value(await engine.artifacts.create({
      kind: 'audio',
      label: 'legacy-gen-audio',
    }))
    const genAudio = engine.notebooks.createCell({
      type: 'generate_audio',
      label: 'legacy-audio-tile',
      slot: { row: 4, column: 5 },
      prompt: 'welcome back',
      outputArtifactId: audioArtifact.artifactId,
    })
    value(await engine.notebooks.write({
      ...notebook,
      cells: [genAudio],
      edges: [],
    }))

    const migrated = await executeRelayoutNotebook(engine, {
      type: 'relayout_notebook',
      bookId: created.bookId,
      notebookId: notebook.id,
    })
    expect(migrated.changed).toBe(true)

    const afterMigrate = value(engine.notebooks.read(notebook.id))
    const tile = afterMigrate.cells.find((cell) => cell.id === genAudio.id)!
    const audioOutput = findGenerateAudioOutput(afterMigrate, genAudio.id)
    expect(audioOutput).not.toBeNull()
    expect(tile.outputArtifactId).toBeUndefined()
    expect(audioOutput!.outputCell.outputArtifactId).toBe(audioArtifact.artifactId)
    expect(audioOutput!.outputCell.inputs?.mediaRole).toBe('generate-audio-output')
    expect(audioOutput!.outputCell.inputs?.producerCellId).toBe(genAudio.id)
    expect(audioOutput!.outputEdge.targetInput).toBe('media')
    expect(audioOutput!.outputCell.slot.row).toBe(tile.slot.row)
    expect(audioOutput!.outputCell.slot.column).toBe(tile.slot.column + 1)
  })

  it('records ensure_generate_audio_output during run-notebook preflight', async () => {
    const defs = videobookDomainDefs(scopedBookEngine, books)
    const byName = new Map(defs.map((def) => [def.name, def]))
    const created = resultJson(await byName.get('create_book')!.handler({
      name: 'audio-preflight',
    })) as { bookId: string }
    const managed = books.get(created.bookId)
    expect(managed.ok).toBe(true)
    if (!managed.ok) return
    const engine = managed.value.engine
    const notebook = value(engine.notebooks.read(engine.notebooks.list()[0]!.id))
    const tile = engine.notebooks.createCell({
      type: 'generate_audio',
      label: 'preflight-audio',
      slot: { row: 0, column: 0 },
      prompt: 'hello preflight',
    })
    value(await engine.notebooks.write({
      ...notebook,
      cells: [tile],
      edges: [],
    }))
    const before = value(engine.notebooks.read(notebook.id))
    await expect(runNotebookCell(
      engine,
      created.bookId,
      notebook.id,
      before,
      tile,
    )).rejects.toThrow()
    const operations = engine.history.revisions().map((revision) => revision.operation)
    expect(operations).toContain('ensure_generate_audio_output')
    const after = value(engine.notebooks.read(notebook.id))
    const output = findGenerateAudioOutput(after, tile.id)
    expect(output).not.toBeNull()
    expect(output!.outputCell.type).toBe('audio')
    expect(output!.outputCell.inputs?.mediaRole).toBe('generate-audio-output')
    expect(output!.outputEdge.targetInput).toBe('media')
  })
})
