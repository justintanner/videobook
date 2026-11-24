import type { DragEvent } from 'react'
import type { SlotPosition } from './generation-slot-layout'

const CELL_REF_MIME = 'application/x-videobook-cell-ref'

export type CellRefDrag = {
  sourceCellId: string
  from: SlotPosition | null
}

let activeDrag: CellRefDrag | null = null

export function startCellRefDrag(event: DragEvent<HTMLElement>, drag: CellRefDrag): void {
  activeDrag = drag
  event.dataTransfer.setData(CELL_REF_MIME, JSON.stringify(drag))
  event.dataTransfer.effectAllowed = 'copyMove'
}

export function setCellRefDragImage(
  event: DragEvent<HTMLElement>,
  label: string,
  family: string,
): void {
  const ghost = document.createElement('span')
  ghost.className = 'cell-ref-ghost'
  ghost.dataset.family = family
  ghost.textContent = label
  document.body.append(ghost)
  event.dataTransfer.setDragImage(ghost, 14, Math.round(ghost.offsetHeight / 2))
  window.setTimeout(() => ghost.remove(), 0)
}

export function activeCellRefDrag(event: DragEvent<HTMLElement>): CellRefDrag | null {
  return event.dataTransfer.types.includes(CELL_REF_MIME) ? activeDrag : null
}

export function endCellRefDrag(): void {
  activeDrag = null
}

export function isCellRefDragEvent(event: DragEvent<HTMLElement>): boolean {
  return event.dataTransfer.types.includes(CELL_REF_MIME)
}
