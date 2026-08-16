import type { NotebookCell } from 'videobook-engine'
import { isNotebookGenerationCellType } from './notebook-cell-types'

type GenerationPolicyCell = Pick<NotebookCell, 'operation' | 'type'>

export function notebookCellSupportsGenerateCellCommand(
  cell: GenerationPolicyCell,
): boolean {
  return cell.operation !== 'rewrite_prompt'
    && isNotebookGenerationCellType(cell.type)
}

export function notebookCellRequiresCloudGenerationConsent(
  cell: GenerationPolicyCell,
): boolean {
  return cell.operation === 'rewrite_prompt'
    || notebookCellSupportsGenerateCellCommand(cell)
}
