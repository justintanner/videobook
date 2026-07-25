import { describe, expect, it } from 'vitest'
import type { Node } from '@xyflow/react'
import {
  nextNotebookGridSlot,
  notebookGrid,
  notebookGridMetrics,
  notebookGridPosition,
  notebookGridSlot,
  resolveNotebookGridMove,
  snapNotebookGridMove,
  type NotebookGridData,
} from './notebook-grid'

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
  it('maps pixels to non-negative slots with no right or bottom limit', () => {
    expect(notebookGridSlot({ x: -800, y: -100 })).toEqual({
      row: 0,
      column: 0,
    })
    expect(notebookGridSlot({
      x: notebookGrid.originX + notebookGrid.columnPitch * 12,
      y: notebookGrid.originY + notebookGrid.rowPitch * 2,
    })).toEqual({ row: 2, column: 12 })
  })

  it('snaps the moving node without changing its persisted source slot', () => {
    const source = [node('a', 0, 0), node('b', 0, 1)]
    const snapped = snapNotebookGridMove(source, 'a', { row: 2, column: 3 })
    expect(snapped[0]?.position).toEqual(
      notebookGridPosition({ row: 2, column: 3 }),
    )
    expect(snapped[0]?.data.slot).toEqual({ row: 0, column: 0 })
  })

  it('moves to an empty square without compacting other cells', () => {
    const moved = resolveNotebookGridMove([
      node('a', 0, 0),
      node('b', 1, 1),
    ], 'a', { row: 100, column: 17 })
    expect(moved.map((item) => ({ id: item.id, slot: item.data.slot }))).toEqual([
      { id: 'a', slot: { row: 100, column: 17 } },
      { id: 'b', slot: { row: 1, column: 1 } },
    ])
  })

  it('swaps both logical slots when the destination is occupied', () => {
    const swapped = resolveNotebookGridMove([
      node('a', 0, 0),
      node('b', 2, 3),
    ], 'a', { row: 2, column: 3 })
    expect(swapped.map((item) => ({ id: item.id, slot: item.data.slot }))).toEqual([
      { id: 'a', slot: { row: 2, column: 3 } },
      { id: 'b', slot: { row: 0, column: 0 } },
    ])
  })

  it('chooses the first empty square in row-major order', () => {
    expect(nextNotebookGridSlot([
      node('a', 0, 0),
      node('b', 0, 2),
      node('c', 0, 3),
    ])).toEqual({ row: 0, column: 1 })
  })

  it('measures a four-column square board without stage runway', () => {
    const metrics = notebookGridMetrics([
      { row: 0, column: 0 },
      { row: 9, column: 3 },
    ], 4)
    expect(metrics).toEqual({
      rowCount: 10,
      columnCount: 4,
      width: 1176,
      height: 2904,
    })
  })

  it('grows the measured square board for a drag preview in either dimension', () => {
    expect(notebookGridMetrics(
      [{ row: 0, column: 0 }],
      4,
      { row: 12, column: 7 },
    )).toEqual({
      rowCount: 13,
      columnCount: 8,
      width: 2296,
      height: 3744,
    })
  })

  it('keeps an empty notebook large enough for vertical placement', () => {
    expect(notebookGridMetrics([])).toEqual({
      rowCount: 3,
      columnCount: 4,
      width: 1176,
      height: 944,
    })
  })
})
