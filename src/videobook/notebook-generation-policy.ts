import type { NotebookCell } from 'videobook-engine'
import { isNotebookGenerationCellType } from './notebook-cell-types'

type GenerationPolicyCell = Pick<NotebookCell, 'operation' | 'type'>
  & Partial<Pick<NotebookCell, 'provider' | 'tool'>>

export function notebookCellSupportsGenerateCellCommand(
  cell: GenerationPolicyCell,
): boolean {
  return cell.operation !== 'rewrite_prompt'
    && isNotebookGenerationCellType(cell.type)
}

export function notebookCellRequiresCloudGenerationConsent(
  cell: GenerationPolicyCell,
): boolean {
  if (cell.tool === 'edit_image_subjects' && cell.provider === 'local') return false
  return cell.operation === 'rewrite_prompt'
    || notebookCellSupportsGenerateCellCommand(cell)
}
