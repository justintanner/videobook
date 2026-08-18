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
  planNotebookCausalPyramid,
  revealNotebookCausalPyramid,
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
  value: ReturnType<typeof planNotebookCausalPyramid>,
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

describe('notebook causal pyramid auto-arrange', () => {
  it('centers deterministic causal layers and keeps every edge moving downward', () => {
    const source = document(
      [
        cell('root', 8, 1),
        cell('left', 4, 10),
        cell('right', 2, 3),
        cell('sink', 1, 11),
      ],
      [
        edge('root', 'left'),
        edge('root', 'right'),
        edge('left', 'sink'),
        edge('right', 'sink'),
      ],
    )
    const first = planNotebookCausalPyramid(source)
    const slots = assignmentMap(first)

    expect(slots.get('root')).toEqual({ row: 0, column: 6 })
    expect(slots.get('right')).toEqual({ row: 1, column: 5 })
    expect(slots.get('left')).toEqual({ row: 1, column: 7 })
    expect(slots.get('sink')).toEqual({ row: 2, column: 6 })
    for (const connection of source.edges) {
      expect(slots.get(connection.source)!.row)
        .toBeLessThan(slots.get(connection.target)!.row)
    }

    const arranged = applyAssignments(source, slots)
    expect(planNotebookCausalPyramid(arranged)).toEqual(first)
  })

  it('balances causal layers wider than the grid across centered rows', () => {
    const children = Array.from({ length: 14 }, (_, index) =>
      cell(`child-${String(index).padStart(2, '0')}`, 12 - index % 10, index % 13))
    const sink = cell('sink', 20, 12)
    const source = document(
      [cell('root', 15, 0), ...children, sink],
      [
        ...children.map((item, index) => edge('root', item.id, index)),
        ...children.map((item, index) => edge(item.id, sink.id, index)),
      ],
    )
    const planned = planNotebookCausalPyramid(source)
    const slots = assignmentMap(planned)
    const childRows = new Map<number, NotebookCell[]>()
    for (const item of children) {
      const row = slots.get(item.id)!.row
      childRows.set(row, [...(childRows.get(row) ?? []), item])
    }
    const rows = [...childRows.keys()].sort((left, right) => left - right)

    expect(planned.ok && planned.rowCount).toBe(4)
    expect(rows).toEqual([1, 2])
    expect(rows.map((row) => childRows.get(row)!.length)).toEqual([7, 7])
    for (const row of rows) {
      expect(children
        .map((item) => slots.get(item.id)!)
        .filter((slot) => slot.row === row)
        .map((slot) => slot.column)
        .sort((left, right) => left - right))
        .toEqual([3, 4, 5, 6, 7, 8, 9])
    }
    expect(slots.get('root')).toEqual({ row: 0, column: 6 })
    expect(slots.get('sink')).toEqual({ row: 3, column: 6 })
  })

  it('places unconnected tiles in a centered bottom band', () => {
    const source = document(
      [
        cell('root', 8, 8),
        cell('child', 4, 4),
        cell('loose-a', 9, 9),
        cell('loose-b', 3, 1),
        cell('loose-c', 6, 5),
      ],
      [edge('root', 'child')],
    )
    const planned = planNotebookCausalPyramid(source)
    const slots = assignmentMap(planned)

    expect(planned.ok && planned.rowCount).toBe(4)
    expect(slots.get('root')).toEqual({ row: 0, column: 6 })
    expect(slots.get('child')).toEqual({ row: 1, column: 6 })
    expect([
      slots.get('loose-b'),
      slots.get('loose-c'),
      slots.get('loose-a'),
    ]).toEqual([
      { row: 3, column: 5 },
      { row: 3, column: 6 },
      { row: 3, column: 7 },
    ])
  })

  it('fits a full disconnected grid without an unnecessary spacer', () => {
    const cells = Array.from({ length: 338 }, (_, index) =>
      cell(`cell-${String(index).padStart(3, '0')}`, 25 - Math.floor(index / 13), 12 - index % 13))
    const planned = planNotebookCausalPyramid(document(cells))
    const slots = assignmentMap(planned)
    const keys = new Set([...slots.values()].map((slot) => `${slot.row}:${slot.column}`))

    expect(planned.ok && planned.rowCount).toBe(26)
    expect(slots.size).toBe(338)
    expect(keys.size).toBe(338)
    expect([...slots.values()].every((slot) =>
      slot.row >= 0 && slot.row < 26 && slot.column >= 0 && slot.column < 13))
      .toBe(true)
  })

  it('rejects cycles, missing cells, and layouts that exceed 26 rows', () => {
    const cyclic = planNotebookCausalPyramid(document(
      [cell('a', 0, 0), cell('b', 0, 1)],
      [edge('a', 'b'), edge('b', 'a')],
    ))
    expect(cyclic).toMatchObject({ ok: false, code: 'cycle' })

    const missing = planNotebookCausalPyramid(document(
      [cell('a', 0, 0)],
      [edge('a', 'missing')],
    ))
    expect(missing).toMatchObject({ ok: false, code: 'invalid-edge' })

    const chain = Array.from({ length: 27 }, (_, index) =>
      cell(`chain-${String(index).padStart(2, '0')}`, index % 26, index % 13))
    const overflow = planNotebookCausalPyramid(document(
      chain,
      chain.slice(1).map((item, index) => edge(chain[index]!.id, item.id)),
    ))
    expect(overflow).toMatchObject({ ok: false, code: 'capacity' })
  })

  it('waits for refreshed layout before revealing the centered apex', () => {
    const frames: FrameRequestCallback[] = []
    const scrolls: ScrollToOptions[] = []
    const target = {
      clientWidth: 1000,
      scrollTo: (options: ScrollToOptions) => scrolls.push(options),
    }

    revealNotebookCausalPyramid(
      () => target,
      1800,
      0.5,
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
      left: 400,
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
      const root = engine.notebooks.createCell({
        type: 'prompt',
        label: 'root',
        prompt: 'root prompt',
        slot: { row: 8, column: 1 },
      })
      const left = engine.notebooks.createCell({
        type: 'prompt',
        label: 'left',
        prompt: 'left prompt',
        slot: { row: 5, column: 10 },
      })
      const right = engine.notebooks.createCell({
        type: 'prompt',
        label: 'right',
        prompt: 'right prompt',
        slot: { row: 2, column: 3 },
      })
      const edges = [
        engine.notebooks.createEdge({
          source: root.id,
          target: left.id,
          targetInput: 'input',
        }),
        engine.notebooks.createEdge({
          source: root.id,
          target: right.id,
          targetInput: 'input',
        }),
      ]
      value(await engine.notebooks.write({
        ...initial,
        cells: [root, left, right],
        edges,
      }))
      const before = value(engine.notebooks.read(initial.id))
      const planned = planNotebookCausalPyramid(before)
      expect(planned.ok).toBe(true)
      if (!planned.ok) return

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
