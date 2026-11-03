import type { Node } from '@xyflow/react'
import { describe, expect, it } from 'vitest'
import type { NotebookCellType } from 'videobook-engine'
import {
  changedNotebookGridNodes,
  fitNotebookGridZoom,
  nextNotebookGridSlot,
  normalizeNotebookGridZoom,
  notebookCreationPlacement,
  notebookGrid,
  notebookGridDetailScale,
  notebookGridDropSlot,
  notebookGridFrameSize,
  notebookGridMetrics,
  notebookGridPosition,
  notebookGridSquareAt,
  notebookGridSlot,
  notebookGridTag,
  notebookGridViewport,
  openNotebookGridNodeRow,
  resolveNotebookGridGroupMove,
  resolveNotebookGridMove,
  snapNotebookGridMove,
  type NotebookGridData,
} from './notebook-grid'
import {
  nextHorizontalSlotFrom,
  nextVerticalSlotFrom,
  NOTEBOOK_GRID_CAPACITY,
  NOTEBOOK_GRID_COLUMN_COUNT,
  NOTEBOOK_GRID_FULL_ERROR,
  NOTEBOOK_GRID_ROW_COUNT,
} from 'videobook-engine/notebook-grid'
import { notebookRowOpening, type NotebookLaneCell } from '../../server/src/notebook-lanes'

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

function laneCell(
  id: string,
  type: NotebookCellType,
  row: number,
  column: number,
): NotebookLaneCell {
  return { id, type, slot: { row, column } }
}

function laneRow(
  prefix: string,
  type: NotebookCellType,
  row: number,
  count: number,
): NotebookLaneCell[] {
  return Array.from({ length: count }, (_, column) => laneCell(`${prefix}-${column}`, type, row, column))
}

