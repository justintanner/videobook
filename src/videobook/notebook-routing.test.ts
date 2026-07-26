import { describe, expect, it } from 'vitest'
import type { NotebookDocument } from 'videobook-engine'
import {
  notebookGrid,
  notebookGridPosition,
  type NotebookGridSlot,
} from './notebook-grid'
import {
  notebookBusRiverPath,
  notebookBusRiverPoints,
  notebookBusRiverRoutes,
  notebookGutterLaneOffsets,
  type NotebookBusRiverPoint,
} from './notebook-routing'

function cell(id: string, row: number, column: number): NotebookDocument['cells'][number] {
  return {
    id,
    type: 'prompt',
    title: id,
    slot: { row, column },
  }
}

function notebook(
  cells: NotebookDocument['cells'],
  edges: NotebookDocument['edges'],
): NotebookDocument {
  return {
    id: 'notebook-routing',
    name: 'Routing',
    cells,
    edges,
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

function horizontalLaneDocument(count: number): NotebookDocument {
  const cells = Array.from({ length: count }, (_, index) => [
    cell(`source-${index}`, 0, index),
    cell(`target-${index}`, 2, index + 4),
  ]).flat()
  const edges = Array.from({ length: count }, (_, index) => ({
    id: `edge-${index}`,
    source: `source-${index}`,
    target: `target-${index}`,
    targetInput: 'input',
  }))
  return notebook(cells, edges)
}

function verticalLaneDocument(count: number): NotebookDocument {
  const cells = Array.from({ length: count }, (_, index) => [
    cell(`source-${index}`, index, 0),
    cell(`target-${index}`, index + 4, 2),
  ]).flat()
  const edges = Array.from({ length: count }, (_, index) => ({
    id: `edge-${index}`,
    source: `source-${index}`,
    target: `target-${index}`,
    targetInput: 'input',
  }))
  return notebook(cells, edges)
}

function edgeOffsets(
  document: NotebookDocument,
  key: 'sourceBusOffset' | 'riverOffset',
): number[] {
  const routes = notebookBusRiverRoutes(document)
  return document.edges.map((edge) => routes.get(edge.id)?.[key] ?? -1)
}

function segmentIntersectsCard(
  start: NotebookBusRiverPoint,
  end: NotebookBusRiverPoint,
  slot: NotebookGridSlot,
): boolean {
  const position = notebookGridPosition(slot)
  const left = position.x
  const right = left + notebookGrid.squareSize
  const top = position.y
  const bottom = top + notebookGrid.squareSize

  if (start.x === end.x) {
    return start.x > left
      && start.x < right
      && Math.max(Math.min(start.y, end.y), top)
        < Math.min(Math.max(start.y, end.y), bottom)
  }
  if (start.y === end.y) {
    return start.y > top
      && start.y < bottom
      && Math.max(Math.min(start.x, end.x), left)
        < Math.min(Math.max(start.x, end.x), right)
  }
  return true
}

describe('notebook bus and river routing', () => {
  it('prefers separate horizontal lanes before deterministic reuse', () => {
    expect(edgeOffsets(horizontalLaneDocument(1), 'sourceBusOffset')).toEqual([
      notebookGutterLaneOffsets[1],
    ])
    expect(edgeOffsets(horizontalLaneDocument(2), 'sourceBusOffset')).toEqual([
      notebookGutterLaneOffsets[0],
      notebookGutterLaneOffsets[2],
    ])
    expect(edgeOffsets(horizontalLaneDocument(4), 'sourceBusOffset')).toEqual([
      notebookGutterLaneOffsets[0],
      notebookGutterLaneOffsets[1],
      notebookGutterLaneOffsets[2],
      notebookGutterLaneOffsets[0],
    ])
  })

  it('prefers separate vertical lanes before deterministic reuse', () => {
    expect(edgeOffsets(verticalLaneDocument(4), 'riverOffset')).toEqual([
      notebookGutterLaneOffsets[0],
      notebookGutterLaneOffsets[1],
      notebookGutterLaneOffsets[2],
      notebookGutterLaneOffsets[0],
    ])
  })

  it('deduplicates an edge that enters and exits the same row gutter', () => {
    const document = notebook(
      [cell('source', 0, 0), cell('target', 1, 1)],
      [{ id: 'edge', source: 'source', target: 'target', targetInput: 'input' }],
    )
    const route = notebookBusRiverRoutes(document).get('edge')

    expect(route?.sourceBusOffset).toBe(notebookGutterLaneOffsets[1])
    expect(route?.targetBusOffset).toBe(notebookGutterLaneOffsets[1])
  })

  it('assigns the same routes regardless of document edge order', () => {
    const document = horizontalLaneDocument(4)
    const reversed = { ...document, edges: [...document.edges].reverse() }
    const routes = notebookBusRiverRoutes(document)
    const reversedRoutes = notebookBusRiverRoutes(reversed)

    for (const edge of document.edges) {
      expect(reversedRoutes.get(edge.id)).toEqual(routes.get(edge.id))
    }
  })

  it('builds the orthogonal bus and river path', () => {
    expect(notebookBusRiverPath(
      {
        sourceX: 100,
        sourceY: 200,
        targetX: 400,
        targetY: 760,
        sourceLeftX: -20,
        sourceRightX: 220,
        sourceBottomY: 196,
        targetTopY: 774,
      },
      {
        sourceBusOffset: 10,
        targetBusOffset: 30,
        riverOffset: 20,
        riverSide: 'right',
      },
    )).toBe('M 100 200 V 206 H 240 V 764 H 400 V 760')
  })

  it.each([
    ['same-row right', { row: 1, column: -2 }, { row: 1, column: 2 }],
    ['same-row left', { row: 1, column: 2 }, { row: 1, column: -2 }],
    ['down same-column', { row: 0, column: 0 }, { row: 3, column: 0 }],
    ['up right', { row: 3, column: -1 }, { row: 0, column: 2 }],
    ['adjacent down-left', { row: 1, column: 1 }, { row: 2, column: -2 }],
  ])('keeps %s paths outside every card square', (_name, sourceSlot, targetSlot) => {
    const document = notebook(
      [
        cell('source', sourceSlot.row, sourceSlot.column),
        cell('target', targetSlot.row, targetSlot.column),
      ],
      [{ id: 'edge', source: 'source', target: 'target', targetInput: 'input' }],
    )
    const route = notebookBusRiverRoutes(document).get('edge')
    expect(route).toBeDefined()

    const sourcePosition = notebookGridPosition(sourceSlot)
    const targetPosition = notebookGridPosition(targetSlot)
    const coordinates = {
      sourceX: sourcePosition.x + notebookGrid.squareSize / 2,
      sourceY: sourcePosition.y + notebookGrid.squareSize + 4.5,
      targetX: targetPosition.x + notebookGrid.squareSize / 2,
      targetY: targetPosition.y - 10.5,
      sourceLeftX: sourcePosition.x,
      sourceRightX: sourcePosition.x + notebookGrid.squareSize,
      sourceBottomY: sourcePosition.y + notebookGrid.squareSize,
      targetTopY: targetPosition.y,
    }
    const points = notebookBusRiverPoints(coordinates, route!)
    const slots = Array.from({ length: 4 }, (_, row) =>
      Array.from({ length: 7 }, (_, index) => ({ row, column: index - 3 })),
    ).flat()

    expect(points[1].y).toBeGreaterThan(coordinates.sourceBottomY)
    expect(points[1].y).toBeLessThan(coordinates.sourceBottomY + notebookGrid.gap)
    expect(points[3].y).toBeGreaterThan(coordinates.targetTopY - notebookGrid.gap)
    expect(points[3].y).toBeLessThan(coordinates.targetTopY)

    for (let index = 1; index < points.length; index += 1) {
      const start = points[index - 1]
      const end = points[index]
      expect(slots.some((slot) => segmentIntersectsCard(start, end, slot))).toBe(false)
    }
  })
})
