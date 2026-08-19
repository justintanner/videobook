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

describe('notebook readable auto-arrange', () => {
  it('keeps a full chain on a single band row regardless of cell type', () => {
    const source = document(
      [
        cell('root', 8, 1),
        cell('gen', 4, 10),
        cell('vid', 1, 11, 'video'),
      ],
      [edge('root', 'gen'), edge('gen', 'vid')],
    )
    const planned = planNotebookArrangement(source)
    const slots = assignmentMap(planned)

    expect(planned.ok && planned.rowCount).toBe(1)
    expect(slots.get('root')).toEqual({ row: 0, column: 0 })
    expect(slots.get('gen')).toEqual({ row: 0, column: 1 })
    expect(slots.get('vid')).toEqual({ row: 0, column: 2 })
  })

  it('continues the deepest branch on the anchor row and stacks siblings below', () => {
    const source = document(
      [
        cell('root', 8, 1),
        cell('left', 4, 10),
        cell('right', 2, 3),
        cell('sink', 1, 11, 'video'),
      ],
      [
        edge('root', 'left'),
        edge('root', 'right'),
        edge('left', 'sink'),
        edge('right', 'sink'),
      ],
    )
    const first = planNotebookArrangement(source)
    const slots = assignmentMap(first)

    expect(first.ok && first.rowCount).toBe(2)
    expect(slots.get('root')).toEqual({ row: 0, column: 0 })
    expect(slots.get('left')).toEqual({ row: 0, column: 1 })
    expect(slots.get('right')).toEqual({ row: 1, column: 1 })
    expect(slots.get('sink')).toEqual({ row: 0, column: 2 })

    const arranged = applyAssignments(source, slots)
    expect(planNotebookArrangement(arranged)).toEqual(first)
  })

  it('separates each workflow band with one blank row and packs loose cells last', () => {
    const source = document(
      [
        cell('alpha-src', 9, 9),
        cell('alpha-out', 3, 1),
        cell('beta-src', 6, 5),
        cell('beta-out', 2, 12, 'video'),
        cell('loose-a', 7, 7),
        cell('loose-b', 0, 0),
      ],
      [edge('alpha-src', 'alpha-out'), edge('beta-src', 'beta-out')],
    )
    const planned = planNotebookArrangement(source)
    const slots = assignmentMap(planned)
    const occupiedRows = new Set([...slots.values()].map((slot) => slot.row))

    expect(planned.ok && planned.rowCount).toBe(5)
    expect(slots.get('alpha-src')).toEqual({ row: 0, column: 0 })
    expect(slots.get('alpha-out')).toEqual({ row: 0, column: 1 })
    expect(slots.get('beta-src')).toEqual({ row: 2, column: 0 })
    expect(slots.get('beta-out')).toEqual({ row: 2, column: 1 })
    expect(slots.get('loose-a')).toEqual({ row: 4, column: 0 })
    expect(slots.get('loose-b')).toEqual({ row: 4, column: 1 })
    expect(occupiedRows).toEqual(new Set([0, 2, 4]))
  })

  it('wraps chains deeper than seven tiles onto the next band row', () => {
    const chain = Array.from({ length: 9 }, (_, index) =>
      cell(`chain-${String(index).padStart(2, '0')}`, index % 26, index % 13))
    const planned = planNotebookArrangement(document(
      chain,
      chain.slice(1).map((item, index) => edge(chain[index]!.id, item.id)),
    ))
    const slots = assignmentMap(planned)

    expect(planned.ok && planned.rowCount).toBe(2)
    for (let index = 0; index < 7; index += 1) {
      expect(slots.get(chain[index]!.id)).toEqual({ row: 0, column: index })
    }
    expect(slots.get('chain-07')).toEqual({ row: 1, column: 0 })
    expect(slots.get('chain-08')).toEqual({ row: 1, column: 1 })
    expect([...slots.values()].every((slot) => slot.column <= 6)).toBe(true)
  })

  it('emits unique in-bounds slots that never pass column six', () => {
    const source = document(
      [
        cell('mix-root', 12, 12),
        cell('mix-a', 3, 4),
        cell('mix-b', 5, 6, 'video'),
        cell('mix-c', 7, 8),
        cell('solo-a', 9, 10, 'video'),
        cell('solo-b', 11, 2),
      ],
      [
        edge('mix-root', 'mix-a'),
        edge('mix-root', 'mix-b'),
        edge('mix-a', 'mix-c'),
        edge('mix-b', 'mix-c'),
      ],
    )
    const planned = planNotebookArrangement(source)
    const slots = assignmentMap(planned)
    const keys = new Set([...slots.values()].map((slot) => `${slot.row}:${slot.column}`))

    expect(planned.ok).toBe(true)
    expect(slots.size).toBe(source.cells.length)
    expect(keys.size).toBe(source.cells.length)
    expect([...slots.values()].every((slot) =>
      slot.row >= 0 && slot.row < 26 && slot.column >= 0 && slot.column <= 6))
      .toBe(true)
  })

  it('drops the blank spacer rows when the gapped layout would overflow the grid', () => {
    const pairs = Array.from({ length: 14 }, (_, index) => ({
      source: cell(`pair-${String(index).padStart(2, '0')}-src`, index % 26, 0),
      target: cell(`pair-${String(index).padStart(2, '0')}-out`, index % 26, 1),
    }))
    const planned = planNotebookArrangement(document(
      pairs.flatMap(({ source, target }) => [source, target]),
      pairs.map(({ source, target }) => edge(source.id, target.id)),
    ))
    const slots = assignmentMap(planned)
    const occupiedRows = new Set([...slots.values()].map((slot) => slot.row))

    expect(planned.ok && planned.rowCount).toBe(14)
    expect(occupiedRows).toEqual(new Set(Array.from({ length: 14 }, (_, row) => row)))
    pairs.forEach(({ source, target }, index) => {
      expect(slots.get(source.id)).toEqual({ row: index, column: 0 })
      expect(slots.get(target.id)).toEqual({ row: index, column: 1 })
    })
  })

  it('falls back to a dense pack when even gapless bands exceed the grid', () => {
    const children = Array.from({ length: 30 }, (_, index) =>
      cell(`star-${String(index).padStart(2, '0')}`, index % 26, index % 13))
    const source = document(
      [cell('root', 20, 12), ...children],
      children.map((item, index) => edge('root', item.id, index)),
    )
    const planned = planNotebookArrangement(source)
    const slots = assignmentMap(planned)

    expect(planned.ok && planned.rowCount).toBe(5)
    expect(slots.get('root')).toEqual({ row: 0, column: 0 })
    expect(slots.get('star-00')).toEqual({ row: 0, column: 1 })
    expect(slots.get('star-06')).toEqual({ row: 1, column: 0 })
    expect(slots.get('star-29')).toEqual({ row: 4, column: 2 })

    const arranged = applyAssignments(source, slots)
    expect(planNotebookArrangement(arranged)).toEqual(planned)
  })

  it('fills all 26 rows with loose cells and rejects one cell more', () => {
    const full = Array.from({ length: 182 }, (_, index) =>
      cell(`cell-${String(index).padStart(3, '0')}`, 25 - Math.floor(index / 13), 12 - index % 13))
    const planned = planNotebookArrangement(document(full))
    const slots = assignmentMap(planned)
    const keys = new Set([...slots.values()].map((slot) => `${slot.row}:${slot.column}`))

    expect(planned.ok && planned.rowCount).toBe(26)
    expect(slots.size).toBe(182)
    expect(keys.size).toBe(182)
    expect([...slots.values()].every((slot) =>
      slot.row >= 0 && slot.row < 26 && slot.column >= 0 && slot.column <= 6))
      .toBe(true)

    const overflow = planNotebookArrangement(document(
      Array.from({ length: 183 }, (_, index) =>
        cell(`cell-${String(index).padStart(3, '0')}`, index % 26, index % 13)),
    ))
    expect(overflow).toMatchObject({ ok: false, code: 'capacity' })
    expect(!overflow.ok && overflow.message).toContain('needs 27 rows')
    expect(!overflow.ok && overflow.message).toContain('supports 26')
  })

  it('rejects cycles, missing cells, and duplicate cell ids', () => {
    const cyclic = planNotebookArrangement(document(
      [cell('a', 0, 0), cell('b', 0, 1)],
      [edge('a', 'b'), edge('b', 'a')],
    ))
    expect(cyclic).toMatchObject({ ok: false, code: 'cycle' })

    const missing = planNotebookArrangement(document(
      [cell('a', 0, 0)],
      [edge('a', 'missing')],
    ))
    expect(missing).toMatchObject({ ok: false, code: 'invalid-edge' })
    expect(!missing.ok && missing.message).toContain('missing cell missing')

    const duplicate = planNotebookArrangement(document(
      [cell('a', 0, 0), cell('a', 0, 1)],
    ))
    expect(duplicate).toMatchObject({ ok: false, code: 'invalid-edge' })
    expect(!duplicate.ok && duplicate.message).toContain('duplicate cell IDs')

    const compactChain = Array.from({ length: 27 }, (_, index) =>
      cell(`chain-${String(index).padStart(2, '0')}`, index % 26, index % 13))
    const compact = planNotebookArrangement(document(
      compactChain,
      compactChain.slice(1).map((item, index) =>
        edge(compactChain[index]!.id, item.id)),
    ))
    expect(compact).toMatchObject({ ok: true, rowCount: 4 })
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
      const planned = planNotebookArrangement(before)
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
