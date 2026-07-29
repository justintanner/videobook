import type { NotebookCell } from 'videobook-engine'
import {
  notebookCellTableRows,
  type CellTableRow,
  type CellTableValue,
} from 'videobook-engine/catalog-metadata'

export type DoltCellValue = CellTableValue

export type DoltCellRow = CellTableRow

export type DoltCellDisplayValue =
  | { kind: 'json', value: unknown }
  | { kind: 'null' }
  | { kind: 'raw', value: number | string }

export function doltCellRows(
  notebookId: string,
  cell: NotebookCell,
): DoltCellRow[] {
  return notebookCellTableRows(notebookId, cell)
}

export function doltCellDisplayValue(row: DoltCellRow): DoltCellDisplayValue {
  if (row.value === null) return { kind: 'null' }
  if (!row.column.endsWith('_json') || typeof row.value !== 'string') {
    return { kind: 'raw', value: row.value }
  }

  try {
    return { kind: 'json', value: JSON.parse(row.value) as unknown }
  } catch {
    return { kind: 'raw', value: row.value }
  }
}
