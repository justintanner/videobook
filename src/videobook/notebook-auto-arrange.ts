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

  const idsByFamily: Record<NotebookLaneFamily, string[]> = {
    audio: [],
    gen: [],
    image: [],
    video: [],
    work: [],
  }
  for (const cell of readingOrder(document.cells)) {
    idsByFamily[notebookLaneFamily(cell.type)].push(cell.id)
  }

  const requiredRows = NOTEBOOK_LANE_FAMILY_ORDER.reduce(
    (total, family) => total + familyRowCount(idsByFamily[family].length),
    0,
  )
  if (requiredRows > NOTEBOOK_GRID_ROW_COUNT) {
    return failure(
      'capacity',
      `Cannot auto-arrange because the layout needs ${requiredRows} rows, but the grid supports ${NOTEBOOK_GRID_ROW_COUNT}.`,
    )
  }

  const slots: NotebookAutoArrangeAssignment[] = []
  let nextRow = 0
  for (const family of NOTEBOOK_LANE_FAMILY_ORDER) {
    const ids = idsByFamily[family]
    if (ids.length === 0) continue
    for (const [index, id] of ids.entries()) {
      slots.push({
        id,
        row: nextRow + Math.floor(index / NOTEBOOK_GRID_COLUMN_COUNT),
        column: index % NOTEBOOK_GRID_COLUMN_COUNT,
      })
    }
    nextRow += familyRowCount(ids.length)
  }

  return {
    ok: true,
    rowCount: requiredRows,
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
