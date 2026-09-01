import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type {
  NotebookCell,
  NotebookDocument,
  NotebookEdge,
} from 'videobook-engine'
import { BookManager } from '../../server/src/book-manager.js'
import {
  scopedBookEngine,
  withBookContext,
} from '../../server/src/book-context.js'
import { videobookDomainDefs } from '../../server/src/tools/videobook-domain.js'
import type { ToolDef } from '../../server/src/tools/tool-def.js'
import {
  planNotebookArrangement,
  revealNotebookArrangement,
} from '../../src/videobook/notebook-auto-arrange.js'

function cell(
  id: string,
  row: number,
  column: number,
  type: NotebookCell['type'] = 'prompt',
): NotebookCell {
  return { id, type, label: id, prompt: id, slot: { row, column } }
}

function edge(source: string, target: string, ordinal = 0): NotebookEdge {
  return {
    id: `${source}-${target}-${ordinal}`,
    source,
    target,
    targetInput: `input-${ordinal}`,
  }
}

function document(
  cells: NotebookCell[],
  edges: NotebookEdge[] = [],
): NotebookDocument {
  return {
    id: 'notebook',
    name: 'Auto arrange',
    cells,
    edges,
    createdAt: '2026-08-18T00:00:00.000Z',
  }
}

function assignmentMap(
  value: ReturnType<typeof planNotebookArrangement>,
): Map<string, { row: number; column: number }> {
  expect(value.ok, value.ok ? undefined : value.message).toBe(true)
  if (!value.ok) return new Map()
  return new Map(value.slots.map(({ id, row, column }) => [
    id,
    { row, column },
  ]))
}

function applyAssignments(
  source: NotebookDocument,
  assignments: ReadonlyMap<string, { row: number; column: number }>,
): NotebookDocument {
  return {
    ...source,
    cells: source.cells.map((item) => ({
      ...item,
      slot: assignments.get(item.id) ?? item.slot,
    })),
  }
}

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

