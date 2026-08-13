import type { Node, XYPosition } from '@xyflow/react'
import {
  firstEmptyNotebookGridSlot,
  isNotebookGridSlot,
  nearestOriginNotebookGridSlot,
  nextHorizontalSlotFrom,
  nextVerticalSlotFrom,
  nextWaveTileSlot,
  NOTEBOOK_GRID_COLUMN_COUNT,
  NOTEBOOK_GRID_ROW_COUNT,
  notebookGridAddress,
  notebookGridTag,
  parseNotebookGridAddress,
} from 'videobook-engine/notebook-grid'
import type { NotebookGridSlot } from 'videobook-engine'

export interface NotebookGridData extends Record<string, unknown> {
  slot: NotebookGridSlot
}

export const notebookGrid = {
  /* Origins are 0: the scroll container's --notebook-chrome-inset margin in
     src/index.css supplies the 20px gutter, so the first cell lands on the
     same line as the header logo and the horizontal scrollbar track. */
  originX: 0,
  originY: 0,
  squareSize: 240,
  gap: 40,
  columnPitch: 280,
  rowPitch: 280,
  columnCount: NOTEBOOK_GRID_COLUMN_COUNT,
  maximumRowCount: NOTEBOOK_GRID_ROW_COUNT,
  minimumRowCount: 3,
  trailingRowCount: 1,
  minimumZoom: 0.5,
  maximumZoom: 2,
  zoomStep: 0.25,
} as const

function roundedSlot(slot: NotebookGridSlot): NotebookGridSlot {
  return {
    row: Math.round(slot.row),
    column: Math.round(slot.column),
  }
}

function boundedSlot(slot: NotebookGridSlot): NotebookGridSlot {
  const rounded = roundedSlot(slot)
  return {
    row: Math.min(
      NOTEBOOK_GRID_ROW_COUNT - 1,
      Math.max(0, rounded.row),
    ),
    column: Math.min(
      NOTEBOOK_GRID_COLUMN_COUNT - 1,
      Math.max(0, rounded.column),
    ),
  }
}

export function notebookGridSlotKey(slot: NotebookGridSlot): string {
  return `${slot.row}:${slot.column}`
}

export function notebookGridSlot(position: XYPosition): NotebookGridSlot {
  return boundedSlot({
    row: Math.round((position.y - notebookGrid.originY) / notebookGrid.rowPitch),
    column: Math.round(
      (position.x - notebookGrid.originX) / notebookGrid.columnPitch,
    ),
  })
}

export function notebookGridPosition(slot: NotebookGridSlot): XYPosition {
  const bounded = boundedSlot(slot)
  return {
    x: notebookGrid.originX + bounded.column * notebookGrid.columnPitch,
    y: notebookGrid.originY + bounded.row * notebookGrid.rowPitch,
  }
}

export function snapNotebookGridMove<T extends NotebookGridData>(
  nodes: readonly Node<T>[],
  id: string,
  requested: NotebookGridSlot,
): Array<Node<T>> {
  const slot = boundedSlot(requested)
  return nodes.map((node) => node.id === id
    ? { ...node, position: notebookGridPosition(slot) }
    : node)
}

export function resolveNotebookGridMove<T extends NotebookGridData>(
  nodes: readonly Node<T>[],
  id: string,
  requested: NotebookGridSlot,
): Array<Node<T>> {
  const moving = nodes.find((node) => node.id === id)
  if (!moving) return [...nodes]
  const target = boundedSlot(requested)
  const source = moving.data.slot
  const occupied = nodes.find((node) =>
    node.id !== id
    && notebookGridSlotKey(node.data.slot) === notebookGridSlotKey(target))

  return nodes.map((node) => {
    const slot = node.id === id
      ? target
      : node.id === occupied?.id
        ? source
        : null
    if (!slot) return node
    return {
      ...node,
      position: notebookGridPosition(slot),
      data: { ...node.data, slot },
    }
  })
}

