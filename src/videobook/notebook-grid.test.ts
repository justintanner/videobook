import type { Node } from '@xyflow/react'
import { describe, expect, it } from 'vitest'
import {
  allocateNotebookVideoGenerationSlots,
  changedNotebookGridNodes,
  nextHorizontalSlotFrom,
  nextNotebookGridSlot,
  nextNotebookHorizontalGenerationSlot,
  nextNotebookVideoGenerationSlot,
  nextVerticalSlotFrom,
  normalizeNotebookGridZoom,
  notebookGrid,
  notebookGridDropSlot,
  notebookGridFrameSize,
  notebookGridMetrics,
  notebookGridPosition,
  notebookGridSquareAt,
  notebookGridSlot,
  notebookGridTag,
  notebookGridViewport,
  resolveNotebookGridGroupMove,
  resolveNotebookGridMove,
  snapNotebookGridMove,
  type NotebookGridData,
} from './notebook-grid'
import { NOTEBOOK_GRID_FULL_ERROR } from 'videobook-engine'

interface TestData extends NotebookGridData {
  name: string
}

function node(id: string, row: number, column: number): Node<TestData> {
  const slot = { row, column }
  return {
    id,
    position: notebookGridPosition(slot),
    data: { name: id, slot },
  }
}

describe('notebook grid', () => {
  it('maps pixels into the fixed @a1 through @z13 board', () => {
    expect(notebookGridSlot({ x: -800, y: -100 })).toEqual({
      row: 0,
      column: 0,
    })
    expect(notebookGridSlot({
      x: notebookGrid.originX + notebookGrid.columnPitch * 12,
      y: notebookGrid.originY + notebookGrid.rowPitch * 25,
    })).toEqual({ row: 25, column: 12 })
    expect(notebookGridTag({ row: 0, column: 0 })).toBe('@a1')
    expect(notebookGridTag({ row: 25, column: 12 })).toBe('@z13')
  })

  it('snaps a single drag to the nearest bounded square', () => {
    const source = [node('a', 0, 0), node('b', 0, 1)]
    const snapped = snapNotebookGridMove(source, 'a', { row: 100, column: -3 })
    expect(snapped[0]?.position).toEqual(
      notebookGridPosition({ row: 25, column: 0 }),
    )
    expect(snapped[0]?.data.slot).toEqual({ row: 0, column: 0 })
  })

  it('moves to an empty square without compacting other cells', () => {
    const moved = resolveNotebookGridMove([
      node('a', 0, 0),
      node('b', 1, 1),
    ], 'a', { row: 100, column: -17 })
    expect(moved.map((item) => ({ id: item.id, slot: item.data.slot }))).toEqual([
      { id: 'a', slot: { row: 25, column: 0 } },
      { id: 'b', slot: { row: 1, column: 1 } },
    ])
  })

  it('swaps both logical slots when a single-cell destination is occupied', () => {
    const swapped = resolveNotebookGridMove([
      node('a', 0, 0),
      node('b', 2, 3),
    ], 'a', { row: 2, column: 3 })
    expect(swapped.map((item) => ({ id: item.id, slot: item.data.slot }))).toEqual([
      { id: 'a', slot: { row: 2, column: 3 } },
      { id: 'b', slot: { row: 0, column: 0 } },
    ])
  })

  it('moves selected cells together while preserving relative slots', () => {
    const moved = resolveNotebookGridGroupMove([
      node('a', 1, 1),
      node('b', 2, 3),
      node('c', 7, 4),
    ], 'a', ['a', 'b'], { row: 4, column: 2 })
    expect(moved.map((item) => item.data.slot)).toEqual([
      { row: 4, column: 2 },
      { row: 5, column: 4 },
      { row: 7, column: 4 },
    ])
  })

  it('rejects group moves that cross an edge or collide', () => {
    const edgeSource = [node('a', 1, 1), node('b', 2, 3)]
    expect(resolveNotebookGridGroupMove(
      edgeSource,
      'a',
      ['a', 'b'],
      { row: 0, column: -1 },
    ).map((item) => item.data.slot)).toEqual(
      edgeSource.map((item) => item.data.slot),
    )

    const collisionSource = [
      node('a', 0, 0),
      node('b', 0, 1),
      node('c', 0, 2),
    ]
    expect(resolveNotebookGridGroupMove(
      collisionSource,
      'a',
      ['a', 'b'],
      { row: 0, column: 1 },
    ).map((item) => item.data.slot)).toEqual(
      collisionSource.map((item) => item.data.slot),
    )
  })

  it('allows selected cells to move through their own source footprint', () => {
    const moved = resolveNotebookGridGroupMove([
      node('a', 0, 0),
      node('b', 0, 1),
    ], 'a', ['a', 'b'], { row: 0, column: 1 })
    expect(moved.map((item) => item.data.slot)).toEqual([
      { row: 0, column: 1 },
      { row: 0, column: 2 },
    ])
  })

  it('returns only cells whose persisted slots changed', () => {
    const source = [node('a', 0, 0), node('b', 2, 3), node('c', 4, 1)]
    const moved = resolveNotebookGridMove(source, 'a', { row: 2, column: 3 })
    expect(changedNotebookGridNodes(source, moved).map((item) => item.id))
      .toEqual(['a', 'b'])
    expect(changedNotebookGridNodes(source, source)).toEqual([])
  })

  it('chooses empty squares in address order and reports a full grid', () => {
    expect(nextNotebookGridSlot([
      node('a', 0, 0),
      node('b', 0, 2),
      node('c', 0, 3),
    ])).toEqual({ row: 0, column: 1 })
    const full = Array.from({ length: 338 }, (_, index) =>
      node(String(index), Math.floor(index / 13), index % 13))
    expect(() => nextNotebookGridSlot(full)).toThrow('Notebook grid is full')
  })

  it('places video generation cells vertically near column 1 without drifting right', () => {
    expect(nextNotebookVideoGenerationSlot([
      { type: 'image', slot: { row: 0, column: 0 } },
      { type: 'image', slot: { row: 0, column: 2 } },
      { type: 'prompt', slot: { row: 1, column: 0 } },
    ])).toEqual({ row: 2, column: 0 })

    expect(nextNotebookVideoGenerationSlot([
      { type: 'image', slot: { row: 0, column: 0 } },
      { type: 'generate_video', slot: { row: 1, column: 0 } },
      { type: 'video', slot: { row: 2, column: 0 } },
    ])).toEqual({ row: 3, column: 0 })

    expect(nextNotebookVideoGenerationSlot([
      { type: 'prompt', slot: { row: 0, column: 0 } },
      { type: 'generate_video', slot: { row: 1, column: 0 } },
    ])).toEqual({ row: 2, column: 0 })

    const first = allocateNotebookVideoGenerationSlots([])
    expect(first).toEqual({
      tile: { row: 0, column: 0 },
      output: { row: 1, column: 0 },
    })
    const second = allocateNotebookVideoGenerationSlots([
      { type: 'generate_video', slot: first.tile },
      { type: 'video', slot: first.output },
    ])
    expect(second).toEqual({
      tile: { row: 2, column: 0 },
      output: { row: 3, column: 0 },
    })
  })

  it('places image and frame work horizontally near sources', () => {
    expect(nextNotebookHorizontalGenerationSlot(
      [{ type: 'video', slot: { row: 2, column: 0 } }],
      [{ row: 2, column: 0 }],
    )).toEqual({ row: 2, column: 1 })

    expect(nextHorizontalSlotFrom(
      { row: 0, column: 3 },
      [{ row: 0, column: 0 }, { row: 0, column: 1 }, { row: 0, column: 2 }],
    )).toEqual({ row: 0, column: 3 })

    expect(nextVerticalSlotFrom(
      { row: 1, column: 0 },
      [{ row: 1, column: 0 }],
    )).toEqual({ row: 2, column: 0 })

    const full = Array.from({ length: 338 }, (_, index) => ({
      row: Math.floor(index / 13),
      column: index % 13,
    }))
    expect(() => nextVerticalSlotFrom({ row: 0, column: 0 }, full))
      .toThrow(NOTEBOOK_GRID_FULL_ERROR)
  })

  it('keeps thirteen columns and grows visible rows to one trailing row', () => {
    expect(notebookGridMetrics([
      { row: 0, column: 0 },
      { row: 9, column: 12 },
    ])).toEqual({
      rowCount: 11,
      columnCount: 13,
      minColumn: 0,
      maxColumn: 12,
      centerX: 1820,
      width: 3640,
      height: 3080,
    })
    expect(notebookGridMetrics([], {
      viewportWidth: 2048,
      viewportHeight: 900,
      zoom: 0.5,
    })).toEqual({
      rowCount: 7,
      columnCount: 13,
      minColumn: 0,
      maxColumn: 12,
      centerX: 1820,
      width: 3640,
      height: 1960,
    })
    expect(notebookGridMetrics([]).rowCount).toBe(3)
    expect(notebookGridMetrics([{ row: 25, column: 12 }]).rowCount).toBe(26)
  })

  it('bounds edge drops and starts the viewport at the top left', () => {
    const metrics = notebookGridMetrics([{ row: 5, column: 0 }])
    expect(notebookGridDropSlot({ x: -100, y: -100 }, metrics))
      .toEqual({ row: 0, column: 0 })
    expect(notebookGridDropSlot({ x: 100_000, y: 100_000 }, metrics))
      .toEqual({ row: 25, column: 12 })
    expect(notebookGridFrameSize(notebookGridMetrics([]), 1.5)).toEqual({
      width: 5460,
      height: 1260,
    })
    expect(notebookGridViewport(metrics, 1.5, -40)).toEqual({
      x: 0,
      y: -40,
      zoom: 1.5,
    })
  })

  it('targets only the visible square surfaces for media drops', () => {
    const metrics = notebookGridMetrics([])
    expect(notebookGridSquareAt({
      x: notebookGrid.originX + notebookGrid.columnPitch + 24,
      y: notebookGrid.originY + notebookGrid.rowPitch * 2 + 36,
    }, metrics)).toEqual({ row: 2, column: 1 })
    expect(notebookGridSquareAt({
      x: notebookGrid.originX + notebookGrid.squareSize,
      y: notebookGrid.originY + 24,
    }, metrics)).toBeNull()
    expect(notebookGridSquareAt({
      x: notebookGrid.originX + 24,
      y: notebookGrid.originY + notebookGrid.rowPitch * metrics.rowCount,
    }, metrics)).toBeNull()
    expect(notebookGridSquareAt({ x: 0, y: 0 }, metrics)).toBeNull()
  })

  it('clamps invalid and out-of-range zoom values', () => {
    expect(normalizeNotebookGridZoom(0.1)).toBe(notebookGrid.minimumZoom)
    expect(normalizeNotebookGridZoom(4)).toBe(notebookGrid.maximumZoom)
    expect(normalizeNotebookGridZoom(Number.NaN)).toBe(1)
  })
})
