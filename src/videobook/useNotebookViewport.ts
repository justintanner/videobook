import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { Viewport } from '@xyflow/react'
import { revealNotebookCell } from './notebook-result-reveal'
import {
  fitNotebookGridZoom,
  normalizeNotebookGridZoom,
  stepNotebookGridZoom,
} from './notebook-grid'

export function useNotebookViewport(bookId: string, notebookId: string | undefined, active: boolean) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [surface, setSurface] = useState({ width: 0, height: 0 })
  const [manualZoom, setManualZoom] = useState<number | null>(null)
  const appliedZoomRef = useRef(1)
  const anchorRef = useRef({ left: 0, top: 0 })
  const revealCleanupRef = useRef<(() => void) | null>(null)
  const fitting = manualZoom === null
  const zoom = manualZoom ?? fitNotebookGridZoom(surface.width)

  const rememberPosition = useCallback(() => {
    const container = scrollRef.current
    if (!container) return
    anchorRef.current = {
      left: container.scrollLeft / appliedZoomRef.current,
      top: container.scrollTop / appliedZoomRef.current,
    }
  }, [])

  useLayoutEffect(() => {
    const container = scrollRef.current
    if (!active || !container) return
    container.scrollLeft = 0
    container.scrollTop = 0
    anchorRef.current = { left: 0, top: 0 }
    const sync = () => {
      rememberPosition()
      const style = getComputedStyle(container)
      const width = Math.max(0, container.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight))
      const height = container.clientHeight
      setSurface(current => current.width === width && current.height === height
        ? current
        : { width, height })
    }
    sync()
    container.addEventListener('scroll', rememberPosition, { passive: true })
    const observer = new ResizeObserver(sync)
    observer.observe(container)
    return () => {
      revealCleanupRef.current?.()
      container.removeEventListener('scroll', rememberPosition)
      observer.disconnect()
    }
  }, [active, bookId, notebookId, rememberPosition])

  useLayoutEffect(() => {
    const container = scrollRef.current
    if (!active || !container) return
    container.scrollTop = anchorRef.current.top * zoom
    container.scrollLeft = fitting ? 0 : anchorRef.current.left * zoom
    appliedZoomRef.current = zoom
    rememberPosition()
  }, [active, fitting, rememberPosition, zoom])

  const updateViewport = useCallback((viewport: Viewport) => {
    const next = normalizeNotebookGridZoom(viewport.zoom)
    if (Math.abs(next - zoom) < 0.000001) return
    rememberPosition()
    setManualZoom(next)
  }, [rememberPosition, zoom])

  const adjustZoom = useCallback((change: number) => {
    rememberPosition()
    setManualZoom(stepNotebookGridZoom(zoom, change))
  }, [rememberPosition, zoom])

  const fitToWidth = useCallback(() => {
    rememberPosition()
    if (scrollRef.current) scrollRef.current.scrollLeft = 0
    setManualZoom(null)
  }, [rememberPosition])

  const revealCell = useCallback((cellId: string) => {
    revealCleanupRef.current?.()
    revealCleanupRef.current = revealNotebookCell(() => scrollRef.current, cellId)
  }, [])

  return { scrollRef, surface, zoom, fitting, updateViewport, adjustZoom, fitToWidth, revealCell }
}
