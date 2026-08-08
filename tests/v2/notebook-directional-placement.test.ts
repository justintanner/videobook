import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  resolveGeneratedVideoArtifact,
  type NotebookDocument,
} from 'videobook-engine'
import { BookManager } from '../../server/src/book-manager.js'
import { scopedBookEngine, withBookContext } from '../../server/src/book-context.js'
import {
  ensureGenerateVideoOutput,
  findGenerateVideoOutput,
} from '../../server/src/notebook-cell-outputs.js'
import {
  notebookDocumentsEqual,
  relayoutNotebookDocument,
} from '../../server/src/notebook-relayout.js'
import { executeRelayoutNotebook } from '../../server/src/jobs/relayout-notebook.js'
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

  it('stacks video tiles vertically and image work horizontally near origin', () => {
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
    const second = allocateNotebookVideoGenerationSlots([
      ...images,
      { type: 'generate_video', slot: first.tile },
      { type: 'video', slot: first.output },
    ])
    expect(second.tile.column).toBe(0)
    expect(second.tile.row).toBeGreaterThan(first.output.row)
    expect(second.output.column).toBe(0)
    expect(second.tile.column).toBeLessThan(9)

    expect(nextNotebookHorizontalGenerationSlot(
      [{ type: 'video', slot: { row: 2, column: 0 } }],
      [{ row: 2, column: 0 }],
    )).toEqual({ row: 2, column: 1 })

    expect(nextNotebookVideoGenerationSlot([
      { type: 'generate_video', slot: { row: 0, column: 0 } },
      { type: 'video', slot: { row: 1, column: 0 } },
      { type: 'generate_video', slot: { row: 2, column: 0 } },
      { type: 'video', slot: { row: 3, column: 0 } },
    ])).toEqual({ row: 4, column: 0 })
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

    expect(generated.output_cell).toMatchObject({
      type: 'video',
      slot: { row: 1, column: 0 },
      inputs: {
        mediaRole: 'generate-video-output',
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
    const output = findGenerateVideoOutput(notebook, generated.id)!
    expect(tile.outputArtifactId).toBeUndefined()
    expect(output.outputCell.slot).toEqual({ row: 1, column: 0 })
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
      { row: 1, column: 8 },
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
      type: 'extract_frame',
      label: 'frame-a',
      slot: { row: 0, column: 4 },
      inputs: { frameMode: 'first' },
    })
    const imageA = engine.notebooks.createCell({
      type: 'image',
      label: 'frame-a out',
      slot: { row: 0, column: 5 },
      inputs: {
        mediaRole: 'extract-frame-output',
        producerCellId: extractA.id,
        frameMode: 'first',
        frameSelectionKey: `${generateVideos[2]!.id}:first:frame`,
        sourceCellId: generateVideos[2]!.id,
      },
    })
    const extractB = engine.notebooks.createCell({
      type: 'extract_frame',
      label: 'frame-b',
      slot: { row: 2, column: 2 },
      inputs: { frameMode: 'first' },
    })
    const imageB = engine.notebooks.createCell({
      type: 'image',
      label: 'frame-b out',
      slot: { row: 2, column: 3 },
      inputs: {
        mediaRole: 'extract-frame-output',
        producerCellId: extractB.id,
        frameMode: 'first',
        frameSelectionKey: `${generateVideos[3]!.id}:first:frame`,
        sourceCellId: generateVideos[3]!.id,
      },
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
        targetInput: 'video',
      }),
      engine.notebooks.createEdge({
        source: extractA.id,
        target: imageA.id,
        targetInput: 'media',
      }),
      engine.notebooks.createEdge({
        source: generateVideos[3]!.id,
        target: extractB.id,
        targetInput: 'video',
      }),
      engine.notebooks.createEdge({
        source: extractB.id,
        target: imageB.id,
        targetInput: 'media',
      }),
    ]

    const originalEdgeCount = edges.length
    value(await engine.notebooks.write({
      ...notebook,
      cells: [
        ...images,
        ...generateVideos,
        extractA,
        imageA,
        extractB,
        imageB,
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
      .filter((cell) =>
        cell.type === 'image' && cell.inputs?.mediaRole !== 'extract-frame-output')
      .sort((left, right) => left.slot.column - right.slot.column)
    expect(sourceImages.map((cell) => cell.slot)).toEqual([
      { row: 0, column: 0 },
      { row: 0, column: 1 },
      { row: 0, column: 2 },
      { row: 0, column: 3 },
    ])

    for (const extract of after.cells.filter((cell) => cell.type === 'extract_frame')) {
      const sourceEdge = after.edges.find((edge) =>
        edge.target === extract.id && edge.targetInput === 'video')
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
})
