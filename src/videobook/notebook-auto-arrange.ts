import type {
  NotebookCell,
  NotebookDocument,
} from 'videobook-engine'
import {
  NOTEBOOK_GRID_COLUMN_COUNT,
  NOTEBOOK_GRID_ROW_COUNT,
} from 'videobook-engine/notebook-grid'

export interface NotebookAutoArrangeAssignment {
  id: string
  row: number
  column: number
}

export type NotebookAutoArrangeFailureCode =
  | 'capacity'
  | 'cycle'
  | 'invalid-edge'

export type NotebookAutoArrangeResult =
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

function compareCellIds(leftId: string, rightId: string): number {
  return leftId.localeCompare(rightId)
}

function sortCellIds(ids: Iterable<string>): string[] {
  return [...ids].sort(compareCellIds)
}

function failure(
  code: NotebookAutoArrangeFailureCode,
  message: string,
): NotebookAutoArrangeResult {
  return { ok: false, code, message }
}

function groupRowCount(count: number): number {
  return Math.ceil(count / NOTEBOOK_GRID_COLUMN_COUNT)
}

function placeGroup(
  ids: readonly string[],
  startRow: number,
): NotebookAutoArrangeAssignment[] {
  return ids.map((id, index) => ({
    id,
    row: startRow + Math.floor(index / NOTEBOOK_GRID_COLUMN_COUNT),
    column: index % NOTEBOOK_GRID_COLUMN_COUNT,
  }))
}

function orderedCellIds(
  document: NotebookDocument,
  cellsById: ReadonlyMap<string, NotebookCell>,
): string[] | NotebookAutoArrangeResult {
  const connectedIds = new Set<string>()

  for (const edge of document.edges) {
    if (!cellsById.has(edge.source) || !cellsById.has(edge.target)) {
      const missingId = cellsById.has(edge.source) ? edge.target : edge.source
      return failure(
        'invalid-edge',
        `Cannot auto-arrange because edge ${edge.id} references missing cell ${missingId}.`,
      )
    }
    connectedIds.add(edge.source)
    connectedIds.add(edge.target)
  }

  const parents = new Map(
    [...connectedIds].map((id) => [id, new Set<string>()]),
  )
  const children = new Map(
    [...connectedIds].map((id) => [id, new Set<string>()]),
  )
  for (const edge of document.edges) {
    parents.get(edge.target)?.add(edge.source)
    children.get(edge.source)?.add(edge.target)
  }

  const incoming = new Map(
    [...parents].map(([id, sources]) => [id, sources.size]),
  )
  const ready = sortCellIds(
    [...connectedIds].filter((id) => incoming.get(id) === 0),
  )
  const orderedIds: string[] = []

  while (ready.length > 0) {
    const id = ready.shift()
    if (!id) continue
    orderedIds.push(id)
    for (const childId of sortCellIds(children.get(id) ?? [])) {
      const count = (incoming.get(childId) ?? 0) - 1
      incoming.set(childId, count)
      if (count === 0) {
        ready.push(childId)
        ready.sort(compareCellIds)
      }
    }
  }

  if (orderedIds.length !== connectedIds.size) {
    return failure(
      'cycle',
      'Cannot auto-arrange because the notebook graph contains a cycle.',
    )
  }
  return [
    ...orderedIds,
    ...sortCellIds(
      document.cells
        .filter((cell) => !connectedIds.has(cell.id))
        .map((cell) => cell.id),
    ),
  ]
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

  const orderedIds = orderedCellIds(document, cellsById)
  if (!Array.isArray(orderedIds)) return orderedIds

  const contentIds = orderedIds.filter((id) => cellsById.get(id)?.type !== 'video')
  const videoIds = orderedIds.filter((id) => cellsById.get(id)?.type === 'video')
  const contentRowCount = groupRowCount(contentIds.length)
  const videoRowCount = groupRowCount(videoIds.length)
  const requiredRows = contentRowCount + videoRowCount
  if (requiredRows > NOTEBOOK_GRID_ROW_COUNT) {
    return failure(
      'capacity',
      `Cannot auto-arrange because the layout needs ${requiredRows} rows, but the grid supports ${NOTEBOOK_GRID_ROW_COUNT}.`,
    )
  }

  return {
    ok: true,
    rowCount: requiredRows,
    slots: [
      ...placeGroup(contentIds, 0),
      ...placeGroup(videoIds, contentRowCount),
    ],
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