describe('notebook grid', () => {
  it('reserves whole Timeline rows for creation, moves and generation', () => {
    const timeline = { ...node('timeline', 1, 0), data: { ...node('timeline', 1, 0).data, kind: 'timeline' } }
    const cells = [node('source', 0, 7), timeline]
    for (let column = 0; column < 8; column += 1) {
      expect(resolveNotebookGridMove(cells, 'source', { row: 1, column }).map((item) => item.data.slot))
        .toEqual(cells.map((item) => item.data.slot))
    }
    expect(resolveNotebookGridMove(cells, 'timeline', { row: 0, column: 3 }).map((item) => item.data.slot))
      .toEqual(cells.map((item) => item.data.slot))
    expect(resolveNotebookGridMove(cells, 'timeline', { row: 2, column: 5 })[1]?.data.slot).toEqual({ row: 2, column: 0 })
    expect(resolveNotebookGridGroupMove(cells, 'source', ['source', 'timeline'], { row: 0, column: 6 }).map((item) => item.data.slot))
      .toEqual(cells.map((item) => item.data.slot))
    expect(resolveNotebookGridGroupMove(cells, 'source', ['source', 'timeline'], { row: 2, column: 7 }).map((item) => item.data.slot))
      .toEqual([{ row: 2, column: 7 }, { row: 3, column: 0 }])
    const row = laneCell('timeline', 'timeline', 1, 0)
    expect(nextNotebookGridSlot([timeline, ...Array.from({ length: 8 }, (_, column) => node(String(column), 0, column))]))
      .toEqual({ row: 2, column: 0 })
    expect(notebookCreationPlacement('timeline', [row, laneCell('image', 'image', 0, 7)]))
      .toEqual({ slot: { row: 2, column: 0 }, makeRoom: false })
    expect(notebookCreationPlacement('generate_video', [row, laneCell('image', 'image', 0, 0)]))
      .toEqual({ slot: { row: 0, column: 0 }, makeRoom: true })
    expect(notebookRowOpening([row, laneCell('image', 'image', 0, 0)], 0))
      .toEqual(new Map([['image', { row: 2, column: 0 }]]))
    expect(notebookRowOpening([row, laneCell('image', 'image', 0, 0)], 1)).toBeNull()
    expect(() => notebookCreationPlacement('timeline', Array.from({ length: 64 }, (_, index) => laneCell(`image-${index}`, 'image', index, 7))))
      .toThrow('empty row')
  })

  it('maps pixels into the fixed @a1 through @bl8 board', () => {
    expect(notebookGridSlot({ x: -800, y: -100 })).toEqual({
      row: 0,
      column: 0,
    })
    expect(notebookGridSlot({
      x: notebookGrid.originX + notebookGrid.columnPitch * 7,
      y: notebookGrid.originY + notebookGrid.rowPitch * 63,
    })).toEqual({ row: 63, column: 7 })
    expect(notebookGridTag({ row: 0, column: 0 })).toBe('@a1')
    expect(notebookGridTag({ row: 0, column: 1 })).toBe('@a2')
    expect(notebookGridTag({ row: 1, column: 0 })).toBe('@b1')
    expect(notebookGridTag({ row: 63, column: 7 })).toBe('@bl8')
  })

  it('snaps a single drag to the nearest bounded square', () => {
    const source = [node('a', 0, 0), node('b', 0, 1)]
    const snapped = snapNotebookGridMove(source, 'a', { row: 100, column: -3 })
    expect(snapped[0]?.position).toEqual(
      notebookGridPosition({ row: NOTEBOOK_GRID_ROW_COUNT - 1, column: 0 }),
    )
    expect(snapped[0]?.data.slot).toEqual({ row: 0, column: 0 })
  })

  it('moves to an empty square without compacting other cells', () => {
    const moved = resolveNotebookGridMove([
      node('a', 0, 0),
      node('b', 1, 1),
    ], 'a', { row: 100, column: -17 })
    expect(moved.map((item) => ({ id: item.id, slot: item.data.slot }))).toEqual([
      { id: 'a', slot: { row: NOTEBOOK_GRID_ROW_COUNT - 1, column: 0 } },
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
    const full = Array.from({ length: NOTEBOOK_GRID_CAPACITY }, (_, index) =>
      node(
        String(index),
        Math.floor(index / NOTEBOOK_GRID_COLUMN_COUNT),
        index % NOTEBOOK_GRID_COLUMN_COUNT,
      ))
    expect(() => nextNotebookGridSlot(full)).toThrow('Notebook grid is full')
  })

  it('places a new tile in the first free square of its lane', () => {
    const cells = [
      ...laneRow('source', 'video', 0, 2),
      laneCell('gen', 'generate_video', 1, 0),
      laneCell('image', 'image', 2, 0),
      laneCell('generated', 'video', 3, 0),
    ]
    cells[3] = { ...cells[3]!, inputs: { mediaRole: 'generate-video-output', producerCellId: 'gen' } }
    expect(notebookCreationPlacement('generate_image', cells)).toEqual({ slot: { row: 1, column: 1 }, makeRoom: false })
    expect(notebookCreationPlacement('generate_video', cells)).toEqual({ slot: { row: 1, column: 1 }, makeRoom: false })
    expect(notebookCreationPlacement('prompt', cells)).toEqual({ slot: { row: 1, column: 1 }, makeRoom: false })
    expect(notebookCreationPlacement('video', cells)).toEqual({ slot: { row: 0, column: 2 }, makeRoom: false })
    expect(notebookCreationPlacement('image', cells)).toEqual({ slot: { row: 2, column: 1 }, makeRoom: false })
    expect(notebookCreationPlacement('audio', cells)).toEqual({ slot: { row: 4, column: 0 }, makeRoom: false })
  })

  it('fills a gap in the lane before the end of its row', () => {
    const cells = [
      laneCell('gen-0', 'generate_image', 0, 0),
      laneCell('gen-2', 'generate_video', 0, 2),
      laneCell('image', 'image', 1, 0),
    ]
    expect(notebookCreationPlacement('generate_video', cells)).toEqual({ slot: { row: 0, column: 1 }, makeRoom: false })
  })

  it('opens a row under a full lane and moves the rows below it down', () => {
    const nodes = [
      ...laneRow('source', 'video', 0, 1),
      ...laneRow('gen', 'generate_video', 1, 8),
      ...laneRow('image', 'image', 2, 3),
    ].map((cell) => ({
      id: cell.id,
      position: notebookGridPosition(cell.slot),
      data: { kind: cell.type, slot: cell.slot },
    }))
    const cells = nodes.map((item) => laneCell(item.id, item.data.kind, item.data.slot.row, item.data.slot.column))
    expect(notebookCreationPlacement('generate_image', cells)).toEqual({ slot: { row: 2, column: 0 }, makeRoom: true })
    const opened = openNotebookGridNodeRow(nodes, 2)
    expect(opened.filter((item) => item.id.startsWith('image')).map((item) => item.data.slot)).toEqual([
      { row: 3, column: 0 },
      { row: 3, column: 1 },
      { row: 3, column: 2 },
    ])
    expect(opened.find((item) => item.id === 'image-1')?.position).toEqual(notebookGridPosition({ row: 3, column: 1 }))
    expect(opened.filter((item) => !item.id.startsWith('image'))).toEqual(nodes.filter((item) => !item.id.startsWith('image')))
  })

  it('opens a missing lane in lane order and reuses an empty row without moving tiles', () => {
    const sourcesAndImages = [laneCell('source', 'video', 0, 0), laneCell('image', 'image', 1, 0)]
    expect(notebookCreationPlacement('generate_video', sourcesAndImages)).toEqual({ slot: { row: 1, column: 0 }, makeRoom: true })
    expect(notebookCreationPlacement('video', [laneCell('gen', 'generate_video', 0, 0)])).toEqual({ slot: { row: 0, column: 0 }, makeRoom: true })
    expect(notebookCreationPlacement('image', [laneCell('source', 'video', 0, 0), laneCell('gen', 'generate_video', 1, 0)]))
      .toEqual({ slot: { row: 2, column: 0 }, makeRoom: false })
    expect(notebookCreationPlacement('generate_image', [])).toEqual({ slot: { row: 0, column: 0 }, makeRoom: false })
  })

  it('stops moving rows at the first empty row and steps over Timeline rows', () => {
    const cells = [
      laneCell('image', 'image', 0, 0),
      laneCell('timeline', 'timeline', 1, 0),
      laneCell('video', 'video', 2, 3),
      laneCell('audio', 'audio', 4, 0),
    ]
    expect(notebookRowOpening(cells, 0)).toEqual(new Map([
      ['image', { row: 2, column: 0 }],
      ['video', { row: 3, column: 3 }],
    ]))
    expect(notebookRowOpening(cells, 3)).toEqual(new Map())
  })

  it('falls back to the first empty square when no row can be opened', () => {
    const cells = Array.from({ length: NOTEBOOK_GRID_ROW_COUNT }, (_, row) => laneCell(`image-${row}`, 'image', row, 0))
    expect(notebookCreationPlacement('generate_video', cells)).toEqual({ slot: { row: 0, column: 1 }, makeRoom: false })
    const full = Array.from({ length: NOTEBOOK_GRID_CAPACITY }, (_, index) => laneCell(
      `image-${index}`,
      'image',
      Math.floor(index / NOTEBOOK_GRID_COLUMN_COUNT),
      index % NOTEBOOK_GRID_COLUMN_COUNT,
    ))
    expect(() => notebookCreationPlacement('generate_video', full)).toThrow(NOTEBOOK_GRID_FULL_ERROR)
  })

  it('scans the grid horizontally and vertically from an anchor', () => {
    expect(nextHorizontalSlotFrom(
      { row: 0, column: 3 },
      [{ row: 0, column: 0 }, { row: 0, column: 1 }, { row: 0, column: 2 }],
    )).toEqual({ row: 0, column: 3 })

    expect(nextVerticalSlotFrom(
      { row: 1, column: 0 },
      [{ row: 1, column: 0 }],
    )).toEqual({ row: 2, column: 0 })

    const full = Array.from({ length: NOTEBOOK_GRID_CAPACITY }, (_, index) => ({
      row: Math.floor(index / NOTEBOOK_GRID_COLUMN_COUNT),
      column: index % NOTEBOOK_GRID_COLUMN_COUNT,
    }))
    expect(() => nextVerticalSlotFrom({ row: 0, column: 0 }, full))
      .toThrow(NOTEBOOK_GRID_FULL_ERROR)
  })

  it('keeps eight columns and grows visible rows to one trailing row', () => {
    expect(notebookGridMetrics([
      { row: 0, column: 0 },
      { row: 9, column: 7 },
    ])).toEqual({
      rowCount: 11,
      columnCount: 8,
      minColumn: 0,
      maxColumn: 7,
      centerX: 1044,
      width: 2088,
      height: 2880,
    })
    expect(notebookGridMetrics([], {
      viewportWidth: 2048,
      viewportHeight: 900,
      zoom: 0.75,
    })).toEqual({
      rowCount: 5,
      columnCount: 8,
      minColumn: 0,
      maxColumn: 7,
      centerX: 1044,
      width: 2088,
      height: 1296,
    })
    expect(notebookGridMetrics([]).rowCount).toBe(3)
    expect(notebookGridMetrics([{ row: 63, column: 7 }]).rowCount).toBe(64)
  })

  it('bounds edge drops and starts the viewport at the top left', () => {
    const metrics = notebookGridMetrics([{ row: 5, column: 0 }])
    expect(notebookGridDropSlot({ x: -100, y: -100 }, metrics))
      .toEqual({ row: 0, column: 0 })
    expect(notebookGridDropSlot({ x: 100_000, y: 100_000 }, metrics))
      .toEqual({ row: NOTEBOOK_GRID_ROW_COUNT - 1, column: NOTEBOOK_GRID_COLUMN_COUNT - 1 })
    expect(notebookGridFrameSize(notebookGridMetrics([]), 1.5)).toEqual({
      width: 3132,
      height: 1152,
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
    expect(notebookGridSquareAt({ x: 0, y: 0 }, metrics))
      .toEqual({ row: 0, column: 0 })
  })

  it('keeps any positive zoom and falls back to 1 for invalid zoom', () => {
    expect(normalizeNotebookGridZoom(0.1)).toBe(0.1)
    expect(normalizeNotebookGridZoom(0.635)).toBe(0.635)
    expect(normalizeNotebookGridZoom(1.2)).toBe(1.2)
    expect(normalizeNotebookGridZoom(0)).toBe(1)
    expect(normalizeNotebookGridZoom(-1)).toBe(1)
    expect(normalizeNotebookGridZoom(Number.NaN)).toBe(1)
  })

  it('fits all eight columns across the full measured width at any size', () => {
    const metrics = notebookGridMetrics([])
    for (const width of [370, 968, 1224, 1384, 1864, 2504, 3784]) {
      const zoom = fitNotebookGridZoom(width)
      const frame = notebookGridFrameSize(metrics, zoom)
      expect(frame.width).toBeCloseTo(width)
      expect(notebookGridViewport(metrics, zoom).zoom).toBe(zoom)
      expect(frame.height).toBeCloseTo(metrics.height * zoom)
    }
    expect(fitNotebookGridZoom(1224) * notebookGrid.squareSize).toBeCloseTo(140.69, 2)
    expect(fitNotebookGridZoom(2504) * notebookGrid.squareSize).toBeCloseTo(287.82, 2)
    expect(fitNotebookGridZoom(0)).toBe(1)
    expect(fitNotebookGridZoom(Number.NaN)).toBe(1)
    expect(notebookGridMetrics([], { viewportHeight: 600, zoom: 0.6 }).rowCount).toBe(4)
  })

  it('shrinks the fit so the first three rows show in a short, wide viewport', () => {
    const threeRows = 3 * notebookGrid.rowPitch - notebookGrid.gap
    expect(fitNotebookGridZoom(2000, 0, 600)).toBeCloseTo(600 / threeRows)
    expect(fitNotebookGridZoom(1224, 0, 2000)).toBe(fitNotebookGridZoom(1224))
    expect(fitNotebookGridZoom(2000, 0.5, 200)).toBe(0.5)
  })

  it('keeps cell details at screen size until cells drop below half scale', () => {
    expect(notebookGridDetailScale(1.2)).toBeCloseTo(1 / 1.2)
    expect(notebookGridDetailScale(0.6)).toBeCloseTo(1 / 0.6)
    expect(notebookGridDetailScale(0.5)).toBe(2)
    expect(notebookGridDetailScale(0.4636)).toBe(2)
    expect(notebookGridDetailScale(Number.NaN)).toBe(1)
  })

  it('holds a minimum zoom only when the layout asks for one', () => {
    expect(fitNotebookGridZoom(370, 0.5)).toBe(0.5)
    expect(fitNotebookGridZoom(1864, 0.5)).toBeCloseTo(1864 / 2088)
    expect(fitNotebookGridZoom(370, Number.NaN)).toBeCloseTo(370 / 2088)
  })
})
