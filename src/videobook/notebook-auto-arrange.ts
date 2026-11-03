import type { NotebookDocument } from 'videobook-engine'
import { NOTEBOOK_GRID_ROW_COUNT } from 'videobook-engine/notebook-grid'
import { arrangeGoalNotebook } from '../../server/src/notebook-goal-layout'
import { arrangeNotebookLanes } from '../../server/src/notebook-lanes'

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

  const arranged = arrangeNotebookLanes(document.cells)
  if (!arranged.ok) {
    return failure(
      'capacity',
      `Cannot auto-arrange because the layout needs ${arranged.requiredRows} rows, but the grid supports ${NOTEBOOK_GRID_ROW_COUNT}.`,
    )
  }
  return arranged
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
