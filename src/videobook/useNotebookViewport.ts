import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { revealNotebookCell } from './notebook-result-reveal'
import { fitNotebookGridZoom } from './notebook-grid'

export function useNotebookViewport(bookId: string, notebookId: string | undefined, active: boolean) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [surface, setSurface] = useState({ width: 0, height: 0, minimumZoom: 0 })
  const appliedZoomRef = useRef(1)
  const anchorTopRef = useRef(0)
  const revealCleanupRef = useRef<(() => void) | null>(null)
  const zoom = fitNotebookGridZoom(surface.width, surface.minimumZoom)

  const rememberPosition = useCallback(() => {
    const container = scrollRef.current
    if (!container) return
    anchorTopRef.current = container.scrollTop / appliedZoomRef.current
  }, [])

  useLayoutEffect(() => {
    const container = scrollRef.current
    if (!active || !container) return
    container.scrollLeft = 0
    container.scrollTop = 0
    anchorTopRef.current = 0
    const sync = () => {
      rememberPosition()
      const style = getComputedStyle(container)
      const width = Math.max(0, container.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight))
      const height = container.clientHeight
      const minimumZoom = parseFloat(style.getPropertyValue('--notebook-minimum-zoom')) || 0
      setSurface(current => current.width === width && current.height === height && current.minimumZoom === minimumZoom
        ? current
        : { width, height, minimumZoom })
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
    container.scrollTop = anchorTopRef.current * zoom
    appliedZoomRef.current = zoom
    rememberPosition()
  }, [active, rememberPosition, zoom])

  const revealCell = useCallback((cellId: string) => {
    revealCleanupRef.current?.()
    revealCleanupRef.current = revealNotebookCell(() => scrollRef.current, cellId)
  }, [])

  return { scrollRef, surface, zoom, revealCell }
}
