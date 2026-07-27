import type { NotebookCell } from 'videobook-engine'

export type DoltCellValue = number | string | null

export type DoltCellRow = {
  column: string
  type: 'INTEGER' | 'REAL' | 'TEXT'
  value: DoltCellValue
}

export function doltCellRows(
  notebookId: string,
  cell: NotebookCell,
): DoltCellRow[] {
  return [
    { column: 'notebook_id', type: 'TEXT', value: notebookId },
    { column: 'cell_id', type: 'TEXT', value: cell.id },
    { column: 'type', type: 'TEXT', value: cell.type },
    { column: 'slug', type: 'TEXT', value: cell.slug },
    { column: 'grid_row', type: 'INTEGER', value: cell.slot.row },
    { column: 'grid_column', type: 'INTEGER', value: cell.slot.column },
    {
      column: 'output_entity_id',
      type: 'TEXT',
      value: cell.outputEntityId ?? null,
    },
    { column: 'prompt', type: 'TEXT', value: cell.prompt ?? null },
    { column: 'provider', type: 'TEXT', value: cell.provider ?? null },
    { column: 'model', type: 'TEXT', value: cell.model ?? null },
    { column: 'operation', type: 'TEXT', value: cell.operation ?? null },
    { column: 'tool', type: 'TEXT', value: cell.tool ?? null },
    {
      column: 'inputs_json',
      type: 'TEXT',
      value: JSON.stringify(cell.inputs ?? {}),
    },
    {
      column: 'output_artifact_id',
      type: 'TEXT',
      value: cell.outputArtifactId ?? null,
    },
  ]
}