export function resolveNotebookGridGroupMove<T extends NotebookGridData>(
  nodes: readonly Node<T>[],
  anchorId: string,
  movingNodeIds: readonly string[],
  requested: NotebookGridSlot,
): Array<Node<T>> {
  const movingIds = new Set(movingNodeIds)
  movingIds.add(anchorId)
  const moving = nodes.filter((node) => movingIds.has(node.id))
  if (moving.length <= 1) {
    return resolveNotebookGridMove(nodes, anchorId, requested)
  }
  const anchor = moving.find((node) => node.id === anchorId)
  if (!anchor) return [...nodes]

  const target = roundedSlot(requested)
  const rowDelta = target.row - anchor.data.slot.row
  const columnDelta = target.column - anchor.data.slot.column
  const targets = new Map(moving.map((node) => {
    const slot = {
      row: node.data.slot.row + rowDelta,
      column: node.data.slot.column + columnDelta,
    }
    return [node.id, slot]
  }))
  const targetKeys = new Set(
    [...targets.values()].map(notebookGridSlotKey),
  )
  const rejected = [...targets.values()].some((slot) => !isNotebookGridSlot(slot))
    || nodes.some((node) =>
      !movingIds.has(node.id)
      && targetKeys.has(notebookGridSlotKey(node.data.slot)))

  if (rejected) {
    return nodes.map((node) => movingIds.has(node.id)
      ? { ...node, position: notebookGridPosition(node.data.slot) }
      : node)
  }

  return nodes.map((node) => {
    const slot = targets.get(node.id)
    if (!slot) return node
    return {
      ...node,
      position: notebookGridPosition(slot),
      data: { ...node.data, slot },
    }
  })
}

export function changedNotebookGridNodes<T extends NotebookGridData>(
  previous: readonly Node<T>[],
  next: readonly Node<T>[],
): Array<Node<T>> {
  const previousSlots = new Map(
    previous.map((node) => [node.id, notebookGridSlotKey(node.data.slot)]),
  )
  return next.filter((node) =>
    previousSlots.get(node.id) !== notebookGridSlotKey(node.data.slot))
}

export function nextNotebookGridSlot<T extends NotebookGridData>(
  nodes: readonly Node<T>[],
): NotebookGridSlot {
  return firstEmptyNotebookGridSlot(nodes.map((node) => node.data.slot))
}

const imageCellTypes = new Set([
  'image',
  'generate_image',
  'extract_frame',
  'character',
])

export function isNotebookImageCellType(type: string): boolean {
  return imageCellTypes.has(type)
}

export {
  nearestOriginNotebookGridSlot,
  nextHorizontalSlotFrom,
  nextVerticalSlotFrom,
  nextWaveTileSlot,
}

/**
 * Wave/lane placement for generate_video tiles. Sibling generations sourced
 * from the base image row pack left-to-right in the row below their sources;
 * generations fed by a derived image continue that image's column lane. Each
 * tile keeps the slot beneath it free for its video output cell.
 */
export function nextNotebookVideoGenerationSlot(
  cells: ReadonlyArray<{ type: string; slot: NotebookGridSlot }>,
  sourceSlots: readonly NotebookGridSlot[] = [],
): NotebookGridSlot {
  const occupied = cells.map((cell) => cell.slot)
  if (sourceSlots.length > 0) {
    const waveRow = Math.max(...sourceSlots.map((slot) => slot.row)) + 1
    const baseRowSources = sourceSlots.every((slot) => slot.row === 0)
    const startColumn = baseRowSources ? 0 : sourceSlots[0].column
    return nextWaveTileSlot(waveRow, startColumn, occupied)
  }
  let lastImageRow = -1
  for (const cell of cells) {
    if (!isNotebookImageCellType(cell.type)) continue
    if (cell.slot.row > lastImageRow) lastImageRow = cell.slot.row
  }
  return nextWaveTileSlot(lastImageRow + 1, 0, occupied)
}

/**
 * Reserve tile + output-below pair for generate_video so client optimistic
 * placement matches server-created output cells.
 */
export function allocateNotebookVideoGenerationSlots(
  cells: ReadonlyArray<{ type: string; slot: NotebookGridSlot }>,
  sourceSlots: readonly NotebookGridSlot[] = [],
): { tile: NotebookGridSlot; output: NotebookGridSlot } {
  const occupied = cells.map((cell) => cell.slot)
  const tile = nextNotebookVideoGenerationSlot(cells, sourceSlots)
  const below = tile.row + 1 < NOTEBOOK_GRID_ROW_COUNT
    ? { row: tile.row + 1, column: tile.column }
    : {
      row: tile.row,
      column: Math.min(tile.column + 1, NOTEBOOK_GRID_COLUMN_COUNT - 1),
    }
  const output = nextVerticalSlotFrom(below, [...occupied, tile])
  return { tile, output }
}

/** Horizontal placement for generate_image / extract_frame action tiles. */
export function nextNotebookHorizontalGenerationSlot(
  cells: ReadonlyArray<{ type: string; slot: NotebookGridSlot }>,
  sourceSlots: readonly NotebookGridSlot[] = [],
): NotebookGridSlot {
  const occupied = cells.map((cell) => cell.slot)
  if (sourceSlots.length === 0) {
    return nextHorizontalSlotFrom({ row: 0, column: 0 }, occupied)
  }
  const maxColumn = Math.max(...sourceSlots.map((slot) => slot.column))
  const minRow = Math.min(...sourceSlots.map((slot) => slot.row))
  const anchor = {
    row: minRow,
    column: Math.min(maxColumn + 1, NOTEBOOK_GRID_COLUMN_COUNT - 1),
  }
  return nextHorizontalSlotFrom(anchor, occupied)
}

