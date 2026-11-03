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

export function activeCellRefDrag(event: DragEvent<HTMLElement>): CellRefDrag | null {
  return event.dataTransfer.types.includes(CELL_REF_MIME) ? activeDrag : null
}

export function endCellRefDrag(): void {
  activeDrag = null
}

export function isCellRefDragEvent(event: DragEvent<HTMLElement>): boolean {
  return event.dataTransfer.types.includes(CELL_REF_MIME)
}
