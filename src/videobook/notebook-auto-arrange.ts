import type {
  NotebookCell,
  NotebookDocument,
} from 'videobook-engine'
import {
  NOTEBOOK_GRID_COLUMN_COUNT,
  NOTEBOOK_GRID_ROW_COUNT,
} from 'videobook-engine/notebook-grid'

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

type ArrangeBand = 'image' | 'other' | 'video'

const IMAGE_ROW = 0
const OTHER_ROW = 1
const VIDEO_ROW = 2
const OVERFLOW_ROW = 3

function failure(
  code: NotebookAutoArrangeFailureCode,
  message: string,
): NotebookAutoArrangeResult {
  return { ok: false, code, message }
}

function slotKey(row: number, column: number): string {
  return `${row}:${column}`
}

function arrangeBand(type: NotebookCell['type']): ArrangeBand {
  if (type === 'image') return 'image'
  if (type === 'video') return 'video'
  return 'other'
}

function primaryRow(band: ArrangeBand): number {
  if (band === 'image') return IMAGE_ROW
  if (band === 'video') return VIDEO_ROW
  return OTHER_ROW
}

function readingOrder(cells: readonly NotebookCell[]): NotebookCell[] {
  return [...cells].sort((left, right) =>
    left.slot.row - right.slot.row
    || left.slot.column - right.slot.column
    || left.id.localeCompare(right.id))
}

function nextFreeSlot(
  bandRow: number,
  occupied: ReadonlySet<string>,
): { row: number; column: number } | null {
  for (let column = 0; column < NOTEBOOK_GRID_COLUMN_COUNT; column += 1) {
    if (!occupied.has(slotKey(bandRow, column))) {
      return { row: bandRow, column }
    }
  }
  for (let row = OVERFLOW_ROW; row < NOTEBOOK_GRID_ROW_COUNT; row += 1) {
    for (let column = 0; column < NOTEBOOK_GRID_COLUMN_COUNT; column += 1) {
      if (!occupied.has(slotKey(row, column))) {
        return { row, column }
      }
    }
  }
  return null
}

function packBand(
  ids: readonly string[],
  bandRow: number,
  occupied: Set<string>,
): NotebookAutoArrangeAssignment[] | NotebookAutoArrangeResult {
  const slots: NotebookAutoArrangeAssignment[] = []
  for (const [index, id] of ids.entries()) {
    const slot = nextFreeSlot(bandRow, occupied)
    if (!slot) {
      const remaining = ids.length - index
      const extraRows = Math.max(1, Math.ceil(remaining / NOTEBOOK_GRID_COLUMN_COUNT))
      return failure(
        'capacity',
        `Cannot auto-arrange because the layout needs ${NOTEBOOK_GRID_ROW_COUNT + extraRows} rows, but the grid supports ${NOTEBOOK_GRID_ROW_COUNT}.`,
      )
    }
    occupied.add(slotKey(slot.row, slot.column))
    slots.push({ id, ...slot })
  }
  return slots
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

  const idsByBand: Record<ArrangeBand, string[]> = {
    image: [],
    video: [],
    other: [],
  }
  for (const cell of readingOrder(document.cells)) {
    idsByBand[arrangeBand(cell.type)].push(cell.id)
  }

  const occupied = new Set<string>()
  const slots: NotebookAutoArrangeAssignment[] = []
  for (const band of ['image', 'video', 'other'] as const) {
    const packed = packBand(idsByBand[band], primaryRow(band), occupied)
    if (!Array.isArray(packed)) return packed
    slots.push(...packed)
  }

  return {
    ok: true,
    rowCount: slots.reduce((maxRow, slot) => Math.max(maxRow, slot.row + 1), 0),
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
