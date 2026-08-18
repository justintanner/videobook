import type {
  NotebookCell,
  NotebookDocument,
  NotebookGridSlot,
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
  readonly clientWidth: number
  scrollTo: (options: ScrollToOptions) => void
}

type FrameScheduler = (callback: FrameRequestCallback) => number

function compareCells(left: NotebookCell, right: NotebookCell): number {
  if (left.slot.row !== right.slot.row) return left.slot.row - right.slot.row
  if (left.slot.column !== right.slot.column) {
    return left.slot.column - right.slot.column
  }
  return left.id.localeCompare(right.id)
}

function sortCellIds(
  ids: Iterable<string>,
  cellsById: ReadonlyMap<string, NotebookCell>,
): string[] {
  return [...ids].sort((leftId, rightId) => {
    const left = cellsById.get(leftId)
    const right = cellsById.get(rightId)
    if (!left || !right) return leftId.localeCompare(rightId)
    return compareCells(left, right)
  })
}

function balancedRowSizes(count: number): number[] {
  if (count <= 0) return []
  const rowCount = Math.ceil(count / NOTEBOOK_GRID_COLUMN_COUNT)
  const baseSize = Math.floor(count / rowCount)
  const largerRows = count % rowCount
  return Array.from(
    { length: rowCount },
    (_, index) => baseSize + (index < largerRows ? 1 : 0),
  )
}

function centeredColumns(count: number): number[] {
  const center = Math.floor(NOTEBOOK_GRID_COLUMN_COUNT / 2)
  const half = Math.floor(count / 2)
  if (count % 2 === 1) {
    return Array.from({ length: count }, (_, index) => center - half + index)
  }
  return [
    ...Array.from({ length: half }, (_, index) => center - half + index),
    ...Array.from({ length: half }, (_, index) => center + 1 + index),
  ]
}

function averageParentColumn(
  id: string,
  parents: ReadonlyMap<string, ReadonlySet<string>>,
  assignedColumns: ReadonlyMap<string, number>,
): number | null {
  const parentIds = parents.get(id)
  if (!parentIds || parentIds.size === 0) return null
  const columns = [...parentIds].flatMap((parentId) => {
    const column = assignedColumns.get(parentId)
    return column === undefined ? [] : [column]
  })
  if (columns.length === 0) return null
  return columns.reduce((total, column) => total + column, 0) / columns.length
}

function orderCausalLayer(
  ids: readonly string[],
  cellsById: ReadonlyMap<string, NotebookCell>,
  parents: ReadonlyMap<string, ReadonlySet<string>>,
  assignedColumns: ReadonlyMap<string, number>,
): string[] {
  return [...ids].sort((leftId, rightId) => {
    const leftColumn = averageParentColumn(leftId, parents, assignedColumns)
    const rightColumn = averageParentColumn(rightId, parents, assignedColumns)
    if (leftColumn !== null && rightColumn !== null && leftColumn !== rightColumn) {
      return leftColumn - rightColumn
    }
    if (leftColumn !== null && rightColumn === null) return -1
    if (leftColumn === null && rightColumn !== null) return 1
    const left = cellsById.get(leftId)
    const right = cellsById.get(rightId)
    if (!left || !right) return leftId.localeCompare(rightId)
    return compareCells(left, right)
  })
}

function placeCenteredRows(
  ids: readonly string[],
  startRow: number,
  slots: Map<string, NotebookGridSlot>,
  assignedColumns: Map<string, number>,
): number {
  let offset = 0
  const rowSizes = balancedRowSizes(ids.length)
  for (const [rowOffset, rowSize] of rowSizes.entries()) {
    const columns = centeredColumns(rowSize)
    const rowIds = ids.slice(offset, offset + rowSize)
    for (const [index, id] of rowIds.entries()) {
      const slot = { row: startRow + rowOffset, column: columns[index]! }
      slots.set(id, slot)
      assignedColumns.set(id, slot.column)
    }
    offset += rowSize
  }
  return startRow + rowSizes.length
}

function failure(
  code: NotebookAutoArrangeFailureCode,
  message: string,
): NotebookAutoArrangeResult {
  return { ok: false, code, message }
}

