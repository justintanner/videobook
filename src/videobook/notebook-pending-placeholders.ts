import type { NotebookCell, NotebookCellType, NotebookGridSlot } from 'videobook-engine'
import { placeGenerationTake } from '../../server/src/notebook-rounds-placement'
import type { RoundsDocument } from '../../server/src/notebook-rounds'
import type { CanvasNode } from './notebook-canvas'
import { notebookGrid, notebookGridPosition, notebookGridSlotKey } from './notebook-grid'

export type PendingPlaceholderKind = 'image' | 'video'

export type PendingPlaceholderStatus = 'queued' | 'downloading'

export interface PendingPlaceholder {
  id: string
  notebookId: string
  kind: PendingPlaceholderKind
  slot: NotebookGridSlot
  status: PendingPlaceholderStatus
  startedAt: string
}

const PENDING_PLACEHOLDER_PREFIX = 'pending:'

export function pendingPlaceholderId(token: string): string {
  return `${PENDING_PLACEHOLDER_PREFIX}${token}`
}

export function generationPlaceholderKind(
  cellType: NotebookCellType,
): PendingPlaceholderKind | null {
  if (cellType === 'generate_image') return 'image'
  if (cellType === 'generate_video') return 'video'
  return null
}

export function generationTakePlaceholderSlot(
  document: RoundsDocument,
  generator: Pick<NotebookCell, 'id' | 'type' | 'slot' | 'prompt' | 'inputs'>,
): NotebookGridSlot {
  const known = document.cells.some((cell) => cell.id === generator.id)
  const cells = known
    ? document.cells.map((cell) => cell.id === generator.id ? generator : cell)
    : [...document.cells, generator]
  return placeGenerationTake({ cells, edges: document.edges }, generator.id).slot
}

export function pendingDownloadUrl(input: string): string | null {
  const match = input.trim().match(/^(?:(?:download|import|get|save|grab|fetch)\s+)?(https?:\/\/\S+)$/iu)
  return match?.[1] ?? null
}

function pendingPlaceholderNode(placeholder: PendingPlaceholder): CanvasNode {
  return {
    id: placeholder.id,
    type: 'cell',
    position: notebookGridPosition(placeholder.slot),
    initialWidth: notebookGrid.cellWidth,
    initialHeight: notebookGrid.cellHeight,
    selectable: false,
    draggable: false,
    connectable: false,
    deletable: false,
    focusable: false,
    data: {
      kind: placeholder.kind,
      subtitle: `${placeholder.kind.toUpperCase()} · CELL`,
      slot: placeholder.slot,
      status: placeholder.status,
      statusStartedAt: placeholder.startedAt,
      pending: true,
    },
  }
}

export function nodesWithPendingPlaceholders(
  nodes: CanvasNode[],
  placeholders: readonly PendingPlaceholder[],
  notebookId: string | null,
): CanvasNode[] {
  if (placeholders.length === 0 || !notebookId) return nodes
  const taken = new Set(nodes.map((node) => notebookGridSlotKey(node.data.slot)))
  const shown = placeholders.flatMap((placeholder) => {
    const key = notebookGridSlotKey(placeholder.slot)
    if (placeholder.notebookId !== notebookId || taken.has(key)) return []
    taken.add(key)
    return [pendingPlaceholderNode(placeholder)]
  })
  return shown.length === 0 ? nodes : [...nodes, ...shown]
}
