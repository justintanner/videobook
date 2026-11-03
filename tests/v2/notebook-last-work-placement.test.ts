import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NotebookCellType, NotebookDocument } from 'videobook-engine'
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
import { notebookCreationPlacement } from '../../src/videobook/notebook-grid.js'

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

  it('places each new tile in its lane so the board already matches Clean', async () => {
    const defs = videobookDomainDefs(scopedBookEngine, books)
    const byName = new Map(defs.map((def) => [def.name, def]))
    const created = resultJson(await byName.get('create_book')!.handler({
      name: 'lane-placement',
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
    const place = async (type: NotebookCellType, label: string) => {
      const placement = notebookCreationPlacement(type, value(engine.notebooks.read(notebookId)).cells)
      const cell = resultJson(await invoke('create_notebook_cell', {
        notebook_id: notebookId,
        ...(placement.makeRoom ? { make_room: true } : {}),
        cell: { type, label, slot: placement.slot, ...(type.startsWith('generate_') ? { prompt: '' } : {}) },
      })) as { id: string; output_cell?: { id: string } }
      return { ...cell, placement }
    }
    const slotOf = (id: string) => value(engine.notebooks.read(notebookId)).cells.find((cell) => cell.id === id)?.slot

    const source = await place('video', 'source')
    expect(source.placement).toEqual({ slot: { row: 0, column: 0 }, makeRoom: false })
    const image = await place('generate_image', 'gen-image')
    expect(image.placement).toEqual({ slot: { row: 1, column: 0 }, makeRoom: false })
    const audio = await place('generate_audio', 'gen-audio')
    expect(audio.placement).toEqual({ slot: { row: 1, column: 1 }, makeRoom: false })
    expect(slotOf(audio.output_cell!.id)).toEqual({ row: 2, column: 0 })
    const frame = await place('image', 'frame')
    expect(frame.placement).toEqual({ slot: { row: 2, column: 0 }, makeRoom: true })
    expect(slotOf(audio.output_cell!.id)).toEqual({ row: 3, column: 0 })
    const video = await place('generate_video', 'gen-video')
    expect(video.placement).toEqual({ slot: { row: 1, column: 2 }, makeRoom: false })
    const secondSource = await place('video', 'second-source')
    expect(secondSource.placement).toEqual({ slot: { row: 0, column: 1 }, makeRoom: false })

    const notebook = value(engine.notebooks.read(notebookId))
    expect(findGenerateImageOutput(notebook, image.id)).toBeNull()
    expect(findGenerateVideoOutput(notebook, video.id)).toBeNull()
    expect(findGenerateAudioOutput(notebook, audio.id)?.outputCell.slot).toEqual({ row: 3, column: 0 })
    expect(notebookDocumentsEqual(notebook, relayoutNotebookDocument(engine, notebook))).toBe(true)
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
        slot: { row: 12, column: 4 },
      },
    }))

    const analyze = resultJson(await invoke('create_notebook_cell', {
      notebook_id: notebookId,
      cell: {
        type: 'analyze',
        label: 'analyze-far',
        slot: { row: 12, column: 5 },
        prompt: 'segment',
      },
    })) as {
      id: string
      output_cell?: { slot: { row: number; column: number } }
    }
    expect(analyze.output_cell?.slot).not.toEqual({ row: 0, column: 0 })
    expect(analyze.output_cell?.slot).toEqual({ row: 12, column: 6 })

    const withFar = value(engine.notebooks.read(notebookId))
    const scaffold = buildSevenStageScaffold(engine, withFar)
    const newSlots = scaffold.cells
      .filter((cell) => !withFar.cells.some((existing) => existing.id === cell.id))
      .map((cell) => cell.slot)
    expect(newSlots.length).toBeGreaterThan(0)
    expect(newSlots.every((slot) => slot.row >= 12 || slot.column >= 4)).toBe(true)
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