export function planNotebookCausalPyramid(
  document: NotebookDocument,
): NotebookAutoArrangeResult {
  const cellsById = new Map(document.cells.map((cell) => [cell.id, cell]))
  if (cellsById.size !== document.cells.length) {
    return failure(
      'invalid-edge',
      'Cannot auto-arrange a notebook with duplicate cell IDs.',
    )
  }

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

  const parents = new Map<string, Set<string>>()
  const children = new Map<string, Set<string>>()
  for (const id of connectedIds) {
    parents.set(id, new Set())
    children.set(id, new Set())
  }
  for (const edge of document.edges) {
    parents.get(edge.target)?.add(edge.source)
    children.get(edge.source)?.add(edge.target)
  }

  const incoming = new Map(
    [...connectedIds].map((id) => [id, parents.get(id)?.size ?? 0]),
  )
  const ranks = new Map([...connectedIds].map((id) => [id, 0]))
  const orderedIds: string[] = []
  const ready = sortCellIds(
    [...connectedIds].filter((id) => incoming.get(id) === 0),
    cellsById,
  )

  while (ready.length > 0) {
    const id = ready.shift()
    if (!id) continue
    orderedIds.push(id)
    const sourceRank = ranks.get(id) ?? 0
    const targets = sortCellIds(children.get(id) ?? [], cellsById)
    for (const targetId of targets) {
      ranks.set(targetId, Math.max(ranks.get(targetId) ?? 0, sourceRank + 1))
      const count = (incoming.get(targetId) ?? 0) - 1
      incoming.set(targetId, count)
      if (count === 0) {
        ready.push(targetId)
        ready.sort((leftId, rightId) => {
          const left = cellsById.get(leftId)
          const right = cellsById.get(rightId)
          if (!left || !right) return leftId.localeCompare(rightId)
          return compareCells(left, right)
        })
      }
    }
  }

  if (orderedIds.length !== connectedIds.size) {
    return failure(
      'cycle',
      'Cannot auto-arrange because the notebook graph contains a cycle.',
    )
  }

  const layers = new Map<number, string[]>()
  for (const id of orderedIds) {
    const rank = ranks.get(id) ?? 0
    const layer = layers.get(rank) ?? []
    layer.push(id)
    layers.set(rank, layer)
  }
  const rankedLayers = [...layers.entries()].sort(
    ([leftRank], [rightRank]) => leftRank - rightRank,
  )
  const isolatedIds = sortCellIds(
    document.cells
      .filter((cell) => !connectedIds.has(cell.id))
      .map((cell) => cell.id),
    cellsById,
  )
  const connectedRowCount = rankedLayers.reduce(
    (total, [, ids]) => total + balancedRowSizes(ids.length).length,
    0,
  )
  const isolatedRowCount = balancedRowSizes(isolatedIds.length).length
  const requiredRows = connectedRowCount + isolatedRowCount
  if (requiredRows > NOTEBOOK_GRID_ROW_COUNT) {
    return failure(
      'capacity',
      `Cannot auto-arrange because the causal layout needs ${requiredRows} rows, but the grid supports ${NOTEBOOK_GRID_ROW_COUNT}.`,
    )
  }
  const spacerRows = connectedIds.size > 0
    && isolatedIds.length > 0
    && requiredRows < NOTEBOOK_GRID_ROW_COUNT
    ? 1
    : 0

  const slots = new Map<string, NotebookGridSlot>()
  const assignedColumns = new Map<string, number>()
  let nextRow = 0
  for (const [, ids] of rankedLayers) {
    const orderedLayer = orderCausalLayer(
      ids,
      cellsById,
      parents,
      assignedColumns,
    )
    nextRow = placeCenteredRows(
      orderedLayer,
      nextRow,
      slots,
      assignedColumns,
    )
  }
  nextRow += spacerRows
  nextRow = placeCenteredRows(
    isolatedIds,
    nextRow,
    slots,
    assignedColumns,
  )

  const assignments: NotebookAutoArrangeAssignment[] = []
  for (const cell of document.cells) {
    const slot = slots.get(cell.id)
    if (!slot) {
      return failure(
        'invalid-edge',
        `Cannot auto-arrange because cell ${cell.id} could not be placed.`,
      )
    }
    assignments.push({ id: cell.id, row: slot.row, column: slot.column })
  }
  return { ok: true, rowCount: nextRow, slots: assignments }
}

export function revealNotebookCausalPyramid(
  resolveTarget: () => NotebookAutoArrangeScrollTarget | null,
  centerX: number,
  zoom: number,
  scheduleFrame: FrameScheduler = (callback) => window.requestAnimationFrame(callback),
): void {
  scheduleFrame(() => {
    scheduleFrame(() => {
      const target = resolveTarget()
      if (!target) return
      const normalizedCenter = Number.isFinite(centerX) ? centerX : 0
      const normalizedZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
      const width = Number.isFinite(target.clientWidth) ? target.clientWidth : 0
      target.scrollTo({
        left: Math.max(0, normalizedCenter * normalizedZoom - width / 2),
        top: 0,
        behavior: 'smooth',
      })
    })
  })
}
