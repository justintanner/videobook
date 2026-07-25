import type { NotebookCell } from 'videobook-engine'

export type DoltCellValue = number | string | null

export type DoltCellRow = {
  column: string
  type: 'REAL' | 'TEXT'
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
    { column: 'title', type: 'TEXT', value: cell.title },
    { column: 'position_x', type: 'REAL', value: cell.position.x },
    { column: 'position_y', type: 'REAL', value: cell.position.y },
    { column: 'entity_id', type: 'TEXT', value: cell.entityId ?? null },
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
