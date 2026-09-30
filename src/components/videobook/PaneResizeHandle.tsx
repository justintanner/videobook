import { useLayoutEffect, useRef, useState } from 'react'
import './PaneResizeHandle.css'

export function PaneResizeHandle({
  label,
  targetSelector,
  edge,
  minimum,
  reserve = 0,
  onResize,
}: {
  label: string
  targetSelector: string
  edge: 'top' | 'bottom'
  minimum: number
  reserve?: number
  onResize: (height: number) => void
}) {
  const handleRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ y: number; height: number } | null>(null)
  const [size, setSize] = useState({ height: minimum, min: minimum, max: minimum })

  useLayoutEffect(() => {
    const target = handleRef.current?.closest<HTMLElement>(targetSelector)
    if (!target) return
    const measure = () => {
      const limit = parseFloat(getComputedStyle(target).maxHeight)
      const parentLimit = reserve > 0 && target.parentElement
        ? target.parentElement.clientHeight - reserve
        : window.innerHeight
      const max = Math.max(0, Math.min(Number.isFinite(limit) ? limit : parentLimit, parentLimit))
      const next = { height: Math.round(target.getBoundingClientRect().height), min: Math.min(minimum, max), max: Math.round(max) }
      setSize((current) => current.height === next.height && current.min === next.min && current.max === next.max ? current : next)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(target)
    if (target.parentElement) observer.observe(target.parentElement)
    measure()
    return () => observer.disconnect()
  }, [minimum, reserve, targetSelector])

  const resize = (height: number) => onResize(Math.round(Math.max(size.min, Math.min(size.max, height))))
  const direction = edge === 'top' ? -1 : 1

  return (
    <div
      ref={handleRef}
      className={`pane-resize-handle pane-resize-handle-${edge}`}
      role="separator"
      aria-label={label}
      aria-orientation="horizontal"
      aria-valuemin={size.min}
      aria-valuemax={size.max}
      aria-valuenow={size.height}
      aria-valuetext={`${size.height} pixels`}
      tabIndex={0}
      data-composer-focus="preserve"
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.currentTarget.focus({ preventScroll: true })
        event.currentTarget.setPointerCapture(event.pointerId)
        dragRef.current = { y: event.clientY, height: size.height }
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current
        if (drag) resize(drag.height + direction * (event.clientY - drag.y))
      }}
      onPointerUp={(event) => {
        dragRef.current = null
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      }}
      onLostPointerCapture={() => { dragRef.current = null }}
      onKeyDown={(event) => {
        if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        event.stopPropagation()
        if (event.key === 'Home') resize(size.min)
        else if (event.key === 'End') resize(size.max)
        else resize(size.height + direction * (event.key === 'ArrowUp' ? -24 : 24))
      }}
    />
  )
}
