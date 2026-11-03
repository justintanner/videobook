import {
  NOTEBOOK_LANE_ORDER,
  notebookCellLane,
  notebookLaneLabel,
  type NotebookLane,
  type NotebookLaneCell,
} from '../../server/src/notebook-lanes'

type NotebookLaneRowKind = 'empty' | 'homogeneous' | 'mixed' | 'starter'

type NotebookLaneRowSummary = {
  caption: string
  continuation: boolean
  families: readonly NotebookLane[]
  family: NotebookLane | null
  kind: NotebookLaneRowKind
  row: number
}

export type NotebookLaneSection = {
  caption: string
  families: readonly NotebookLane[]
  family: NotebookLane | null
  kind: Exclude<NotebookLaneRowKind, 'empty'>
  rowCount: number
  startRow: number
}

const NOTEBOOK_STARTER_LANES = [
  'source',
  'gen',
  'image',
] as const satisfies readonly NotebookLane[]

function notebookLaneCaption(
  families: readonly NotebookLane[],
): string {
  return families.map(notebookLaneLabel).join(' · ')
}

function lanesByRow(
  cells: readonly NotebookLaneCell[],
): Map<number, Set<NotebookLane>> {
  const rows = new Map<number, Set<NotebookLane>>()
  for (const cell of cells) {
    const present = rows.get(cell.slot.row) ?? new Set<NotebookLane>()
    present.add(notebookCellLane(cell, cells))
    rows.set(cell.slot.row, present)
  }
  return rows
}

function orderedLanes(present: ReadonlySet<NotebookLane> | undefined): NotebookLane[] {
  return present ? NOTEBOOK_LANE_ORDER.filter((lane) => present.has(lane)) : []
}

function emptyRowSummary(row: number, emptyBook: boolean): NotebookLaneRowSummary {
  const starter = emptyBook ? NOTEBOOK_STARTER_LANES[row] : undefined
  if (starter) {
    return {
      caption: notebookLaneLabel(starter),
      continuation: false,
      families: [starter],
      family: starter,
      kind: 'starter',
      row,
    }
  }
  return {
    caption: '',
    continuation: false,
    families: [],
    family: null,
    kind: 'empty',
    row,
  }
}

function rowSummary(
  row: number,
  families: readonly NotebookLane[],
  previous: readonly NotebookLane[],
  emptyBook: boolean,
): NotebookLaneRowSummary {
  if (families.length === 0) return emptyRowSummary(row, emptyBook)
  if (families.length === 1) {
    const family = families[0]!
    return {
      caption: notebookLaneLabel(family),
      continuation: previous.length === 1 && previous[0] === family,
      families,
      family,
      kind: 'homogeneous',
      row,
    }
  }
  return {
    caption: notebookLaneCaption(families),
    continuation: false,
    families,
    family: null,
    kind: 'mixed',
    row,
  }
}

export function summarizeNotebookLaneRows(
  cells: readonly NotebookLaneCell[],
  rowCount: number,
): NotebookLaneRowSummary[] {
  const emptyBook = cells.length === 0
  const lanes = lanesByRow(cells)
  const summaries: NotebookLaneRowSummary[] = []
  let previous: readonly NotebookLane[] = []
  for (let row = 0; row < rowCount; row += 1) {
    const families = orderedLanes(lanes.get(row))
    summaries.push(rowSummary(row, families, previous, emptyBook))
    previous = families
  }
  return summaries
}

export function groupNotebookLaneSections(
  rows: readonly NotebookLaneRowSummary[],
): NotebookLaneSection[] {
  const sections: NotebookLaneSection[] = []
  for (const row of rows) {
    if (row.kind === 'empty') continue
    const last = sections.at(-1)
    if (
      last
      && row.kind === 'homogeneous'
      && last.kind === 'homogeneous'
      && last.family === row.family
      && last.startRow + last.rowCount === row.row
    ) {
      sections[sections.length - 1] = {
        ...last,
        rowCount: last.rowCount + 1,
      }
      continue
    }
    sections.push({
      caption: row.caption,
      families: row.families,
      family: row.family,
      kind: row.kind,
      rowCount: 1,
      startRow: row.row,
    })
  }
  return sections
}
