import { describe, expect, it } from 'vitest'
import type { Node } from '@xyflow/react'
import {
  nextNotebookGridSlot,
  notebookGrid,
  notebookGridDropSlot,
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
  it('maps pixels to signed columns and non-negative rows without horizontal limits', () => {
    expect(notebookGridSlot({ x: -800, y: -100 })).toEqual({
      row: 0,
      column: -3,
    })
    expect(notebookGridSlot({
      x: notebookGrid.columnPitch * 12,
      y: notebookGrid.originY + notebookGrid.rowPitch * 2,
    })).toEqual({ row: 2, column: 12 })
  })

  it('snaps the moving node without changing its persisted source slot', () => {
    const source = [node('a', 0, 0), node('b', 0, 1)]
    const snapped = snapNotebookGridMove(source, 'a', { row: 2, column: -3 })
    expect(snapped[0]?.position).toEqual(
      notebookGridPosition({ row: 2, column: -3 }),
    )
    expect(snapped[0]?.data.slot).toEqual({ row: 0, column: 0 })
  })

  it('moves to an empty square without compacting other cells', () => {
    const moved = resolveNotebookGridMove([
      node('a', 0, 0),
      node('b', 1, 1),
    ], 'a', { row: 100, column: -17 })
    expect(moved.map((item) => ({ id: item.id, slot: item.data.slot }))).toEqual([
      { id: 'a', slot: { row: 100, column: -17 } },
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

  it('chooses empty squares from the center outward', () => {
    expect(nextNotebookGridSlot([
      node('a', 0, 0),
      node('b', 0, 2),
      node('c', 0, 3),
    ])).toEqual({ row: 0, column: -1 })
  })

  it('opens one new column from either horizontal edge drop zone', () => {
    const metrics = notebookGridMetrics([
      { row: 0, column: -3 },
      { row: 0, column: 3 },
    ])
    expect(notebookGridDropSlot({
      x: metrics.minColumn * notebookGrid.columnPitch - 1,
      y: notebookGrid.originY,
    }, metrics)).toEqual({ row: 0, column: -4 })
    expect(notebookGridDropSlot({
      x: metrics.maxColumn * notebookGrid.columnPitch + notebookGrid.squareSize + 1,
      y: notebookGrid.originY,
    }, metrics)).toEqual({ row: 0, column: 4 })
  })

  it('measures an odd square board around a permanent center column', () => {
    const metrics = notebookGridMetrics([
      { row: 0, column: -3 },
      { row: 9, column: 3 },
    ], 7)
    expect(metrics).toEqual({
      rowCount: 10,
      columnCount: 7,
      minColumn: -3,
      maxColumn: 3,
      centerX: 888,
      width: 2016,
      height: 2904,
    })
    expect(metrics.centerX + notebookGrid.squareSize / 2).toBe(metrics.width / 2)
  })

  it('grows symmetrically for drag previews on either horizontal side', () => {
    expect(notebookGridMetrics(
      [{ row: 0, column: 0 }],
      7,
      { row: 12, column: -7 },
    )).toEqual({
      rowCount: 13,
      columnCount: 15,
      minColumn: -7,
      maxColumn: 7,
      centerX: 2008,
      width: 4256,
      height: 3744,
    })
  })

  it('keeps an empty notebook large enough for vertical placement', () => {
    expect(notebookGridMetrics([])).toEqual({
      rowCount: 3,
      columnCount: 7,
      minColumn: -3,
      maxColumn: 3,
      centerX: 888,
      width: 2016,
      height: 944,
    })
  })
})
