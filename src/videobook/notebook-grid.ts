import type { Node } from '@xyflow/react'
import type { NotebookPosition } from 'videobook-engine'

export interface NotebookGridSlot {
  stage: number
  column: number
}

export interface NotebookGridData extends Record<string, unknown> {
  stage: number
}

export const notebookGrid = {
  originX: 232,
  originY: 48,
  columnPitch: 348,
  stagePitch: 376,
  columnWidth: 300,
  cellWidth: 288,
  cellHeight: 288,
  stageHeadroom: 36,
  stageHeight: 352,
  minStages: 3,
  minColumns: 4,
} as const

const cellOffsetX = (notebookGrid.columnWidth - notebookGrid.cellWidth) / 2

function slotKey(slot: NotebookGridSlot): string {
  return `${slot.stage}:${slot.column}`
}

function normalizedSlot(slot: NotebookGridSlot): NotebookGridSlot {
  return {
    stage: Math.max(0, slot.stage),
    column: Math.max(0, slot.column),
  }
}

function nextFreeColumn(
  occupied: Set<string>,
  stage: number,
  column: number,
): number {
  let next = column
  while (occupied.has(slotKey({ stage, column: next }))) next += 1
  return next
}

export function notebookGridSlot(position: NotebookPosition): NotebookGridSlot {
  return {
    stage: Math.max(0, Math.round((position.y - notebookGrid.originY) / notebookGrid.stagePitch)),
    column: Math.max(
      0,
      Math.round((position.x - notebookGrid.originX - cellOffsetX) / notebookGrid.columnPitch),
    ),
  }
}

export function notebookGridPosition(slot: NotebookGridSlot): NotebookPosition {
  return {
    x: notebookGrid.originX + slot.column * notebookGrid.columnPitch + cellOffsetX,
    y: notebookGrid.originY + slot.stage * notebookGrid.stagePitch,
  }
}

export function normalizeNotebookGridPositions(
  positions: readonly NotebookPosition[],
): NotebookPosition[] {
  const occupied = new Set<string>()
  return positions.map((position) => {
    const requested = notebookGridSlot(position)
    const slot = {
      ...requested,
      column: nextFreeColumn(occupied, requested.stage, requested.column),
    }
    occupied.add(slotKey(slot))
    return notebookGridPosition(slot)
  })
}

export function normalizeNotebookGridNodes<T extends NotebookGridData>(
  nodes: readonly Node<T>[],
): Array<Node<T>> {
  const positions = normalizeNotebookGridPositions(nodes.map((node) => node.position))
  return nodes.map((node, index) => {
    const position = positions[index]!
    const slot = notebookGridSlot(position)
    return {
      ...node,
      position,
      data: { ...node.data, stage: slot.stage + 1 },
    }
  })
}

export function snapNotebookGridMove<T extends NotebookGridData>(
  nodes: readonly Node<T>[],
  id: string,
  requested: NotebookGridSlot,
): Array<Node<T>> {
  const slot = normalizedSlot(requested)
  return nodes.map((node) => {
    if (node.id !== id) return node
    return {
      ...node,
      position: notebookGridPosition(slot),
      data: { ...node.data, stage: slot.stage + 1 },
    }
  })
}

export function nextNotebookGridSlot<T extends NotebookGridData>(
  nodes: readonly Node<T>[],
  stage = 0,
): NotebookGridSlot {
  const occupied = new Set(nodes.map((node) => slotKey(notebookGridSlot(node.position))))
  return { stage, column: nextFreeColumn(occupied, stage, 0) }
}

export function resolveNotebookGridMove<T extends NotebookGridData>(
  nodes: readonly Node<T>[],
  id: string,
  requested: NotebookGridSlot,
): Array<Node<T>> {
  const normalized = normalizeNotebookGridNodes(nodes)
  const moving = normalized.find((node) => node.id === id)
  if (!moving) return normalized

  const target = normalizedSlot(requested)
  const targetNodes = normalized.filter((node) => (
    node.id !== id && notebookGridSlot(node.position).stage === target.stage
  ))
  const byColumn = new Map(targetNodes.map((node) => [
    notebookGridSlot(node.position).column,
    node,
  ]))
  let displaced = byColumn.get(target.column)
  let column = target.column
  byColumn.set(column, moving)
  while (displaced) {
    column += 1
    const next = byColumn.get(column)
    byColumn.set(column, displaced)
    displaced = next
  }

  const targetPositions = new Map<string, NotebookPosition>()
  for (const [nextColumn, node] of byColumn) {
    targetPositions.set(node.id, notebookGridPosition({
      stage: target.stage,
      column: nextColumn,
    }))
  }

  return normalized.map((node) => {
    const position = targetPositions.get(node.id)
    if (!position) return node
    return {
      ...node,
      position,
      data: { ...node.data, stage: target.stage + 1 },
    }
  })
}

export interface NotebookGridMetrics {
  stageCount: number
  columnCount: number
  width: number
  height: number
}

export interface NotebookGridViewport {
  x: number
  y: number
  zoom: number
}

export function notebookGridMetrics(
  positions: readonly NotebookPosition[],
  preview: NotebookGridSlot | null = null,
): NotebookGridMetrics {
  const slots = positions.map(notebookGridSlot)
  if (preview) slots.push(preview)
  const maxStage = Math.max(0, ...slots.map((slot) => slot.stage))
  const maxColumn = Math.max(0, ...slots.map((slot) => slot.column))
  const stageCount = Math.max(notebookGrid.minStages, maxStage + 1)
  const columnCount = Math.max(notebookGrid.minColumns, maxColumn + 1)
  return {
    stageCount,
    columnCount,
    width: notebookGrid.originX
      + columnCount * notebookGrid.columnPitch
      - (notebookGrid.columnPitch - notebookGrid.columnWidth)
      + notebookGrid.originX,
    height: notebookGrid.originY
      + (stageCount - 1) * notebookGrid.stagePitch
      + notebookGrid.cellHeight
      + notebookGrid.stageHeadroom,
  }
}

export function notebookGridStageViewport(
  positions: readonly NotebookPosition[],
  viewportWidth: number,
): NotebookGridViewport {
  const metrics = notebookGridMetrics(positions)
  const gutter = 24
  const availableWidth = Math.max(1, viewportWidth - gutter * 2)
  const zoom = Math.min(1, Math.max(0.35, availableWidth / metrics.width))
  return {
    x: (viewportWidth - metrics.width * zoom) / 2,
    y: 18,
    zoom,
  }
}
