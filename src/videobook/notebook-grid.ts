import type { Node, XYPosition } from '@xyflow/react'
import type { NotebookGridSlot } from 'videobook-engine'

export interface NotebookGridData extends Record<string, unknown> {
  slot: NotebookGridSlot
}

export const notebookGrid = {
  originX: 48,
  originY: 112,
  headingY: 64,
  squareSize: 240,
  gap: 40,
  columnPitch: 280,
  rowPitch: 280,
  defaultColumnCount: 7,
  minimumRowCount: 3,
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

export function notebookGridHeadingPosition(column: number): XYPosition {
  return {
    x: Math.round(column) * notebookGrid.columnPitch,
    y: notebookGrid.headingY,
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

export function normalizeNotebookGridZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1
  return Math.min(
    notebookGrid.maximumZoom,
    Math.max(notebookGrid.minimumZoom, zoom),
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
  return notebookGridSlot(position)
}

export function notebookGridMetrics(
  slots: readonly NotebookGridSlot[],
  columnCount = notebookGrid.defaultColumnCount,
  preview: NotebookGridSlot | null = null,
): NotebookGridMetrics {
  const populated = preview ? [...slots, preview] : [...slots]
  const maxRow = Math.max(
    notebookGrid.minimumRowCount - 1,
    ...populated.map((slot) => slot.row),
  )
  const minimumRadius = Math.floor(normalizedColumnCount(columnCount) / 2)
  const radius = Math.max(
    minimumRadius,
    ...populated.map((slot) => Math.abs(slot.column)),
  )
  const resolvedColumnCount = radius * 2 + 1
  const width = notebookGrid.originX * 2
    + resolvedColumnCount * notebookGrid.squareSize
    + Math.max(0, resolvedColumnCount - 1) * notebookGrid.gap
  const height = notebookGrid.originY * 2
    + (maxRow + 1) * notebookGrid.squareSize
    + maxRow * notebookGrid.gap
  return {
    rowCount: maxRow + 1,
    columnCount: resolvedColumnCount,
    minColumn: -radius,
    maxColumn: radius,
    centerX: notebookGrid.originX + radius * notebookGrid.columnPitch,
    width,
    height,
  }
}

export type { NotebookGridSlot } from 'videobook-engine'
