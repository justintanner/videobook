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
  notebookSourcePortOffsets,
  type NotebookBusRiverRoute,
  type NotebookBusRiverPoint,
} from './notebook-routing'

function cell(id: string, row: number, column: number): NotebookDocument['cells'][number] {
  return {
    id,
    type: 'prompt',
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
    cell(`source-${index}`, 0, index + 4),
    cell(`target-${index}`, 2, index),
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
  key: 'sourceBusOffset' | 'targetBusOffset' | 'riverOffset',
): number[] {
  const routes = notebookBusRiverRoutes(document)
  return document.edges.map((edge) => routes.get(edge.id)?.[key] ?? -1)
}

function fanOutDocument(count: number): NotebookDocument {
  const cells = [
    cell('source', 0, 0),
    ...Array.from({ length: count }, (_, index) =>
      cell(`target-${index}`, index + 1, 2)),
  ]
  const edges = Array.from({ length: count }, (_, index) => ({
    id: `edge-${index}`,
    source: 'source',
    target: `target-${index}`,
    targetInput: 'input',
  }))
  return notebook(cells, edges)
}

function fanInDocument(count: number): NotebookDocument {
  const cells = [
    ...Array.from({ length: count }, (_, index) =>
      cell(`source-${index}`, 0, index)),
    cell('target', 3, count + 1),
  ]
  const edges = Array.from({ length: count }, (_, index) => ({
    id: `edge-${index}`,
    source: `source-${index}`,
    target: 'target',
    targetInput: `input-${index}`,
  }))
  return notebook(cells, edges)
}

function sourceCoordinates(
  slot: NotebookGridSlot,
  route: NotebookBusRiverRoute,
): { sourceX: number; sourceY: number } {
  const position = notebookGridPosition(slot)
  const offset = notebookSourcePortOffsets[route.sourcePortIndex]
    ?? notebookSourcePortOffsets[1]
  if (route.sourceSide === 'left') {
    return {
      sourceX: position.x - 4.5,
      sourceY: position.y + notebookGrid.squareSize * offset,
    }
  }
  if (route.sourceSide === 'right') {
    return {
      sourceX: position.x + notebookGrid.squareSize + 4.5,
      sourceY: position.y + notebookGrid.squareSize * offset,
    }
  }
  return {
    sourceX: position.x + notebookGrid.squareSize * offset,
    sourceY: position.y + notebookGrid.squareSize + 4.5,
  }
}

function targetCoordinates(
  slot: NotebookGridSlot,
  route: NotebookBusRiverRoute,
): { targetX: number; targetY: number } {
  const position = notebookGridPosition(slot)
  if (route.targetSide === 'left') {
    const offset = notebookSourcePortOffsets[route.targetPortIndex]
      ?? notebookSourcePortOffsets[1]
    return {
      targetX: position.x,
      targetY: position.y + notebookGrid.squareSize * offset,
    }
  }
  return {
    targetX: position.x + notebookGrid.squareSize / 2,
    targetY: position.y,
  }
}

function routeCoordinates(
  sourceSlot: NotebookGridSlot,
  targetSlot: NotebookGridSlot,
  route: NotebookBusRiverRoute,
) {
  const sourcePosition = notebookGridPosition(sourceSlot)
  const targetPosition = notebookGridPosition(targetSlot)
  return {
    ...sourceCoordinates(sourceSlot, route),
    ...targetCoordinates(targetSlot, route),
    sourceLeftX: sourcePosition.x,
    sourceRightX: sourcePosition.x + notebookGrid.squareSize,
    sourceBottomY: sourcePosition.y + notebookGrid.squareSize,
    targetLeftX: targetPosition.x,
    targetTopY: targetPosition.y,
    targetHeight: notebookGrid.squareSize,
  }
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
    expect(edgeOffsets(horizontalLaneDocument(1), 'targetBusOffset')).toEqual([
      notebookGutterLaneOffsets[1],
    ])
    expect(edgeOffsets(horizontalLaneDocument(2), 'targetBusOffset')).toEqual([
      notebookGutterLaneOffsets[0],
      notebookGutterLaneOffsets[2],
    ])
    expect(edgeOffsets(horizontalLaneDocument(4), 'targetBusOffset')).toEqual([
      notebookGutterLaneOffsets[0],
      notebookGutterLaneOffsets[1],
      notebookGutterLaneOffsets[2],
      notebookGutterLaneOffsets[0],
    ])
  })

  it('prefers separate left target ports before deterministic reuse', () => {
    const document = fanInDocument(4)
    const routes = notebookBusRiverRoutes(document)
    expect(document.edges.map((edge) => routes.get(edge.id)?.targetPortIndex)).toEqual([
      0,
      1,
      2,
      0,
    ])
  })

  it('chooses one deterministic primary arrival across a card fan-in', () => {
    const document = fanInDocument(4)
    const reversed = { ...document, edges: [...document.edges].reverse() }
    const primaryIds = (candidate: NotebookDocument) => {
      const routes = notebookBusRiverRoutes(candidate)
      return candidate.edges
        .filter((edge) => routes.get(edge.id)?.targetPrimary)
        .map((edge) => edge.id)
        .sort()
    }

    expect(primaryIds(document)).toEqual(['edge-0'])
    expect(primaryIds(reversed)).toEqual(['edge-0'])
  })

  it('prefers separate vertical lanes before deterministic reuse', () => {
    expect(edgeOffsets(verticalLaneDocument(4), 'riverOffset')).toEqual([
      notebookGutterLaneOffsets[0],
      notebookGutterLaneOffsets[1],
      notebookGutterLaneOffsets[2],
      notebookGutterLaneOffsets[0],
    ])
  })

  it('assigns directional source sides from the target column', () => {
    const document = notebook(
      [
        cell('source', 1, 0),
        cell('left', 2, -2),
        cell('right', 2, 2),
        cell('below', 3, 0),
      ],
      [
        { id: 'left-edge', source: 'source', target: 'left', targetInput: 'input' },
        { id: 'right-edge', source: 'source', target: 'right', targetInput: 'input' },
        { id: 'below-edge', source: 'source', target: 'below', targetInput: 'input' },
      ],
    )
    const routes = notebookBusRiverRoutes(document)

    expect(routes.get('left-edge')).toMatchObject({
      sourceSide: 'left',
      sourcePortIndex: 1,
      targetSide: 'top',
      riverSide: 'left',
    })
    expect(routes.get('right-edge')).toMatchObject({
      sourceSide: 'right',
      sourcePortIndex: 1,
      targetSide: 'left',
      riverSide: 'right',
    })
    expect(routes.get('below-edge')).toMatchObject({
      sourceSide: 'bottom',
      sourcePortIndex: 1,
      targetSide: 'top',
    })
  })

  it('prefers separate source ports before deterministic reuse', () => {
    const portIndices = (count: number) => {
      const document = fanOutDocument(count)
      const routes = notebookBusRiverRoutes(document)
      return document.edges.map((edge) =>
        routes.get(edge.id)?.sourcePortIndex ?? -1)
    }

    expect(portIndices(1)).toEqual([1])
    expect(portIndices(2)).toEqual([0, 2])
    expect(portIndices(4)).toEqual([0, 1, 2, 0])
  })

  it('splits same-column bottom routes across adjacent rivers', () => {
    const document = notebook(
      [
        cell('source', 0, 0),
        cell('near', 2, 0),
        cell('far', 3, 0),
      ],
      [
        { id: 'near-edge', source: 'source', target: 'near', targetInput: 'input' },
        { id: 'far-edge', source: 'source', target: 'far', targetInput: 'input' },
      ],
    )
    const routes = notebookBusRiverRoutes(document)

    expect(routes.get('near-edge')?.riverSide).toBe('left')
    expect(routes.get('far-edge')?.riverSide).toBe('right')
  })

  it('deduplicates an edge that enters and exits the same row gutter', () => {
    const document = notebook(
      [cell('source', 0, 0), cell('target', 1, 0)],
      [{ id: 'edge', source: 'source', target: 'target', targetInput: 'input' }],
    )
    const route = notebookBusRiverRoutes(document).get('edge')

    expect(route?.sourceBusOffset).toBe(notebookGutterLaneOffsets[1])
    expect(route?.targetBusOffset).toBe(notebookGutterLaneOffsets[1])
  })

  it('assigns the same top and lateral routes regardless of edge order', () => {
    for (const document of [horizontalLaneDocument(4), fanInDocument(4)]) {
      const reversed = { ...document, edges: [...document.edges].reverse() }
      const routes = notebookBusRiverRoutes(document)
      const reversedRoutes = notebookBusRiverRoutes(reversed)

      for (const edge of document.edges) {
        expect(reversedRoutes.get(edge.id)).toEqual(routes.get(edge.id))
      }
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
        targetLeftX: 280,
        targetTopY: 774,
        targetHeight: 240,
      },
      {
        sourceSide: 'bottom',
        sourcePortIndex: 1,
        targetSide: 'top',
        targetPortIndex: 1,
        sourceBusOffset: 10,
        targetBusOffset: 30,
        riverOffset: 20,
        riverSide: 'right',
        directRowGutter: false,
        targetPrimary: true,
      },
    )).toBe('M 100 200 V 203 Q 100 206 103 206 H 232 Q 240 206 240 214 V 756 Q 240 764 248 764 H 398 Q 400 764 400 762 V 760')
  })

  it('routes side ports directly into their adjacent river', () => {
    expect(notebookBusRiverPath(
      {
        sourceX: 224.5,
        sourceY: 120,
        targetX: 400,
        targetY: 760,
        sourceLeftX: -20,
        sourceRightX: 220,
        sourceBottomY: 196,
        targetLeftX: 280,
        targetTopY: 774,
        targetHeight: 240,
      },
      {
        sourceSide: 'right',
        sourcePortIndex: 1,
        targetSide: 'top',
        targetPortIndex: 1,
        sourceBusOffset: 10,
        targetBusOffset: 30,
        riverOffset: 20,
        riverSide: 'right',
        directRowGutter: false,
        targetPrimary: true,
      },
    )).toBe('M 224.5 120 H 232.25 Q 240 120 240 127.75 V 756 Q 240 764 248 764 H 398 Q 400 764 400 762 V 760')
  })

  it('keeps adjacent same-column routes in their shared row gutter', () => {
    expect(notebookBusRiverPath(
      {
        sourceX: 100,
        sourceY: 200,
        targetX: 140,
        targetY: 225,
        sourceLeftX: -20,
        sourceRightX: 220,
        sourceBottomY: 196,
        targetLeftX: 20,
        targetTopY: 236,
        targetHeight: 240,
      },
      {
        sourceSide: 'bottom',
        sourcePortIndex: 1,
        targetSide: 'top',
        targetPortIndex: 1,
        sourceBusOffset: 20,
        targetBusOffset: 20,
        riverOffset: 20,
        riverSide: 'right',
        directRowGutter: true,
        targetPrimary: true,
      },
    )).toBe('M 100 200 V 208 Q 100 216 108 216 H 135.5 Q 140 216 140 220.5 V 225')
  })

  it('routes adjacent same-row forward connections as one horizontal segment', () => {
    const sourceSlot = { row: 1, column: 1 }
    const targetSlot = { row: 1, column: 2 }
    const document = notebook(
      [cell('source', sourceSlot.row, sourceSlot.column), cell('target', targetSlot.row, targetSlot.column)],
      [{ id: 'edge', source: 'source', target: 'target', targetInput: 'input' }],
    )
    const route = notebookBusRiverRoutes(document).get('edge')
    expect(route).toMatchObject({
      sourceSide: 'right',
      sourcePortIndex: 1,
      targetSide: 'left',
      targetPortIndex: 1,
    })
    const coordinates = routeCoordinates(sourceSlot, targetSlot, route!)
    const points = notebookBusRiverPoints(coordinates, route!)

    expect(points).toEqual([
      { x: 524.5, y: 400 },
      { x: 560, y: 400 },
    ])
    expect(notebookBusRiverPath(coordinates, route!)).toBe('M 524.5 400 H 560')
    expect(points.every((point) => point.y >= notebookGridPosition(sourceSlot).y)).toBe(true)
    expect(segmentIntersectsCard(points[0]!, points[1]!, targetSlot)).toBe(false)
  })

  it('routes distant same-row forward connections directly into the target left edge', () => {
    const sourceSlot = { row: 0, column: 0 }
    const targetSlot = { row: 0, column: 3 }
    const document = notebook(
      [cell('source', sourceSlot.row, sourceSlot.column), cell('target', targetSlot.row, targetSlot.column)],
      [{ id: 'edge', source: 'source', target: 'target', targetInput: 'input' }],
    )
    const route = notebookBusRiverRoutes(document).get('edge')
    expect(route?.targetSide).toBe('left')
    expect(notebookBusRiverPath(routeCoordinates(sourceSlot, targetSlot, route!), route!))
      .toBe('M 244.5 120 H 840')
  })

  it('routes cross-row forward connections through the target-column gutter', () => {
    const sourceSlot = { row: 0, column: 0 }
    const targetSlot = { row: 2, column: 2 }
    const document = notebook(
      [cell('source', sourceSlot.row, sourceSlot.column), cell('target', targetSlot.row, targetSlot.column)],
      [{ id: 'edge', source: 'source', target: 'target', targetInput: 'input' }],
    )
    const route = notebookBusRiverRoutes(document).get('edge')
    expect(route).toMatchObject({ targetSide: 'left', riverOffset: 20 })
    expect(notebookBusRiverPath(routeCoordinates(sourceSlot, targetSlot, route!), route!))
      .toBe('M 244.5 120 H 532 Q 540 120 540 128 V 672 Q 540 680 548 680 H 560')
  })

  it('keeps backward connections on the target top edge', () => {
    const sourceSlot = { row: 1, column: 2 }
    const targetSlot = { row: 0, column: 0 }
    const document = notebook(
      [cell('source', sourceSlot.row, sourceSlot.column), cell('target', targetSlot.row, targetSlot.column)],
      [{ id: 'edge', source: 'source', target: 'target', targetInput: 'input' }],
    )
    const route = notebookBusRiverRoutes(document).get('edge')
    expect(route?.targetSide).toBe('top')
    const points = notebookBusRiverPoints(routeCoordinates(sourceSlot, targetSlot, route!), route!)
    expect(points.at(-1)).toEqual({ x: 120, y: 0 })
  })

  it.each([
    ['same-row left', { row: 1, column: 2 }, { row: 1, column: -2 }],
    ['down same-column', { row: 0, column: 0 }, { row: 3, column: 0 }],
    ['adjacent down same-column', { row: 1, column: 0 }, { row: 2, column: 0 }],
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

    const coordinates = routeCoordinates(sourceSlot, targetSlot, route!)
    const points = notebookBusRiverPoints(coordinates, route!)
    const slots = Array.from({ length: 4 }, (_, row) =>
      Array.from({ length: 7 }, (_, index) => ({ row, column: index - 3 })),
    ).flat()

    for (let index = 1; index < points.length; index += 1) {
      const start = points[index - 1]
      const end = points[index]
      expect(slots.some((slot) => segmentIntersectsCard(start, end, slot))).toBe(false)
    }
  })
})
