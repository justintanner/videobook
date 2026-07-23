import { describe, expect, it } from 'vitest'
import type { Node } from '@xyflow/react'
import {
  clampNotebookViewport,
  nextNotebookGridSlot,
  notebookGrid,
  notebookGridMetrics,
  notebookGridPosition,
  notebookGridStageCountForViewport,
  notebookGridStageViewport,
  notebookGridSlot,
  normalizeNotebookGridNodes,
  normalizeNotebookGridPositions,
  resolveNotebookGridMove,
  snapNotebookGridMove,
  type NotebookGridData,
} from './notebook-grid'

interface TestData extends NotebookGridData {
  name: string
}

function node(id: string, stage: number, column: number): Node<TestData> {
  return {
    id,
    position: notebookGridPosition({ stage, column }),
    data: { name: id, stage: stage + 1 },
  }
}

describe('notebook grid', () => {
  it('quantizes freeform and negative coordinates to non-negative stage and column slots', () => {
    expect(notebookGridSlot({ x: -800, y: -100 })).toEqual({ stage: 0, column: 0 })
    expect(notebookGridSlot({
      x: notebookGrid.originX + notebookGrid.columnPitch + 6,
      y: notebookGrid.originY + notebookGrid.stagePitch,
    })).toEqual({ stage: 1, column: 1 })
  })

  it('keeps legacy collisions sparse by moving later cells to the next free column', () => {
    const position = notebookGridPosition({ stage: 1, column: 2 })
    expect(normalizeNotebookGridPositions([position, position, position])).toEqual([
      notebookGridPosition({ stage: 1, column: 2 }),
      notebookGridPosition({ stage: 1, column: 3 }),
      notebookGridPosition({ stage: 1, column: 4 }),
    ])
  })

  it('derives stage labels from normalized positions', () => {
    const normalized = normalizeNotebookGridNodes([
      {
        id: 'legacy',
        position: { x: 20, y: 900 },
        data: { name: 'legacy', stage: 99 },
      },
    ])
    expect(normalized[0]?.data.stage).toBe(3)
    expect(normalized[0]?.position).toEqual(notebookGridPosition({ stage: 2, column: 0 }))
  })

  it('keeps gaps while an occupied target shifts only the contiguous right chain', () => {
    const result = resolveNotebookGridMove([
      node('a', 0, 0),
      node('b', 0, 1),
      node('c', 0, 3),
    ], 'c', { stage: 0, column: 0 })
    expect(result.map((item) => ({ id: item.id, slot: notebookGridSlot(item.position) }))).toEqual([
      { id: 'a', slot: { stage: 0, column: 1 } },
      { id: 'b', slot: { stage: 0, column: 2 } },
      { id: 'c', slot: { stage: 0, column: 0 } },
    ])
  })

  it('snaps the moving cell live and resolves an occupied chain only after drop', () => {
    const live = snapNotebookGridMove([
      node('a', 0, 0),
      node('b', 0, 1),
      node('c', 0, 2),
    ], 'c', { stage: 0, column: 0 })
    expect(live.map((item) => ({ id: item.id, slot: notebookGridSlot(item.position) }))).toEqual([
      { id: 'a', slot: { stage: 0, column: 0 } },
      { id: 'b', slot: { stage: 0, column: 1 } },
      { id: 'c', slot: { stage: 0, column: 0 } },
    ])

    const settled = resolveNotebookGridMove(live, 'c', { stage: 0, column: 0 })
    expect(settled.map((item) => ({ id: item.id, slot: notebookGridSlot(item.position) }))).toEqual([
      { id: 'a', slot: { stage: 0, column: 1 } },
      { id: 'b', slot: { stage: 0, column: 2 } },
      { id: 'c', slot: { stage: 0, column: 0 } },
    ])
  })

  it('leaves the source-stage gap and can move freely between stages', () => {
    const result = resolveNotebookGridMove([
      node('a', 0, 0),
      node('b', 0, 2),
    ], 'b', { stage: 2, column: 4 })
    expect(result.map((item) => ({ id: item.id, slot: notebookGridSlot(item.position) }))).toEqual([
      { id: 'a', slot: { stage: 0, column: 0 } },
      { id: 'b', slot: { stage: 2, column: 4 } },
    ])
  })

  it('uses the next free Stage 01 slot for palette clicks', () => {
    expect(nextNotebookGridSlot([
      node('a', 0, 0),
      node('b', 0, 2),
    ])).toEqual({ stage: 0, column: 1 })
  })

  it('keeps a six-stage runway and grows for previews beyond the current board', () => {
    expect(notebookGridMetrics([], null)).toMatchObject({
      stageCount: 6,
      columnCount: 4,
    })
    expect(notebookGridMetrics([], { stage: 8, column: 6 })).toMatchObject({
      stageCount: 9,
      columnCount: 7,
    })
  })

  it('extends the runway while scrolling down and clamps scrolling above Stage 01', () => {
    const top = { x: 24, y: notebookGrid.topViewportY, zoom: 1 }
    const below = { ...top, y: -1600 }

    expect(notebookGridStageCountForViewport(top, 800)).toBe(6)
    expect(notebookGridStageCountForViewport(below, 800)).toBe(9)
    expect(clampNotebookViewport({ ...top, y: 120 })).toEqual(top)
    expect(clampNotebookViewport(below)).toBe(below)
  })

  it('fits stage columns to the viewport width while keeping the book top aligned', () => {
    const positions = [
      notebookGridPosition({ stage: 0, column: 0 }),
      notebookGridPosition({ stage: 6, column: 3 }),
    ]
    const metrics = notebookGridMetrics(positions)
    const viewport = notebookGridStageViewport(positions, metrics.width + 48)

    expect(viewport).toEqual({
      x: 24,
      y: 18,
      zoom: 1,
    })
    expect(notebookGridStageViewport(positions, metrics.width / 2).zoom).toBeCloseTo(
      (metrics.width / 2 - 48) / metrics.width,
    )
  })
})
