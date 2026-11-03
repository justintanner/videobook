import type { Node, XYPosition } from '@xyflow/react'
import {
  firstEmptyNotebookGridSlot,
  firstEmptyNotebookGridRow,
  notebookCellOccupiedSlots,
  notebookOccupiedSlots,
  isNotebookGridSlot,
  NOTEBOOK_GRID_COLUMN_COUNT,
  NOTEBOOK_GRID_ROW_COUNT,
  notebookGridAddress,
  notebookGridTag,
  parseNotebookGridAddress,
} from 'videobook-engine/notebook-grid'
import type { NotebookCellType, NotebookGridSlot } from 'videobook-engine'
import {
  notebookLanePlacement,
  notebookRowOpening,
  notebookTypeLane,
  type NotebookLaneCell,
  type NotebookLanePlacement,
} from '../../server/src/notebook-lanes'

export interface NotebookGridData extends Record<string, unknown> {
  slot: NotebookGridSlot
}

export const notebookGrid = {
  /* Origins are 0: the scroll container's --notebook-chrome-inset margin in
     src/index.css supplies the page gutter, so the first cell lands on the
     same line as the header logo. */
  originX: 0,
  originY: 0,
  squareSize: 240,
  gap: 24,
  columnPitch: 264,
  rowPitch: 264,
  columnCount: NOTEBOOK_GRID_COLUMN_COUNT,
  maximumRowCount: NOTEBOOK_GRID_ROW_COUNT,
  minimumRowCount: 3,
  fitRowCount: 3,
  trailingRowCount: 1,
  detailZoomFloor: 0.5,
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
  const moving = nodes.find((node) => node.id === id)
  const slot = boundedSlot(moving?.data.kind === 'timeline' ? { ...requested, column: 0 } : requested)
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
  const target = boundedSlot(moving.data.kind === 'timeline' ? { ...requested, column: 0 } : requested)
  const source = moving.data.slot
  const targetKeys = new Set(notebookCellOccupiedSlots({ type: String(moving.data.kind), slot: target }).map(notebookGridSlotKey))
  const occupied = nodes.find((node) =>
    node.id !== id
    && notebookCellOccupiedSlots({ type: String(node.data.kind), slot: node.data.slot })
      .some((slot) => targetKeys.has(notebookGridSlotKey(slot))))
  if (occupied && (moving.data.kind === 'timeline' || occupied.data.kind === 'timeline')) {
    return nodes.map((node) => node.id === id
      ? { ...node, position: notebookGridPosition(source) }
      : node)
  }

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
    moving.flatMap((node) => notebookCellOccupiedSlots({
      type: String(node.data.kind), slot: targets.get(node.id)!,
    })).map(notebookGridSlotKey),
  )
  const rejected = [...targets.values()].some((slot) => !isNotebookGridSlot(slot))
    || moving.some((node) => node.data.kind === 'timeline' && columnDelta !== 0)
    || nodes.some((node) =>
      !movingIds.has(node.id)
      && notebookCellOccupiedSlots({ type: String(node.data.kind), slot: node.data.slot })
        .some((slot) => targetKeys.has(notebookGridSlotKey(slot))))

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
  return firstEmptyNotebookGridSlot(nodes.flatMap((node) => notebookCellOccupiedSlots({
    type: String(node.data.kind), slot: node.data.slot,
  })))
}

export function openNotebookGridNodeRow<T extends NotebookGridData & { kind: string }>(
  nodes: readonly Node<T>[],
  row: number,
): Array<Node<T>> {
  const moves = notebookRowOpening(
    nodes.map((node) => ({ id: node.id, type: node.data.kind, slot: node.data.slot })),
    row,
  )
  if (!moves) return [...nodes]
  return nodes.map((node) => {
    const slot = moves.get(node.id)
    return slot
      ? { ...node, position: notebookGridPosition(slot), data: { ...node.data, slot } }
      : node
  })
}

export function notebookCreationPlacement(
  type: NotebookCellType,
  cells: readonly NotebookLaneCell[],
): NotebookLanePlacement {
  if (type === 'timeline') {
    return { slot: firstEmptyNotebookGridRow(notebookOccupiedSlots(cells)), makeRoom: false }
  }
  return notebookLanePlacement(cells, notebookTypeLane(type))
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

interface NotebookGridMetricsOptions {
  preview?: NotebookGridSlot | null
  viewportWidth?: number
  viewportHeight?: number
  zoom?: number
}

export function normalizeNotebookGridZoom(zoom: number): number {
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1
}

export function notebookGridDetailScale(zoom: number): number {
  return 1 / Math.max(normalizeNotebookGridZoom(zoom), notebookGrid.detailZoomFloor)
}

export function fitNotebookGridZoom(
  viewportWidth: number,
  minimumZoom = 0,
  viewportHeight = 0,
): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return 1
  const widthZoom = viewportWidth / gridWidth()
  const heightZoom = Number.isFinite(viewportHeight) && viewportHeight > 0
    ? viewportHeight / firstRowsHeight()
    : widthZoom
  return Math.max(
    Number.isFinite(minimumZoom) ? minimumZoom : 0,
    Math.min(widthZoom, heightZoom),
  )
}

function firstRowsHeight(): number {
  return notebookGrid.originY * 2
    + notebookGrid.fitRowCount * notebookGrid.rowPitch
    - notebookGrid.gap
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
