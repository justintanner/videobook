import type {
  NotebookCell,
  NotebookDocument,
} from 'videobook-engine'
import {
  NOTEBOOK_GRID_COLUMN_COUNT,
  NOTEBOOK_GRID_ROW_COUNT,
} from 'videobook-engine/notebook-grid'
import {
  NOTEBOOK_LANE_FAMILY_ORDER,
  notebookLaneFamily,
  type NotebookLaneFamily,
} from './notebook-lane-policy'
import { arrangeGoalNotebook } from '../../server/src/notebook-goal-layout'

interface NotebookAutoArrangeAssignment {
  id: string
  row: number
  column: number
}

type NotebookAutoArrangeFailureCode =
  | 'capacity'
  | 'invalid-edge'

type NotebookAutoArrangeResult =
  | {
      ok: true
      rowCount: number
      slots: NotebookAutoArrangeAssignment[]
    }
  | {
      ok: false
      code: NotebookAutoArrangeFailureCode
      message: string
    }

interface NotebookAutoArrangeScrollTarget {
  scrollTo: (options: ScrollToOptions) => void
}

type FrameScheduler = (callback: FrameRequestCallback) => number

function failure(
  code: NotebookAutoArrangeFailureCode,
  message: string,
): NotebookAutoArrangeResult {
  return { ok: false, code, message }
}

function readingOrder(cells: readonly NotebookCell[]): NotebookCell[] {
  return [...cells].sort((left, right) =>
    left.slot.row - right.slot.row
    || left.slot.column - right.slot.column
    || left.id.localeCompare(right.id))
}

function familyRowCount(cellCount: number): number {
  if (cellCount <= 0) return 0
  return Math.ceil(cellCount / NOTEBOOK_GRID_COLUMN_COUNT)
}

export function planNotebookArrangement(
  document: NotebookDocument,
): NotebookAutoArrangeResult {
  const cellsById = new Map(document.cells.map((cell) => [cell.id, cell]))
  if (cellsById.size !== document.cells.length) {
    return failure(
      'invalid-edge',
      'Cannot auto-arrange a notebook with duplicate cell IDs.',
    )
  }
  if (document.cells.some(cell => cell.type === 'goal')) {
    try {
      const arranged = arrangeGoalNotebook(document)
      return {
        ok: true,
        rowCount: Math.max(...arranged.cells.map(cell => cell.slot.row + 1)),
        slots: arranged.cells.map(cell => ({ id: cell.id, ...cell.slot })),
      }
    } catch (error) {
      return failure('capacity', error instanceof Error ? error.message : String(error))
    }
  }

  const idsByFamily: Record<NotebookLaneFamily, string[]> = {
    audio: [],
    gen: [],
    image: [],
    video: [],
    work: [],
  }
  const timelines = document.cells.filter((cell) => cell.type === 'timeline')
  const reservedRows = new Set(timelines.map((cell) => cell.slot.row))
  for (const cell of readingOrder(document.cells)) {
    if (cell.type === 'timeline') continue
    idsByFamily[notebookLaneFamily(cell.type)].push(cell.id)
  }

  const requiredRows = NOTEBOOK_LANE_FAMILY_ORDER.reduce(
    (total, family) => total + familyRowCount(idsByFamily[family].length),
    0,
  )
  if (requiredRows + reservedRows.size > NOTEBOOK_GRID_ROW_COUNT) {
    return failure(
      'capacity',
      `Cannot auto-arrange because the layout needs ${requiredRows} rows, but the grid supports ${NOTEBOOK_GRID_ROW_COUNT}.`,
    )
  }

  const slots: NotebookAutoArrangeAssignment[] = timelines.map((cell) => ({ id: cell.id, ...cell.slot }))
  let nextRow = 0
  for (const family of NOTEBOOK_LANE_FAMILY_ORDER) {
    const ids = idsByFamily[family]
    if (ids.length === 0) continue
    for (let index = 0; index < ids.length; index += NOTEBOOK_GRID_COLUMN_COUNT) {
      while (reservedRows.has(nextRow)) nextRow += 1
      for (const [column, id] of ids.slice(index, index + NOTEBOOK_GRID_COLUMN_COUNT).entries()) {
        slots.push({ id, row: nextRow, column })
      }
      nextRow += 1
    }
  }

  return {
    ok: true,
    rowCount: Math.max(nextRow, ...timelines.map((cell) => cell.slot.row + 1)),
    slots,
  }
}

export function revealNotebookArrangement(
  resolveTarget: () => NotebookAutoArrangeScrollTarget | null,
  scheduleFrame: FrameScheduler = (callback) => window.requestAnimationFrame(callback),
): void {
  scheduleFrame(() => {
    scheduleFrame(() => {
      resolveTarget()?.scrollTo({
        left: 0,
        top: 0,
        behavior: 'smooth',
      })
    })
  })
}
