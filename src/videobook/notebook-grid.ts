import type { Node, XYPosition } from '@xyflow/react'
import type { NotebookGridSlot } from 'videobook-engine'

export interface NotebookGridData extends Record<string, unknown> {
  slot: NotebookGridSlot
}

export const notebookGrid = {
  originX: 48,
  originY: 72,
  squareSize: 240,
  gap: 40,
  columnPitch: 280,
  rowPitch: 280,
  defaultColumnCount: 4,
  minimumRowCount: 3,
} as const

function normalizedSlot(slot: NotebookGridSlot): NotebookGridSlot {
  return {
    row: Math.max(0, Math.round(slot.row)),
    column: Math.max(0, Math.round(slot.column)),
  }
}

function slotKey(slot: NotebookGridSlot): string {
  return `${slot.row}:${slot.column}`
}

export function notebookGridSlot(
  position: XYPosition,
): NotebookGridSlot {
  return normalizedSlot({
    row: Math.round((position.y - notebookGrid.originY) / notebookGrid.rowPitch),
    column: Math.round(
      (position.x - notebookGrid.originX) / notebookGrid.columnPitch,
    ),
  })
}

export function notebookGridPosition(slot: NotebookGridSlot): XYPosition {
  return {
    x: notebookGrid.originX + slot.column * notebookGrid.columnPitch,
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
    node.id !== id && slotKey(node.data.slot) === slotKey(target))

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
  const occupied = new Set(nodes.map((node) => slotKey(node.data.slot)))
  for (let ordinal = 0; ; ordinal += 1) {
    const slot = {
      row: Math.floor(ordinal / columnCount),
      column: ordinal % columnCount,
    }
    if (!occupied.has(slotKey(slot))) return slot
  }
}

export interface NotebookGridMetrics {
  rowCount: number
  columnCount: number
  width: number
  height: number
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
  const maxColumn = Math.max(
    columnCount - 1,
    ...populated.map((slot) => slot.column),
  )
  const resolvedColumnCount = maxColumn + 1
  const width = notebookGrid.originX * 2
    + resolvedColumnCount * notebookGrid.squareSize
    + Math.max(0, resolvedColumnCount - 1) * notebookGrid.gap
  const height = notebookGrid.originY * 2
    + (maxRow + 1) * notebookGrid.squareSize
    + maxRow * notebookGrid.gap
  return {
    rowCount: maxRow + 1,
    columnCount: resolvedColumnCount,
    width,
    height,
  }
}

export type { NotebookGridSlot } from 'videobook-engine'
