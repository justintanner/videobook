import type { DragEvent } from 'react'
import type { SlotPosition } from './generation-slot-layout'

const CELL_REF_MIME = 'application/x-videobook-cell-ref'

export type CellRefDrag = {
  sourceCellId: string
  from: SlotPosition | null
}

export type CellRefDragPoint = {
  x: number
  y: number
}

export type CellRefDragImage = {
  hotspot: CellRefDragPoint
  width: number
  height: number
}

export type CellRefDragBox = {
  left: number
  top: number
  width: number
  height: number
}

const HOTSPOT_INSET_RIGHT = 12
const HOTSPOT_DEPTH = 20 / 26
const TRAIL_END_DEPTH = 18 / 26

let activeDrag: CellRefDrag | null = null

export function startCellRefDrag(event: DragEvent<HTMLElement>, drag: CellRefDrag): void {
  activeDrag = drag
  event.dataTransfer.setData(CELL_REF_MIME, JSON.stringify(drag))
  event.dataTransfer.effectAllowed = 'copyMove'
}

export function cellRefDragHotspot(width: number, height: number): CellRefDragPoint {
  return {
    x: Math.max(0, Math.round(width - HOTSPOT_INSET_RIGHT)),
    y: Math.round(height * HOTSPOT_DEPTH),
  }
}

export function setCellRefDragImage(
  event: DragEvent<HTMLElement>,
  label: string,
  family: string,
): CellRefDragImage {
  const ghost = document.createElement('span')
  ghost.className = 'cell-ref-ghost'
  ghost.dataset.family = family
  ghost.textContent = label
  document.body.append(ghost)
  const width = ghost.offsetWidth
  const height = ghost.offsetHeight
  const hotspot = cellRefDragHotspot(width, height)
  event.dataTransfer.setDragImage(ghost, hotspot.x, hotspot.y)
  window.setTimeout(() => ghost.remove(), 0)
  return { hotspot, width, height }
}

export function cellRefTrailStart(address: CellRefDragBox): CellRefDragPoint {
  return {
    x: address.left + address.width * 0.63,
    y: address.top - address.height * 0.07,
  }
}

export function cellRefTrailEnd(pointer: CellRefDragPoint, image: CellRefDragImage): CellRefDragPoint {
  return {
    x: pointer.x - image.hotspot.x,
    y: pointer.y - image.hotspot.y + image.height * TRAIL_END_DEPTH,
  }
}

function trailPoint(x: number, y: number): string {
  return `${Math.round(x)} ${Math.round(y)}`
}

export function cellRefTrailPath(start: CellRefDragPoint, end: CellRefDragPoint): string {
  const dx = end.x - start.x
  const dy = end.y - start.y
  return `M${trailPoint(start.x, start.y)} C ${trailPoint(start.x + dx * 0.15, start.y + dy * 0.48)}, `
    + `${trailPoint(start.x + dx * 0.55, start.y + dy * 0.89)}, ${trailPoint(end.x, end.y)}`
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
