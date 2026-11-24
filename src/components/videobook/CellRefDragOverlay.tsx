import { createPortal } from 'react-dom'
import {
  cellRefTrailEnd,
  cellRefTrailPath,
  type CellRefDragPoint,
} from '@/videobook/cell-ref-drag'
import type { CellRefLift } from '@/videobook/cell-ref-pointer-drag'

export function CellRefDragOverlay({
  lift,
  pointer,
  label,
  family,
}: {
  lift: CellRefLift
  pointer: CellRefDragPoint
  label: string
  family: string
}) {
  const ghostAt = {
    left: pointer.x - lift.image.hotspot.x,
    top: pointer.y - lift.image.hotspot.y,
  }
  return createPortal(
    <>
      <svg className="cell-ref-trail" data-family={family} aria-hidden="true">
        <path d={cellRefTrailPath(lift.start, cellRefTrailEnd(pointer, lift.image))} />
      </svg>
      <span className="cell-ref-ghost cell-ref-ghost-live" data-family={family} aria-hidden="true" style={ghostAt}>
        {label}
      </span>
    </>,
    document.body,
  )
}
