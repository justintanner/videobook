import {
  beginCellRefDrag,
  cellRefTrailStart,
  endCellRefDrag,
  measureCellRefGhost,
  type CellRefDrag,
  type CellRefDragImage,
  type CellRefDragPoint,
} from './cell-ref-drag'

export type CellRefLift = {
  start: CellRefDragPoint
  image: CellRefDragImage
}

export type CellRefPointerDragHandlers = {
  onLift: (lift: CellRefLift, pointer: CellRefDragPoint) => void
  onMove: (pointer: CellRefDragPoint) => void
  onEnd: () => void
}

type CellRefGhostLabel = {
  label: string
  family: string
}

type DragSession = {
  data: DataTransfer
  target: Element | null
  accepted: boolean
}

const DRAG_THRESHOLD_PX = 4
const DRAGGING_CLASS = 'cell-ref-dragging'

function pointOf(event: PointerEvent): CellRefDragPoint {
  return { x: event.clientX, y: event.clientY }
}

function fireDrag(
  type: string,
  target: Element,
  data: DataTransfer,
  at: CellRefDragPoint,
  relatedTarget: Element | null,
  altKey: boolean,
): boolean {
  return target.dispatchEvent(new DragEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    dataTransfer: data,
    clientX: at.x,
    clientY: at.y,
    relatedTarget,
    altKey,
  }))
}

function moveOver(session: DragSession, at: CellRefDragPoint, altKey: boolean): void {
  const next = document.elementFromPoint(at.x, at.y)
  if (next !== session.target) {
    if (next) fireDrag('dragenter', next, session.data, at, session.target, altKey)
    if (session.target) fireDrag('dragleave', session.target, session.data, at, next, altKey)
    session.target = next
  }
  session.accepted = session.target !== null
    && !fireDrag('dragover', session.target, session.data, at, null, altKey)
}

function release(session: DragSession, at: CellRefDragPoint, altKey: boolean, dropped: boolean): void {
  if (!session.target) return
  if (dropped && session.accepted) {
    fireDrag('drop', session.target, session.data, at, null, altKey)
    return
  }
  fireDrag('dragleave', session.target, session.data, at, null, altKey)
}

function swallowNextClick(): void {
  const swallow = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
  }
  window.addEventListener('click', swallow, { capture: true, once: true })
  window.setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0)
}

export function trackCellRefPointerDrag(
  down: PointerEvent,
  source: HTMLElement,
  drag: CellRefDrag,
  ghost: CellRefGhostLabel,
  handlers: CellRefPointerDragHandlers,
): void {
  const origin = pointOf(down)
  let session: DragSession | null = null
  let latest = origin
  let frame = 0

  const begin = (at: CellRefDragPoint): DragSession => {
    document.documentElement.classList.add(DRAGGING_CLASS)
    handlers.onLift({
      start: cellRefTrailStart(source.getBoundingClientRect()),
      image: measureCellRefGhost(ghost.label, ghost.family),
    }, at)
    return { data: beginCellRefDrag(drag), target: null, accepted: false }
  }
  const publish = (at: CellRefDragPoint) => {
    latest = at
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      handlers.onMove(latest)
    })
  }
  const finish = (altKey: boolean, dropped: boolean) => {
    window.removeEventListener('pointermove', move, true)
    window.removeEventListener('pointerup', up, true)
    window.removeEventListener('pointercancel', cancel, true)
    window.removeEventListener('keydown', escape, true)
    cancelAnimationFrame(frame)
    if (!session) return
    release(session, latest, altKey, dropped)
    session = null
    document.documentElement.classList.remove(DRAGGING_CLASS)
    endCellRefDrag()
    swallowNextClick()
    handlers.onEnd()
  }
  const move = (event: PointerEvent) => {
    if (event.pointerId !== down.pointerId) return
    const at = pointOf(event)
    if (!session) {
      if (Math.hypot(at.x - origin.x, at.y - origin.y) < DRAG_THRESHOLD_PX) return
      session = begin(at)
    }
    event.preventDefault()
    moveOver(session, at, event.altKey)
    publish(at)
  }
  const up = (event: PointerEvent) => {
    if (event.pointerId !== down.pointerId) return
    latest = pointOf(event)
    if (session) moveOver(session, latest, event.altKey)
    finish(event.altKey, true)
  }
  const cancel = (event: PointerEvent) => {
    if (event.pointerId === down.pointerId) finish(event.altKey, false)
  }
  const escape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !session) return
    event.preventDefault()
    event.stopPropagation()
    finish(event.altKey, false)
  }

  window.addEventListener('pointermove', move, true)
  window.addEventListener('pointerup', up, true)
  window.addEventListener('pointercancel', cancel, true)
  window.addEventListener('keydown', escape, true)
}