export interface NotebookGridMetrics {
  rowCount: number
  columnCount: number
  minColumn: number
  maxColumn: number
  centerX: number
  width: number
  height: number
}

export interface NotebookGridMetricsOptions {
  preview?: NotebookGridSlot | null
  viewportWidth?: number
  viewportHeight?: number
  zoom?: number
}

export function normalizeNotebookGridZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1
  return Math.min(
    notebookGrid.maximumZoom,
    Math.max(notebookGrid.minimumZoom, zoom),
  )
}

function gridWidth(): number {
  return notebookGrid.originX * 2
    + NOTEBOOK_GRID_COLUMN_COUNT * notebookGrid.squareSize
    + (NOTEBOOK_GRID_COLUMN_COUNT - 1) * notebookGrid.gap
}

function fittingRowCount(viewportHeight: number, zoom: number): number {
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) {
    return notebookGrid.minimumRowCount
  }
  const target = viewportHeight / normalizeNotebookGridZoom(zoom)
  return Math.max(
    notebookGrid.minimumRowCount,
    Math.ceil(
      (target - notebookGrid.originY * 2 + notebookGrid.gap)
      / notebookGrid.rowPitch,
    ),
  )
}

export function notebookGridFrameSize(
  metrics: NotebookGridMetrics,
  zoom: number,
): { width: number; height: number } {
  const normalizedZoom = normalizeNotebookGridZoom(zoom)
  return {
    width: metrics.width * normalizedZoom,
    height: metrics.height * normalizedZoom,
  }
}

export function notebookGridViewport(
  _metrics: NotebookGridMetrics,
  zoom: number,
  y = 0,
): { x: number; y: number; zoom: number } {
  return {
    x: 0,
    y: Number.isFinite(y) ? y : 0,
    zoom: normalizeNotebookGridZoom(zoom),
  }
}

export function notebookGridDropSlot(
  position: XYPosition,
  _metrics: NotebookGridMetrics,
): NotebookGridSlot {
  return notebookGridSlot(position)
}

export function notebookGridSquareAt(
  position: XYPosition,
  metrics: NotebookGridMetrics,
): NotebookGridSlot | null {
  const offsetX = position.x - notebookGrid.originX
  const offsetY = position.y - notebookGrid.originY
  if (offsetX < 0 || offsetY < 0) return null

  const columnIndex = Math.floor(offsetX / notebookGrid.columnPitch)
  const row = Math.floor(offsetY / notebookGrid.rowPitch)
  if (
    columnIndex < 0
    || columnIndex >= metrics.columnCount
    || row < 0
    || row >= metrics.rowCount
  ) return null

  const column = metrics.minColumn + columnIndex
  if (column > metrics.maxColumn) return null
  if (
    offsetX - columnIndex * notebookGrid.columnPitch >= notebookGrid.squareSize
    || offsetY - row * notebookGrid.rowPitch >= notebookGrid.squareSize
  ) return null

  return { row, column }
}

export function notebookGridMetrics(
  slots: readonly NotebookGridSlot[],
  options: NotebookGridMetricsOptions = {},
): NotebookGridMetrics {
  const populated = options.preview ? [...slots, boundedSlot(options.preview)] : slots
  const highestOccupiedRow = Math.max(
    -1,
    ...populated.map((slot) => boundedSlot(slot).row),
  )
  const rowCount = Math.min(
    NOTEBOOK_GRID_ROW_COUNT,
    Math.max(
      notebookGrid.minimumRowCount,
      fittingRowCount(options.viewportHeight ?? 0, options.zoom ?? 1),
      highestOccupiedRow + 2,
    ),
  )
  const width = gridWidth()
  const height = notebookGrid.originY * 2
    + rowCount * notebookGrid.squareSize
    + Math.max(0, rowCount - 1) * notebookGrid.gap
  return {
    rowCount,
    columnCount: NOTEBOOK_GRID_COLUMN_COUNT,
    minColumn: 0,
    maxColumn: NOTEBOOK_GRID_COLUMN_COUNT - 1,
    centerX: width / 2,
    width,
    height,
  }
}

export {
  notebookGridAddress,
  notebookGridTag,
  parseNotebookGridAddress,
}
export type { NotebookGridSlot }
