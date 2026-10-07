import type { NotebookCellType } from 'videobook-engine'
import { notebookCellFamily } from './notebook-cell-types'

export type NotebookLaneFamily = 'audio' | 'gen' | 'image' | 'video' | 'work'

export type NotebookLaneCell = {
  type: NotebookCellType
  slot: { row: number; column: number }
}

type NotebookLaneRowKind = 'empty' | 'homogeneous' | 'mixed' | 'starter'

type NotebookLaneRowSummary = {
  caption: string
  continuation: boolean
  families: readonly NotebookLaneFamily[]
  family: NotebookLaneFamily | null
  kind: NotebookLaneRowKind
  row: number
}

export type NotebookLaneSection = {
  caption: string
  families: readonly NotebookLaneFamily[]
  family: NotebookLaneFamily | null
  kind: Exclude<NotebookLaneRowKind, 'empty'>
  rowCount: number
  startRow: number
}

export const NOTEBOOK_LANE_FAMILY_ORDER = [
  'image',
  'gen',
  'video',
  'audio',
  'work',
] as const satisfies readonly NotebookLaneFamily[]

export const NOTEBOOK_LANE_FAMILY_LABELS: Record<NotebookLaneFamily, string> = {
  audio: 'Audio',
  gen: 'Gen',
  image: 'Images',
  video: 'Videos',
  work: 'Work',
}

const NOTEBOOK_STARTER_LANE_FAMILIES = [
  'image',
  'gen',
  'video',
] as const satisfies readonly NotebookLaneFamily[]

export function notebookLaneFamily(type: NotebookCellType): NotebookLaneFamily {
  const family = notebookCellFamily(type)
  return family === 'data' || family === 'goal' ? 'work' : family
}

export function notebookLaneFamilyLabel(family: NotebookLaneFamily): string {
  return NOTEBOOK_LANE_FAMILY_LABELS[family]
}

function notebookLaneCaption(
  families: readonly NotebookLaneFamily[],
): string {
  return families.map(notebookLaneFamilyLabel).join(' · ')
}

function familiesInRow(
  cells: readonly NotebookLaneCell[],
  row: number,
): NotebookLaneFamily[] {
  const present = new Set<NotebookLaneFamily>()
  for (const cell of cells) {
    if (cell.slot.row !== row) continue
    present.add(notebookLaneFamily(cell.type))
  }
  return NOTEBOOK_LANE_FAMILY_ORDER.filter((family) => present.has(family))
}

function rowSummary(
  row: number,
  families: readonly NotebookLaneFamily[],
  previous: readonly NotebookLaneFamily[],
  emptyBook: boolean,
): NotebookLaneRowSummary {
  if (families.length === 0) {
    const starter = emptyBook
      ? NOTEBOOK_STARTER_LANE_FAMILIES[row]
      : undefined
    if (starter) {
      return {
        caption: notebookLaneFamilyLabel(starter),
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
  if (families.length === 1) {
    const family = families[0]!
    const continuation = previous.length === 1 && previous[0] === family
    return {
      caption: notebookLaneFamilyLabel(family),
      continuation,
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
  const summaries: NotebookLaneRowSummary[] = []
  let previous: readonly NotebookLaneFamily[] = []
  for (let row = 0; row < rowCount; row += 1) {
    const families = familiesInRow(cells, row)
    const summary = rowSummary(row, families, previous, emptyBook)
    summaries.push(summary)
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
