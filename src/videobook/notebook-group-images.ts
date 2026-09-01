import type {
  NotebookCell,
  NotebookDocument,
  NotebookGridSlot,
} from 'videobook-engine'
import {
  NOTEBOOK_GRID_CAPACITY,
  NOTEBOOK_GRID_COLUMN_COUNT,
  NOTEBOOK_GRID_FULL_ERROR,
  firstEmptyNotebookGridSlots,
} from 'videobook-engine/notebook-grid'
import { notebookGridSlotKey } from './notebook-grid'

interface NotebookImageGroupAssignment {
  id: string
  row: number
  column: number
}

type NotebookImageGroupFailureCode = 'no-images' | 'capacity' | 'grid-full'

type NotebookImageGroupResult =
  | {
      ok: true
      slots: NotebookImageGroupAssignment[]
      movedCount: number
      displacedCount: number
    }
  | {
      ok: false
      code: NotebookImageGroupFailureCode
      message: string
    }

function readingOrder(cells: readonly NotebookCell[]): NotebookCell[] {
  return [...cells].sort(
    (left, right) =>
      left.slot.row - right.slot.row || left.slot.column - right.slot.column,
  )
}

/* Images flow rightward from the anchor and wrap onto the next row at the
   grid edge, so each line is a full row of NOTEBOOK_GRID_COLUMN_COUNT cells
   apart from the anchor's own partial first line. Past @h64 the run wraps
   back to @a1, matching the axis arrange planner's grid-edge behaviour. */
function lineTarget(anchor: NotebookGridSlot, index: number): NotebookGridSlot {
  const linear = (
    anchor.row * NOTEBOOK_GRID_COLUMN_COUNT + anchor.column + index
  ) % NOTEBOOK_GRID_CAPACITY
  return {
    row: Math.floor(linear / NOTEBOOK_GRID_COLUMN_COUNT),
    column: linear % NOTEBOOK_GRID_COLUMN_COUNT,
  }
}

function freeSlotCount(occupied: readonly NotebookGridSlot[]): number {
  return NOTEBOOK_GRID_CAPACITY - new Set(occupied.map(notebookGridSlotKey)).size
}

export function planImageGrouping(
  document: NotebookDocument,
  imageCellIds: ReadonlySet<string>,
  anchor: NotebookGridSlot,
): NotebookImageGroupResult {
  const images = readingOrder(
    document.cells.filter((cell) => imageCellIds.has(cell.id)),
  )
  if (images.length === 0) {
    return {
      ok: false,
      code: 'no-images',
      message: 'No image cells in this notebook to group.',
    }
  }
  if (images.length > NOTEBOOK_GRID_CAPACITY) {
    return {
      ok: false,
      code: 'capacity',
      message: `Cannot group ${images.length} images: the grid fits ${NOTEBOOK_GRID_CAPACITY}.`,
    }
  }

  const targets = images.map((_, index) => lineTarget(anchor, index))
  const targetKeys = new Set(targets.map(notebookGridSlotKey))

  const displaced = readingOrder(
    document.cells.filter((cell) =>
      !imageCellIds.has(cell.id) && targetKeys.has(notebookGridSlotKey(cell.slot))),
  )
  const movingIds = new Set([
    ...images.map((cell) => cell.id),
    ...displaced.map((cell) => cell.id),
  ])
  const occupied: NotebookGridSlot[] = [
    ...document.cells
      .filter((cell) => !movingIds.has(cell.id))
      .map((cell) => cell.slot),
    ...targets,
  ]
  if (displaced.length > freeSlotCount(occupied)) {
    return { ok: false, code: 'grid-full', message: NOTEBOOK_GRID_FULL_ERROR }
  }
  const freeSlots = firstEmptyNotebookGridSlots(occupied, displaced.length)

  const slots: NotebookImageGroupAssignment[] = [
    ...images.map((cell, index) => ({ id: cell.id, ...targets[index] })),
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
