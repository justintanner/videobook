import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  cellRefTrailEnd,
  cellRefTrailPath,
  type CellRefDragImage,
  type CellRefDragPoint,
} from '@/videobook/cell-ref-drag'

function useDragPointer(initial: CellRefDragPoint): CellRefDragPoint {
  const [pointer, setPointer] = useState<CellRefDragPoint>(initial)

  useEffect(() => {
    let frame = 0
    const follow = (event: DragEvent) => {
      const next = { x: event.clientX, y: event.clientY }
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setPointer(next))
    }
    document.addEventListener('dragover', follow, true)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('dragover', follow, true)
    }
  }, [])

  return pointer
}

export function CellRefDragTrail({
  start,
  pointer: initialPointer,
  image,
  family,
}: {
  start: CellRefDragPoint
  pointer: CellRefDragPoint
  image: CellRefDragImage
  family: string
}) {
  const pointer = useDragPointer(initialPointer)
  return createPortal(
    <svg className="cell-ref-trail" data-family={family} aria-hidden="true">
      <path d={cellRefTrailPath(start, cellRefTrailEnd(pointer, image))} />
    </svg>,
    document.body,
  )
}
