import type { Node, XYPosition } from '@xyflow/react'
import type { NotebookGridSlot } from 'videobook-engine'

export interface NotebookGridData extends Record<string, unknown> {
  slot: NotebookGridSlot
}

export const notebookGrid = {
  originX: 48,
  originY: 48,
  squareSize: 240,
  gap: 40,
  columnPitch: 280,
  rowPitch: 280,
  defaultColumnCount: 7,
  minimumRowCount: 3,
  trailingRowCount: 2,
  minimumZoom: 0.5,
  maximumZoom: 2,
  zoomStep: 0.25,
} as const

function normalizedSlot(slot: NotebookGridSlot): NotebookGridSlot {
  return {
    row: Math.max(0, Math.round(slot.row)),
    column: Math.round(slot.column),
  }
}

export function notebookGridSlotKey(slot: NotebookGridSlot): string {
  return `${slot.row}:${slot.column}`
}

function normalizedColumnCount(columnCount: number): number {
  const count = Math.max(1, Math.round(columnCount))
  return count % 2 === 0 ? count + 1 : count
}

function centerOutColumns(columnCount: number): number[] {
  const radius = Math.floor(normalizedColumnCount(columnCount) / 2)
  return Array.from({ length: radius * 2 + 1 }, (_, index) => {
    if (index === 0) return 0
    const distance = Math.ceil(index / 2)
    return index % 2 === 1 ? -distance : distance
  })
}

export function notebookGridSlot(
  position: XYPosition,
): NotebookGridSlot {
  return normalizedSlot({
    row: Math.round((position.y - notebookGrid.originY) / notebookGrid.rowPitch),
    column: Math.round(position.x / notebookGrid.columnPitch),
  })
}

export function notebookGridPosition(slot: NotebookGridSlot): XYPosition {
  return {
    x: slot.column * notebookGrid.columnPitch,
    y: notebookGrid.originY + slot.row * notebookGrid.rowPitch,
  }
}

export function snapNotebookGridMove<T extends NotebookGridData>(
  nodes: readonly Node<T>[],
  id: string,
  requested: NotebookGridSlot,
): Array<Node<T>> {
  const slot = normalizedSlot(requested)
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
  const target = normalizedSlot(requested)
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

  const target = normalizedSlot(requested)
  const minimumRow = Math.min(...moving.map((node) => node.data.slot.row))
  const rowDelta = Math.max(
    target.row - anchor.data.slot.row,
    -minimumRow,
  )
  const columnDelta = target.column - anchor.data.slot.column
  const targets = new Map(moving.map((node) => {
    const slot = normalizedSlot({
      row: node.data.slot.row + rowDelta,
      column: node.data.slot.column + columnDelta,
    })
    return [node.id, slot]
  }))
  const targetKeys = new Set(
    [...targets.values()].map(notebookGridSlotKey),
  )
  const occupied = nodes.some((node) =>
    !movingIds.has(node.id)
    && targetKeys.has(notebookGridSlotKey(node.data.slot)))

  if (occupied) {
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

export function nextNotebookGridSlot<T extends NotebookGridData>(
  nodes: readonly Node<T>[],
  columnCount = notebookGrid.defaultColumnCount,
): NotebookGridSlot {
  const occupied = new Set(nodes.map((node) => notebookGridSlotKey(node.data.slot)))
  const columns = centerOutColumns(columnCount)
  for (let row = 0; ; row += 1) {
    for (const column of columns) {
      const slot = { row, column }
      if (!occupied.has(notebookGridSlotKey(slot))) return slot
    }
  }
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

function gridWidth(columnCount: number): number {
  return notebookGrid.originX * 2
    + columnCount * notebookGrid.squareSize
    + Math.max(0, columnCount - 1) * notebookGrid.gap
}

function fittingColumnCount(viewportWidth: number, zoom: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return notebookGrid.defaultColumnCount
  }
  const target = viewportWidth / normalizeNotebookGridZoom(zoom)
  const estimate = Math.max(
    1,
    Math.round(
      (target - notebookGrid.originX * 2 + notebookGrid.gap)
      / notebookGrid.columnPitch,
    ),
  )
  const lower = estimate % 2 === 0 ? Math.max(1, estimate - 1) : estimate
  const upper = lower + 2
  const nearest = Math.abs(gridWidth(lower) - target)
    <= Math.abs(gridWidth(upper) - target)
    ? lower
    : upper
  return Math.max(notebookGrid.defaultColumnCount, nearest)
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
  metrics: NotebookGridMetrics,
  zoom: number,
  y = 0,
): { x: number; y: number; zoom: number } {
  const normalizedZoom = normalizeNotebookGridZoom(zoom)
  return {
    x: metrics.centerX * normalizedZoom,
    y: Number.isFinite(y) ? y : 0,
    zoom: normalizedZoom,
  }
}

export function notebookGridDropSlot(
  position: XYPosition,
  metrics: NotebookGridMetrics,
): NotebookGridSlot {
  if (position.x < metrics.minColumn * notebookGrid.columnPitch) {
    return normalizedSlot({
      row: Math.round((position.y - notebookGrid.originY) / notebookGrid.rowPitch),
      column: metrics.minColumn - 1,
    })
  }
  if (
    position.x
    > metrics.maxColumn * notebookGrid.columnPitch + notebookGrid.squareSize
  ) {
    return normalizedSlot({
      row: Math.round((position.y - notebookGrid.originY) / notebookGrid.rowPitch),
      column: metrics.maxColumn + 1,
    })
  }
  const bottom = notebookGrid.originY
    + (metrics.rowCount - 1) * notebookGrid.rowPitch
    + notebookGrid.squareSize
  if (position.y > bottom) {
    return {
      row: metrics.rowCount,
      column: Math.round(position.x / notebookGrid.columnPitch),
    }
  }
  return notebookGridSlot(position)
}

export function notebookGridMetrics(
  slots: readonly NotebookGridSlot[],
  options: NotebookGridMetricsOptions = {},
): NotebookGridMetrics {
  const preview = options.preview ?? null
  const populated = preview ? [...slots, preview] : [...slots]
  const contentRowCount = Math.max(
    0,
    ...populated.map((slot) => slot.row + 1),
  )
  const rowCount = Math.max(
    fittingRowCount(options.viewportHeight ?? 0, options.zoom ?? 1),
    contentRowCount + notebookGrid.trailingRowCount,
  )
  const minimumRadius = Math.floor(
    normalizedColumnCount(
      fittingColumnCount(options.viewportWidth ?? 0, options.zoom ?? 1),
    ) / 2,
  )
  const radius = Math.max(
    minimumRadius,
    ...populated.map((slot) => Math.abs(slot.column)),
  )
  const resolvedColumnCount = radius * 2 + 1
  const width = gridWidth(resolvedColumnCount)
  const height = notebookGrid.originY * 2
    + rowCount * notebookGrid.squareSize
    + Math.max(0, rowCount - 1) * notebookGrid.gap
  return {
    rowCount,
    columnCount: resolvedColumnCount,
    minColumn: -radius,
    maxColumn: radius,
    centerX: notebookGrid.originX + radius * notebookGrid.columnPitch,
    width,
    height,
  }
}

export type { NotebookGridSlot } from 'videobook-engine'