describe('notebook type-band auto-arrange', () => {
  it('puts images on row 0, videos on row 2, and other cells on row 1', () => {
    const source = document([
      cell('vid-b', 8, 11, 'video'),
      cell('img-b', 4, 10, 'image'),
      cell('prompt', 2, 3),
      cell('img-a', 1, 9, 'image'),
      cell('vid-a', 7, 1, 'video'),
      cell('gen', 12, 0, 'generate_video'),
    ])
    const planned = planNotebookArrangement(source)
    const slots = assignmentMap(planned)

    expect(planned.ok && planned.rowCount).toBe(3)
    expect(slots.get('img-a')).toEqual({ row: 0, column: 0 })
    expect(slots.get('img-b')).toEqual({ row: 0, column: 1 })
    expect(slots.get('prompt')).toEqual({ row: 1, column: 0 })
    expect(slots.get('gen')).toEqual({ row: 1, column: 1 })
    expect(slots.get('vid-a')).toEqual({ row: 2, column: 0 })
    expect(slots.get('vid-b')).toEqual({ row: 2, column: 1 })
  })

  it('keeps leftover image and video columns empty so other cells stay off those rows', () => {
    const source = document([
      cell('img', 5, 5, 'image'),
      cell('prompt', 0, 0),
      cell('vid', 9, 9, 'video'),
    ])
    const slots = assignmentMap(planNotebookArrangement(source))

    expect(slots.get('img')).toEqual({ row: 0, column: 0 })
    expect(slots.get('prompt')).toEqual({ row: 1, column: 0 })
    expect(slots.get('vid')).toEqual({ row: 2, column: 0 })
  })

  it('is idempotent after the first arrange', () => {
    const source = document([
      cell('img', 8, 1, 'image'),
      cell('left', 4, 6),
      cell('right', 2, 3, 'generate_image'),
      cell('vid', 1, 7, 'video'),
    ])
    const first = planNotebookArrangement(source)
    const slots = assignmentMap(first)
    const arranged = applyAssignments(source, slots)
    expect(planNotebookArrangement(arranged)).toEqual(first)
  })

  it('wraps extra images onto row 3 instead of the other or video rows', () => {
    const images = Array.from({ length: 9 }, (_, index) =>
      cell(
        `img-${String(index).padStart(2, '0')}`,
        index < 8 ? 10 : 11,
        index % 8,
        'image',
      ))
    const source = document([
      ...images,
      cell('prompt', 0, 0),
      cell('vid', 1, 0, 'video'),
    ])
    const slots = assignmentMap(planNotebookArrangement(source))

    for (let index = 0; index < 8; index += 1) {
      expect(slots.get(images[index]!.id)).toEqual({ row: 0, column: index })
    }
    expect(slots.get('img-08')).toEqual({ row: 3, column: 0 })
    expect(slots.get('prompt')).toEqual({ row: 1, column: 0 })
    expect(slots.get('vid')).toEqual({ row: 2, column: 0 })
  })

  it('gives extra videos the next overflow slot after extra images', () => {
    const images = Array.from({ length: 9 }, (_, index) =>
      cell(
        `img-${String(index).padStart(2, '0')}`,
        index < 8 ? 4 : 5,
        index % 8,
        'image',
      ))
    const videos = Array.from({ length: 9 }, (_, index) =>
      cell(
        `vid-${String(index).padStart(2, '0')}`,
        index < 8 ? 6 : 7,
        index % 8,
        'video',
      ))
    const slots = assignmentMap(planNotebookArrangement(document([
      ...images,
      ...videos,
      cell('prompt', 5, 5),
    ])))

    expect(slots.get('img-08')).toEqual({ row: 3, column: 0 })
    for (let index = 0; index < 8; index += 1) {
      expect(slots.get(videos[index]!.id)).toEqual({ row: 2, column: index })
    }
    expect(slots.get('vid-08')).toEqual({ row: 3, column: 1 })
    expect(slots.get('prompt')).toEqual({ row: 1, column: 0 })
  })

  it('packs other cells on row 1 then overflow, using the full 8 columns', () => {
    const others = Array.from({ length: 10 }, (_, index) =>
      cell(
        `cell-${String(index).padStart(2, '0')}`,
        index < 8 ? 6 : 7,
        index % 8,
      ))
    const planned = planNotebookArrangement(document(others))
    const slots = assignmentMap(planned)

    expect(planned.ok && planned.rowCount).toBe(4)
    for (let index = 0; index < 8; index += 1) {
      expect(slots.get(others[index]!.id)).toEqual({ row: 1, column: index })
    }
    expect(slots.get('cell-08')).toEqual({ row: 3, column: 0 })
    expect(slots.get('cell-09')).toEqual({ row: 3, column: 1 })
    expect([...slots.values()].every((slot) =>
      slot.row >= 0 && slot.row < 64 && slot.column >= 0 && slot.column <= 7))
      .toBe(true)
  })

  it('ignores edges including cycles and missing endpoints', () => {
    const cyclic = planNotebookArrangement(document(
      [cell('img', 9, 9, 'image'), cell('vid', 1, 1, 'video')],
      [edge('img', 'vid'), edge('vid', 'img')],
    ))
    const slots = assignmentMap(cyclic)
    expect(slots.get('img')).toEqual({ row: 0, column: 0 })
    expect(slots.get('vid')).toEqual({ row: 2, column: 0 })

    const missing = planNotebookArrangement(document(
      [cell('a', 0, 0, 'image')],
      [edge('a', 'missing')],
    ))
    expect(assignmentMap(missing).get('a')).toEqual({ row: 0, column: 0 })
  })

  it('rejects duplicate cell ids', () => {
    const duplicate = planNotebookArrangement(document(
      [cell('a', 0, 0), cell('a', 0, 1)],
    ))
    expect(duplicate).toMatchObject({ ok: false, code: 'invalid-edge' })
    expect(!duplicate.ok && duplicate.message).toContain('duplicate cell IDs')
  })

  it('fills other-only cells through overflow and rejects one cell more', () => {
    const otherCapacity = 512 - 16
    const full = Array.from({ length: otherCapacity }, (_, index) =>
      cell(
        `cell-${String(index).padStart(3, '0')}`,
        63 - Math.floor(index / 8),
        7 - index % 8,
      ))
    const planned = planNotebookArrangement(document(full))
    const slots = assignmentMap(planned)
    const keys = new Set([...slots.values()].map((slot) => `${slot.row}:${slot.column}`))
    const occupiedRows = new Set([...slots.values()].map((slot) => slot.row))

    expect(planned.ok && planned.rowCount).toBe(64)
    expect(slots.size).toBe(otherCapacity)
    expect(keys.size).toBe(otherCapacity)
    expect(occupiedRows.has(0)).toBe(false)
    expect(occupiedRows.has(2)).toBe(false)
    expect([...slots.values()].every((slot) =>
      slot.row >= 0 && slot.row < 64 && slot.column >= 0 && slot.column <= 7))
      .toBe(true)

    const overflow = planNotebookArrangement(document(
      Array.from({ length: otherCapacity + 1 }, (_, index) =>
        cell(`cell-${String(index).padStart(3, '0')}`, index % 64, index % 8)),
    ))
    expect(overflow).toMatchObject({ ok: false, code: 'capacity' })
    expect(!overflow.ok && overflow.message).toContain('needs 65 rows')
    expect(!overflow.ok && overflow.message).toContain('supports 64')
  })

  it('waits for refreshed layout before revealing the upper-left', () => {
    const frames: FrameRequestCallback[] = []
    const scrolls: ScrollToOptions[] = []
    const target = {
      scrollTo: (options: ScrollToOptions) => scrolls.push(options),
    }

    revealNotebookArrangement(
      () => target,
      (callback) => {
        frames.push(callback)
        return frames.length
      },
    )

    expect(scrolls).toEqual([])
    frames.shift()?.(0)
    expect(scrolls).toEqual([])
    frames.shift()?.(16)
    expect(scrolls).toEqual([{
      left: 0,
      top: 0,
      behavior: 'smooth',
    }])
  })

  it('persists the complete layout through the real notebook move mutation', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'videobook-auto-arrange-'))
    const books = new BookManager({
      libraryDir: join(rootDir, 'books'),
      objectPrefix: 'test-objects',
    })
    try {
      await books.ready()
      const defs = videobookDomainDefs(scopedBookEngine, books)
      const byName = new Map(defs.map((def) => [def.name, def]))
      const created = resultJson(await byName.get('create_book')!.handler({
        name: 'auto-arrange',
      })) as { bookId: string }
      const managed = books.get(created.bookId)
      expect(managed.ok).toBe(true)
      if (!managed.ok) return
      const engine = managed.value.engine
      const initial = value(engine.notebooks.read(engine.notebooks.list()[0]!.id))
      const image = engine.notebooks.createCell({
        type: 'image',
        label: 'image',
        prompt: 'image prompt',
        slot: { row: 8, column: 1 },
      })
      const prompt = engine.notebooks.createCell({
        type: 'prompt',
        label: 'prompt',
        prompt: 'prompt text',
        slot: { row: 5, column: 6 },
      })
      const video = engine.notebooks.createCell({
        type: 'video',
        label: 'video',
        prompt: 'video prompt',
        slot: { row: 2, column: 3 },
      })
      value(await engine.notebooks.write({
        ...initial,
        cells: [image, prompt, video],
        edges: [],
      }))
      const before = value(engine.notebooks.read(initial.id))
      const planned = planNotebookArrangement(before)
      expect(planned.ok).toBe(true)
      if (!planned.ok) return
      expect(assignmentMap(planned)).toEqual(new Map([
        [image.id, { row: 0, column: 0 }],
        [prompt.id, { row: 1, column: 0 }],
        [video.id, { row: 2, column: 0 }],
      ]))

      resultJson(await withBookContext(
        { bookId: created.bookId, engine },
        () => byName.get('move_notebook_cells')!.handler({
          book_id: created.bookId,
          notebook_id: initial.id,
          expected_revision: engine.head,
          slots: planned.slots,
        }),
      ))
      const after = value(engine.notebooks.read(initial.id))
      const withoutSlots = (items: NotebookCell[]) => items
        .map(({ slot: _slot, ...item }) => item)
        .sort((leftItem, rightItem) => leftItem.id.localeCompare(rightItem.id))
      const persistedSlots = after.cells
        .map((item) => ({ id: item.id, slot: item.slot }))
        .sort((leftItem, rightItem) => leftItem.id.localeCompare(rightItem.id))
      const plannedSlots = planned.slots
        .map(({ id, row, column }) => ({ id, slot: { row, column } }))
        .sort((leftItem, rightItem) => leftItem.id.localeCompare(rightItem.id))

      expect(persistedSlots).toEqual(plannedSlots)
      expect(withoutSlots(after.cells)).toEqual(withoutSlots(before.cells))
      expect(after.edges).toEqual(before.edges)
    } finally {
      await books.close()
      await rm(rootDir, { recursive: true, force: true, maxRetries: 3 })
    }
  })
})
