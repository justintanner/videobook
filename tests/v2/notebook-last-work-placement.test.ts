import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NotebookDocument } from 'videobook-engine'
import { BookManager } from '../../server/src/book-manager.js'
import { scopedBookEngine, withBookContext } from '../../server/src/book-context.js'
import {
  findGenerateAudioOutput,
  findGenerateImageOutput,
  findGenerateVideoOutput,
} from '../../server/src/notebook-cell-outputs.js'
import {
  lastCreatedCellSlot,
} from '../../server/src/notebook-placement.js'
import {
  notebookDocumentsEqual,
  relayoutNotebookDocument,
} from '../../server/src/notebook-relayout.js'
import { buildSevenStageScaffold } from '../../server/src/notebook-workflow.js'
import { videobookDomainDefs } from '../../server/src/tools/videobook-domain.js'
import type { ToolDef } from '../../server/src/tools/tool-def.js'
import {
  allocateNotebookHorizontalGenerationSlots,
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

describe('last-work placement', () => {
  let rootDir: string
  let books: BookManager

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-last-work-'))
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

  it('uses last-created UUIDv7 as the empty-source last-work proxy', () => {
    expect(lastCreatedCellSlot([])).toBeNull()
    const earlier = {
      id: '01900000-0000-7000-8000-000000000001',
      slot: { row: 2, column: 1 },
    }
    const later = {
      id: '01900000-0000-7000-8000-000000000099',
      slot: { row: 11, column: 8 },
    }
    expect(lastCreatedCellSlot([earlier, later])).toEqual(later.slot)
    expect(lastCreatedCellSlot([later, earlier])).toEqual(later.slot)
  })

  it('places image/audio right, video below, repeats, edges, sources, and relayout', async () => {
    const defs = videobookDomainDefs(scopedBookEngine, books)
    const byName = new Map(defs.map((def) => [def.name, def]))
    const created = resultJson(await byName.get('create_book')!.handler({
      name: 'last-work-placement',
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

    const originImage = resultJson(await invoke('create_notebook_cell', {
      notebook_id: notebookId,
      cell: {
        type: 'generate_image',
        label: 'origin-image',
        slot: { row: 0, column: 0 },
        prompt: 'origin kitten',
      },
    })) as { id: string; output_cell?: { slot: { row: number; column: number } } }
    expect(originImage.output_cell?.slot).toEqual({ row: 0, column: 1 })
    const originDoc = value(engine.notebooks.read(notebookId))
    expect(notebookDocumentsEqual(originDoc, relayoutNotebookDocument(engine, originDoc)))
      .toBe(true)

    const lastWork = { row: 8, column: 6 }
    resultJson(await invoke('create_notebook_cell', {
      notebook_id: notebookId,
      cell: {
        type: 'prompt',
        label: 'last-work',
        slot: lastWork,
        prompt: 'anchor',
      },
    }))

    const imageSlots = allocateNotebookHorizontalGenerationSlots(
      [{ type: 'prompt', slot: lastWork }],
      [],
      lastWork,
    )
    expect(imageSlots).toEqual({
      tile: { row: 8, column: 7 },
      output: { row: 8, column: 8 },
    })
    const image = resultJson(await invoke('create_notebook_cell', {
      notebook_id: notebookId,
      cell: {
        type: 'generate_image',
        label: 'gen-image',
        slot: imageSlots.tile,
        prompt: 'a kitten',
      },
    })) as { id: string; output_cell?: { id: string; slot: { row: number; column: number } } }
    expect(image.output_cell?.slot).toEqual(imageSlots.output)

    const afterImage = value(engine.notebooks.read(notebookId))
    const imageRepeat = allocateNotebookHorizontalGenerationSlots(
      afterImage.cells,
      [],
      lastWork,
    )
    expect(imageRepeat.tile.row).toBe(8)
    expect(imageRepeat.tile.column).toBeGreaterThan(imageSlots.output.column)
    const imageTwo = resultJson(await invoke('create_notebook_cell', {
      notebook_id: notebookId,
      cell: {
        type: 'generate_image',
        label: 'gen-image-2',
        slot: imageRepeat.tile,
        prompt: 'another kitten',
      },
    })) as { id: string; output_cell?: { slot: { row: number; column: number } } }
    expect(imageTwo.output_cell?.slot).toEqual(imageRepeat.output)

    const audioSlots = allocateNotebookHorizontalGenerationSlots(
      value(engine.notebooks.read(notebookId)).cells,
      [],
      lastWork,
    )
    const audio = resultJson(await invoke('create_notebook_cell', {
      notebook_id: notebookId,
      cell: {
        type: 'generate_audio',
        label: 'gen-audio',
        slot: audioSlots.tile,
        prompt: 'hello',
      },
    })) as { id: string; output_cell?: { slot: { row: number; column: number } } }
    expect(audio.output_cell?.slot).toEqual(audioSlots.output)
    expect(audio.output_cell?.slot.row).toBe(audioSlots.tile.row)
    expect(audio.output_cell!.slot.column).toBeGreaterThan(audioSlots.tile.column)

    const videoSlots = allocateNotebookVideoGenerationSlots(
      value(engine.notebooks.read(notebookId)).cells,
      [],
      lastWork,
    )
    expect(videoSlots.tile.column).toBe(lastWork.column)
    expect(videoSlots.tile.row).toBeGreaterThan(lastWork.row)
    const video = resultJson(await invoke('create_notebook_cell', {
      notebook_id: notebookId,
      cell: {
        type: 'generate_video',
        label: 'gen-video',
        slot: videoSlots.tile,
        prompt: 'a cat walks',
      },
    })) as { id: string; output_cell?: { slot: { row: number; column: number } } }
    expect(video.output_cell?.slot).toEqual(videoSlots.output)
    expect(video.output_cell?.slot.column).toBe(videoSlots.tile.column)
    expect(video.output_cell!.slot.row).toBeGreaterThan(videoSlots.tile.row)

    const beforeRelayout = value(engine.notebooks.read(notebookId))
    const createdLayout: NotebookDocument = {
      ...beforeRelayout,
      cells: beforeRelayout.cells.filter((cell) => cell.type !== 'prompt'),
    }
    expect(notebookDocumentsEqual(
      createdLayout,
      relayoutNotebookDocument(engine, createdLayout),
    )).toBe(true)

    const source = resultJson(await invoke('create_notebook_cell', {
      notebook_id: notebookId,
      cell: {
        type: 'image',
        label: 'source-image',
        slot: { row: 3, column: 2 },
      },
    })) as { id: string }
    const sourceFedTile = nextNotebookHorizontalGenerationSlot(
      value(engine.notebooks.read(notebookId)).cells,
      [{ row: 3, column: 2 }],
      lastWork,
    )
    expect(sourceFedTile).toEqual({ row: 3, column: 3 })
    const sourceFed = resultJson(await invoke('create_notebook_cell', {
      notebook_id: notebookId,
      cell: {
        type: 'generate_image',
        label: 'from-source',
        slot: sourceFedTile,
        prompt: 'based on source',
      },
    })) as { id: string; output_cell?: { slot: { row: number; column: number } } }
    expect(sourceFed.output_cell?.slot).toEqual({ row: 3, column: 4 })
    resultJson(await invoke('connect_notebook_cells', {
      notebook_id: notebookId,
      source_cell_id: source.id,
      target_cell_id: sourceFed.id,
      target_input: 'image',
    }))
    expect(nextNotebookVideoGenerationSlot(
      value(engine.notebooks.read(notebookId)).cells,
      [{ row: 3, column: 2 }],
      lastWork,
    )).toEqual({ row: 4, column: 2 })

    const edgeImage = resultJson(await invoke('create_notebook_cell', {
      notebook_id: notebookId,
      cell: {
        type: 'generate_image',
        label: 'edge-image',
        slot: { row: 0, column: 12 },
        prompt: 'edge',
      },
    })) as { output_cell?: { slot: { row: number; column: number } } }
    expect(edgeImage.output_cell?.slot).toEqual({ row: 1, column: 12 })

    const edgeVideo = resultJson(await invoke('create_notebook_cell', {
      notebook_id: notebookId,
      cell: {
        type: 'generate_video',
        label: 'edge-video',
        slot: { row: 25, column: 0 },
        prompt: 'edge walk',
      },
    })) as { output_cell?: { slot: { row: number; column: number } } }
    expect(edgeVideo.output_cell?.slot).toEqual({ row: 25, column: 1 })

    const notebook = value(engine.notebooks.read(notebookId))
    expect(findGenerateImageOutput(notebook, image.id)?.outputCell.slot)
      .toEqual(imageSlots.output)
    expect(findGenerateAudioOutput(notebook, audio.id)?.outputCell.slot)
      .toEqual(audioSlots.output)
    expect(findGenerateVideoOutput(notebook, video.id)?.outputCell.slot)
      .toEqual(videoSlots.output)
    expect(notebook.cells.every((cell) =>
      cell.slot.row >= 0
      && cell.slot.row <= 25
      && cell.slot.column >= 0
      && cell.slot.column <= 12)).toBe(true)
    const occupiedKeys = notebook.cells.map((cell) =>
      `${cell.slot.row}:${cell.slot.column}`)
    expect(new Set(occupiedKeys).size).toBe(occupiedKeys.length)
  })

  it('places analyze output and workflow scaffolds next to existing work', async () => {
    const defs = videobookDomainDefs(scopedBookEngine, books)
    const byName = new Map(defs.map((def) => [def.name, def]))
    const created = resultJson(await byName.get('create_book')!.handler({
      name: 'server-anchor',
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
    resultJson(await invoke('create_notebook_cell', {
      notebook_id: notebookId,
      cell: {
        type: 'video',
        label: 'far-source',
        slot: { row: 12, column: 8 },
      },
    }))

    const analyze = resultJson(await invoke('create_notebook_cell', {
      notebook_id: notebookId,
      cell: {
        type: 'analyze',
        label: 'analyze-far',
        slot: { row: 12, column: 9 },
        prompt: 'segment',
      },
    })) as {
      id: string
      output_cell?: { slot: { row: number; column: number } }
    }
    expect(analyze.output_cell?.slot).not.toEqual({ row: 0, column: 0 })
    expect(analyze.output_cell?.slot).toEqual({ row: 12, column: 10 })

    const withFar = value(engine.notebooks.read(notebookId))
    const scaffold = buildSevenStageScaffold(engine, withFar)
    const newSlots = scaffold.cells
      .filter((cell) => !withFar.cells.some((existing) => existing.id === cell.id))
      .map((cell) => cell.slot)
    expect(newSlots.length).toBeGreaterThan(0)
    expect(newSlots.every((slot) => slot.row >= 12 || slot.column >= 8)).toBe(true)
    expect(newSlots.some((slot) => slot.row === 0 && slot.column === 0)).toBe(false)

    const empty = {
      ...withFar,
      cells: [],
      edges: [],
    } satisfies NotebookDocument
    const emptyScaffold = buildSevenStageScaffold(engine, empty)
    expect(emptyScaffold.cells.some((cell) =>
      cell.slot.row === 0 && cell.slot.column === 0)).toBe(true)
  })
})
