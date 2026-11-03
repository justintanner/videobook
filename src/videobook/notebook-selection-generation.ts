import type { NotebookCell, NotebookDocument } from 'videobook-engine'
import { notebookGridTag } from 'videobook-engine/notebook-grid'
import {
  planNotebookChatGeneration,
  type NotebookChatGenerationCommand,
  type NotebookChatGenerationDraft,
} from './notebook-chat-generation'
import type { NotebookGenerationAction } from './notebook-generation-actions'

export type ContextMenuGenerationCellType = Extract<
  NotebookChatGenerationCommand['cellType'],
  'generate_image' | 'generate_video'
>

function gridOrder(left: NotebookCell, right: NotebookCell): number {
  return left.slot.row - right.slot.row || left.slot.column - right.slot.column
}

export function selectionGenerationSourceIds(
  cellId: string,
  selectedCellIds: ReadonlySet<string>,
  cells: readonly NotebookCell[],
): string[] {
  if (selectedCellIds.size < 2 || !selectedCellIds.has(cellId)) return [cellId]
  return cells
    .filter((cell) => selectedCellIds.has(cell.id))
    .sort(gridOrder)
    .map((cell) => cell.id)
}

export function planContextMenuGeneration(input: {
  actions: readonly NotebookGenerationAction[]
  cellId: string
  cellType: ContextMenuGenerationCellType
  document: NotebookDocument
  sourceCellIds: readonly string[]
}): NotebookChatGenerationDraft {
  const sourceReferences = input.sourceCellIds.map((sourceCellId) => {
    const source = input.document.cells.find((cell) => cell.id === sourceCellId)
    if (!source) throw new Error('The source asset cell is no longer available')
    return notebookGridTag(source.slot)
  })
  return planNotebookChatGeneration({
    actions: input.actions,
    cellId: input.cellId,
    command: {
      cellType: input.cellType,
      mediaKind: input.cellType === 'generate_image' ? 'image' : 'video',
      prompt: '',
      sourceReferences,
    },
    document: input.document,
  })
}

function isImageCell(cell: Pick<NotebookCell, 'type'>): boolean {
  return cell.type === 'image' || cell.type === 'generate_image'
}

export function contextMenuGenerationLabel(
  cellType: ContextMenuGenerationCellType,
  sources: readonly Pick<NotebookCell, 'type'>[],
): string {
  const label = cellType === 'generate_video' ? 'Generate video' : 'Generate image'
  if (sources.length < 2) return label
  return `${label} from ${sources.length} ${sources.every(isImageCell) ? 'images' : 'cells'}`
}
