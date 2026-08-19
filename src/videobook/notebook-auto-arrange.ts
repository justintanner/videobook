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
  | 'cycle'
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

const ARRANGE_COLUMN_COUNT = Math.min(7, NOTEBOOK_GRID_COLUMN_COUNT)
const BAND_GAP_ROWS = 1

interface ArrangeGraph {
  connectedIds: ReadonlySet<string>
  parents: ReadonlyMap<string, ReadonlySet<string>>
  children: ReadonlyMap<string, ReadonlySet<string>>
  looseIds: readonly string[]
}

interface ArrangeBand {
  rowCount: number
  slots: NotebookAutoArrangeAssignment[]
}

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

function buildArrangeGraph(
  document: NotebookDocument,
  cellsById: ReadonlyMap<string, NotebookCell>,
): ArrangeGraph | NotebookAutoArrangeResult {
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

  const looseIds = sortCellIds(
    document.cells
      .filter((cell) => !connectedIds.has(cell.id))
      .map((cell) => cell.id),
  )
  return { connectedIds, parents, children, looseIds }
}

function topologicalOrder(
  graph: ArrangeGraph,
): string[] | NotebookAutoArrangeResult {
  const incoming = new Map(
    [...graph.parents].map(([id, sources]) => [id, sources.size]),
  )
  const ready = sortCellIds(
    [...graph.connectedIds].filter((id) => incoming.get(id) === 0),
  )
  const orderedIds: string[] = []

  while (ready.length > 0) {
    const id = ready.shift()
    if (!id) continue
    orderedIds.push(id)
    for (const childId of sortCellIds(graph.children.get(id) ?? [])) {
      const count = (incoming.get(childId) ?? 0) - 1
      incoming.set(childId, count)
      if (count === 0) {
        ready.push(childId)
        ready.sort(compareCellIds)
      }
    }
  }

  if (orderedIds.length !== graph.connectedIds.size) {
    return failure(
      'cycle',
      'Cannot auto-arrange because the notebook graph contains a cycle.',
    )
  }
  return orderedIds
}

function longestPathDepths(
  graph: ArrangeGraph,
  orderedIds: readonly string[],
): Map<string, number> {
  const depths = new Map(orderedIds.map((id) => [id, 0]))
  for (const id of orderedIds) {
    const parentDepth = depths.get(id) ?? 0
    for (const childId of graph.children.get(id) ?? []) {
      depths.set(childId, Math.max(depths.get(childId) ?? 0, parentDepth + 1))
    }
  }
  return depths
}

function componentKeyByCell(graph: ArrangeGraph): Map<string, string> {
  const keyByCell = new Map<string, string>()
  for (const id of sortCellIds(graph.connectedIds)) {
    if (keyByCell.has(id)) continue
    const pending = [id]
    while (pending.length > 0) {
      const memberId = pending.pop()
      if (!memberId || keyByCell.has(memberId)) continue
      keyByCell.set(memberId, id)
      pending.push(
        ...(graph.parents.get(memberId) ?? []),
        ...(graph.children.get(memberId) ?? []),
      )
    }
  }
  return keyByCell
}

function anchorParentId(
  id: string,
  graph: ArrangeGraph,
  depths: ReadonlyMap<string, number>,
): string | undefined {
  let anchorId: string | undefined
  let anchorDepth = -1
  for (const parentId of sortCellIds(graph.parents.get(id) ?? [])) {
    const parentDepth = depths.get(parentId) ?? 0
    if (parentDepth > anchorDepth) {
      anchorId = parentId
      anchorDepth = parentDepth
    }
  }
  return anchorId
}

function wrapRowOffset(depth: number): number {
  return Math.floor(depth / ARRANGE_COLUMN_COUNT)
}

function layoutChainBand(
  memberIds: readonly string[],
  graph: ArrangeGraph,
  depths: ReadonlyMap<string, number>,
): ArrangeBand {
  const rowByCell = new Map<string, number>()
  const occupied = new Set<string>()
  const slots: NotebookAutoArrangeAssignment[] = []
  let rowCount = 0

  for (const id of memberIds) {
    const depth = depths.get(id) ?? 0
    const column = depth % ARRANGE_COLUMN_COUNT
    const anchorId = anchorParentId(id, graph, depths)
    let row = 0
    if (anchorId !== undefined) {
      const anchorDepth = depths.get(anchorId) ?? 0
      const anchorRow = rowByCell.get(anchorId) ?? 0
      row = anchorRow + wrapRowOffset(depth) - wrapRowOffset(anchorDepth)
    }
    while (occupied.has(`${row}:${column}`)) row += 1
    occupied.add(`${row}:${column}`)
    rowByCell.set(id, row)
    rowCount = Math.max(rowCount, row + 1)
    slots.push({ id, row, column })
  }

  return { rowCount, slots }
}

function layoutPackedBand(ids: readonly string[]): ArrangeBand {
  return {
    rowCount: Math.ceil(ids.length / ARRANGE_COLUMN_COUNT),
    slots: ids.map((id, index) => ({
      id,
      row: Math.floor(index / ARRANGE_COLUMN_COUNT),
      column: index % ARRANGE_COLUMN_COUNT,
    })),
  }
}

function arrangeBands(
  graph: ArrangeGraph,
  orderedIds: readonly string[],
  depths: ReadonlyMap<string, number>,
): ArrangeBand[] {
  const keyByCell = componentKeyByCell(graph)
  const memberIdsByKey = new Map<string, string[]>()
  for (const id of orderedIds) {
    const key = keyByCell.get(id) ?? id
    const memberIds = memberIdsByKey.get(key) ?? []
    memberIds.push(id)
    memberIdsByKey.set(key, memberIds)
  }

  const bands = sortCellIds(memberIdsByKey.keys()).map((key) =>
    layoutChainBand(memberIdsByKey.get(key) ?? [], graph, depths))
  if (graph.looseIds.length > 0) {
    bands.push(layoutPackedBand(graph.looseIds))
  }
  return bands
}

function stackBands(
  bands: readonly ArrangeBand[],
  gapRows: number,
): { rowCount: number; slots: NotebookAutoArrangeAssignment[] } {
  const slots: NotebookAutoArrangeAssignment[] = []
  let nextBandRow = 0
  for (const band of bands) {
    for (const slot of band.slots) {
      slots.push({ ...slot, row: nextBandRow + slot.row })
    }
    nextBandRow += band.rowCount + gapRows
  }
  return {
    rowCount: Math.max(0, nextBandRow - gapRows),
    slots,
  }
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

  const graph = buildArrangeGraph(document, cellsById)
  if ('ok' in graph) return graph
  const orderedIds = topologicalOrder(graph)
  if (!Array.isArray(orderedIds)) return orderedIds

  const depths = longestPathDepths(graph, orderedIds)
  const bands = arrangeBands(graph, orderedIds, depths)
  for (const gapRows of [BAND_GAP_ROWS, 0]) {
    const stacked = stackBands(bands, gapRows)
    if (stacked.rowCount <= NOTEBOOK_GRID_ROW_COUNT) {
      return { ok: true, rowCount: stacked.rowCount, slots: stacked.slots }
    }
  }

  const packed = layoutPackedBand([...orderedIds, ...graph.looseIds])
  if (packed.rowCount <= NOTEBOOK_GRID_ROW_COUNT) {
    return { ok: true, rowCount: packed.rowCount, slots: packed.slots }
  }
  return failure(
    'capacity',
    `Cannot auto-arrange because the layout needs ${packed.rowCount} rows, but the grid supports ${NOTEBOOK_GRID_ROW_COUNT}.`,
  )
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
