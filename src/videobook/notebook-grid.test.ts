import type { Node } from '@xyflow/react'
import { describe, expect, it } from 'vitest'
import {
  allocateNotebookHorizontalGenerationSlots,
  allocateNotebookVideoGenerationSlots,
  changedNotebookGridNodes,
  fitNotebookGridZoom,
  nextHorizontalSlotFrom,
  nextNotebookCreationSlot,
  nextNotebookGridSlot,
  nextNotebookHorizontalGenerationSlot,
  nextNotebookVideoGenerationSlot,
  nextVerticalSlotFrom,
  normalizeNotebookGridZoom,
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
  resolveNotebookGridGroupMove,
  resolveNotebookGridMove,
  snapNotebookGridMove,
  type NotebookGridData,
} from './notebook-grid'
import {
  NOTEBOOK_GRID_CAPACITY,
  NOTEBOOK_GRID_COLUMN_COUNT,
  NOTEBOOK_GRID_FULL_ERROR,
  NOTEBOOK_GRID_ROW_COUNT,
} from 'videobook-engine/notebook-grid'

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
    const row = { type: 'timeline' as const, slot: timeline.data.slot }
    expect(nextNotebookGridSlot([timeline, ...Array.from({ length: 8 }, (_, column) => node(String(column), 0, column))]))
      .toEqual({ row: 2, column: 0 })
    expect(nextNotebookCreationSlot('timeline', [row, { type: 'image', slot: { row: 0, column: 7 } }]))
      .toEqual({ row: 2, column: 0 })
    expect(nextNotebookVideoGenerationSlot([row, { type: 'image', slot: { row: 0, column: 0 } }]))
      .toEqual({ row: 2, column: 0 })
    expect(() => nextNotebookCreationSlot('timeline', Array.from({ length: 64 }, (_, row) => ({ type: 'image' as const, slot: { row, column: 7 } }))))
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

  it('packs generation waves horizontally with room for outputs below', () => {
    // Row below the image band, skipping occupied columns.
    expect(nextNotebookVideoGenerationSlot([
      { type: 'image', slot: { row: 0, column: 0 } },
      { type: 'image', slot: { row: 0, column: 2 } },
      { type: 'prompt', slot: { row: 1, column: 0 } },
    ])).toEqual({ row: 1, column: 1 })

    // Sibling generation joins the wave row beside the first tile.
    expect(nextNotebookVideoGenerationSlot([
      { type: 'image', slot: { row: 0, column: 0 } },
      { type: 'generate_video', slot: { row: 1, column: 0 } },
      { type: 'video', slot: { row: 2, column: 0 } },
    ])).toEqual({ row: 1, column: 1 })

    // Base-row sources pack the wave from column 1.
    expect(nextNotebookVideoGenerationSlot(
      [
        { type: 'image', slot: { row: 0, column: 2 } },
        { type: 'image', slot: { row: 0, column: 3 } },
      ],
      [{ row: 0, column: 2 }, { row: 0, column: 3 }],
    )).toEqual({ row: 1, column: 0 })

    // A derived image source starts a lane in its own column.
    expect(nextNotebookVideoGenerationSlot(
      [{ type: 'image', slot: { row: 3, column: 2 } }],
      [{ row: 3, column: 2 }],
    )).toEqual({ row: 4, column: 2 })

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
      tile: { row: 0, column: 1 },
      output: { row: 1, column: 1 },
    })
  })

  it('anchors no-source image/audio work right of last-work and skips occupied', () => {
    const lastWork = { row: 5, column: 3 }
    expect(nextNotebookHorizontalGenerationSlot(
      [{ type: 'prompt', slot: lastWork }],
      [],
      lastWork,
    )).toEqual({ row: 5, column: 4 })

    expect(nextNotebookHorizontalGenerationSlot(
      [
        { type: 'prompt', slot: lastWork },
        { type: 'generate_image', slot: { row: 5, column: 4 } },
        { type: 'image', slot: { row: 5, column: 5 } },
      ],
      [],
      lastWork,
    )).toEqual({ row: 5, column: 6 })

    const pair = allocateNotebookHorizontalGenerationSlots(
      [{ type: 'prompt', slot: lastWork }],
      [],
      lastWork,
    )
    expect(pair).toEqual({
      tile: { row: 5, column: 4 },
      output: { row: 5, column: 5 },
    })
    const secondPair = allocateNotebookHorizontalGenerationSlots(
      [
        { type: 'prompt', slot: lastWork },
        { type: 'generate_image', slot: pair.tile },
        { type: 'image', slot: pair.output },
      ],
      [],
      lastWork,
    )
    expect(secondPair).toEqual({
      tile: { row: 5, column: 6 },
      output: { row: 5, column: 7 },
    })
  })

  it('anchors no-source video work below last-work and skips occupied', () => {
    const lastWork = { row: 5, column: 3 }
    expect(nextNotebookVideoGenerationSlot(
      [{ type: 'prompt', slot: lastWork }],
      [],
      lastWork,
    )).toEqual({ row: 6, column: 3 })

    const pair = allocateNotebookVideoGenerationSlots(
      [{ type: 'prompt', slot: lastWork }],
      [],
      lastWork,
    )
    expect(pair).toEqual({
      tile: { row: 6, column: 3 },
      output: { row: 7, column: 3 },
    })
    const secondPair = allocateNotebookVideoGenerationSlots(
      [
        { type: 'prompt', slot: lastWork },
        { type: 'generate_video', slot: pair.tile },
        { type: 'video', slot: pair.output },
      ],
      [],
      lastWork,
    )
    expect(secondPair).toEqual({
      tile: { row: 8, column: 3 },
      output: { row: 9, column: 3 },
    })
  })

  it('clamps last-work scans at @h* and @*64 without leaving the board', () => {
    const lastColumn = { row: 4, column: NOTEBOOK_GRID_COLUMN_COUNT - 1 }
    expect(nextNotebookHorizontalGenerationSlot(
      [{ type: 'prompt', slot: lastColumn }],
      [],
      lastColumn,
    )).toEqual({ row: 5, column: NOTEBOOK_GRID_COLUMN_COUNT - 1 })
    expect(allocateNotebookHorizontalGenerationSlots(
      [{ type: 'prompt', slot: lastColumn }],
      [],
      lastColumn,
    )).toEqual({
      tile: { row: 5, column: NOTEBOOK_GRID_COLUMN_COUNT - 1 },
      output: { row: 6, column: NOTEBOOK_GRID_COLUMN_COUNT - 1 },
    })

    const lastRow = { row: NOTEBOOK_GRID_ROW_COUNT - 1, column: 4 }
    expect(nextNotebookVideoGenerationSlot(
      [{ type: 'prompt', slot: lastRow }],
      [],
      lastRow,
    )).toEqual({ row: NOTEBOOK_GRID_ROW_COUNT - 1, column: 5 })
    expect(allocateNotebookVideoGenerationSlots(
      [{ type: 'prompt', slot: lastRow }],
      [],
      lastRow,
    )).toEqual({
      tile: { row: NOTEBOOK_GRID_ROW_COUNT - 1, column: 5 },
      output: { row: NOTEBOOK_GRID_ROW_COUNT - 1, column: 6 },
    })

    expect(nextNotebookHorizontalGenerationSlot(
      [],
      [],
      { row: 100, column: -4 },
    )).toEqual({ row: NOTEBOOK_GRID_ROW_COUNT - 1, column: 0 })
  })

  it('keeps source-fed placement even when a last-work anchor is set', () => {
    const lastWork = { row: 8, column: 6 }
    expect(nextNotebookHorizontalGenerationSlot(
      [{ type: 'video', slot: { row: 2, column: 0 } }],
      [{ row: 2, column: 0 }],
      lastWork,
    )).toEqual({ row: 2, column: 1 })
    expect(nextNotebookVideoGenerationSlot(
      [{ type: 'image', slot: { row: 3, column: 2 } }],
      [{ row: 3, column: 2 }],
      lastWork,
    )).toEqual({ row: 4, column: 2 })
  })

  it('uses last-work for no-source creation by media kind', () => {
    const lastWork = { row: 6, column: 2 }
    const cells = [{ type: 'prompt', slot: lastWork }]
    expect(nextNotebookCreationSlot('generate_audio', cells, lastWork))
      .toEqual({ row: 6, column: 3 })
    expect(nextNotebookCreationSlot('generate_video', cells, lastWork))
      .toEqual({ row: 7, column: 2 })
    expect(nextNotebookCreationSlot('prompt', cells, lastWork))
      .toEqual({ row: 6, column: 3 })
    expect(nextNotebookCreationSlot('prompt', cells, null))
      .toEqual({ row: 0, column: 0 })
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
