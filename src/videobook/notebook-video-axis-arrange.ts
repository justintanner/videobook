import type {
  NotebookCell,
  NotebookDocument,
  NotebookGridSlot,
} from 'videobook-engine'
import {
  NOTEBOOK_GRID_COLUMN_COUNT,
  NOTEBOOK_GRID_ROW_COUNT,
  firstEmptyNotebookGridSlots,
} from 'videobook-engine/notebook-grid'

export type NotebookVideoAxis = 'column' | 'row'

interface NotebookVideoAxisAssignment {
  id: string
  row: number
  column: number
}

type NotebookVideoAxisArrangeFailureCode = 'no-videos' | 'capacity'

type NotebookVideoAxisArrangeResult =
  | {
      ok: true
      slots: NotebookVideoAxisAssignment[]
      movedCount: number
      displacedCount: number
    }
  | {
      ok: false
      code: NotebookVideoAxisArrangeFailureCode
      message: string
    }

function slotKey(slot: NotebookGridSlot): string {
  return `${slot.row}:${slot.column}`
}

function readingOrder(cells: readonly NotebookCell[]): NotebookCell[] {
  return [...cells].sort(
    (left, right) =>
      left.slot.row - right.slot.row || left.slot.column - right.slot.column,
  )
}

function axisTarget(
  anchor: NotebookGridSlot,
  axis: NotebookVideoAxis,
  index: number,
): NotebookGridSlot {
  return axis === 'column'
    ? {
        row: (anchor.row + index) % NOTEBOOK_GRID_ROW_COUNT,
        column: anchor.column,
      }
    : {
        row: anchor.row,
        column: (anchor.column + index) % NOTEBOOK_GRID_COLUMN_COUNT,
      }
}

export function planVideoAxisArrangement(
  document: NotebookDocument,
  videoCellIds: ReadonlySet<string>,
  anchor: NotebookGridSlot,
  axis: NotebookVideoAxis,
): NotebookVideoAxisArrangeResult {
  const videos = readingOrder(
    document.cells.filter((cell) => videoCellIds.has(cell.id)),
  )
  if (videos.length === 0) {
    return {
      ok: false,
      code: 'no-videos',
      message: 'No video cells in this notebook to arrange.',
    }
  }

  const axisLength = axis === 'column'
    ? NOTEBOOK_GRID_ROW_COUNT
    : NOTEBOOK_GRID_COLUMN_COUNT
  if (videos.length > axisLength) {
    return {
      ok: false,
      code: 'capacity',
      message: `Cannot arrange ${videos.length} videos in one ${axis}: the grid fits ${axisLength}.`,
    }
  }

  const targets = videos.map((_, index) => axisTarget(anchor, axis, index))
  const targetKeys = new Set(targets.map(slotKey))

  const displaced = readingOrder(
    document.cells.filter((cell) =>
      !videoCellIds.has(cell.id) && targetKeys.has(slotKey(cell.slot))),
  )
  const movingIds = new Set([
    ...videos.map((cell) => cell.id),
    ...displaced.map((cell) => cell.id),
  ])
  const occupied: NotebookGridSlot[] = [
    ...document.cells
      .filter((cell) => !movingIds.has(cell.id))
      .map((cell) => cell.slot),
    ...targets,
  ]
  const freeSlots = firstEmptyNotebookGridSlots(occupied, displaced.length)

  const slots: NotebookVideoAxisAssignment[] = [
    ...videos.map((cell, index) => ({ id: cell.id, ...targets[index] })),
    ...displaced.map((cell, index) => ({ id: cell.id, ...freeSlots[index] })),
  ]

  const currentById = new Map(
    document.cells.map((cell) => [cell.id, cell.slot] as const),
  )
  const movedCount = slots.filter((slot) => {
    const current = currentById.get(slot.id)
    return current?.row !== slot.row || current?.column !== slot.column
  }).length

  return { ok: true, slots, movedCount, displacedCount: displaced.length }
}
