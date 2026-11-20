import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { revealNotebookCells, selectedNotebookCellOnly, type NotebookRevealMode } from './notebook-result-reveal'
import { fitNotebookGridCellHeight, fitNotebookGridZoom, notebookGrid } from './notebook-grid'

const CREATED_CELL_RENDER_WAIT_MS = 5_000

export function useNotebookViewport(bookId: string, notebookId: string | undefined, active: boolean, commandRowHeight: number) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [surface, setSurface] = useState({ width: 0, height: 0, fitHeight: 0, minimumZoom: 0 })
  const appliedRowPitchRef = useRef<number>(notebookGrid.rowPitch)
  const anchorTopRef = useRef(0)
  const revealCleanupRef = useRef<(() => void) | null>(null)
  const zoom = fitNotebookGridZoom(surface.width, surface.minimumZoom)
  const cellHeight = fitNotebookGridCellHeight(surface.fitHeight, zoom)
  const rowPitch = (cellHeight + notebookGrid.gap) * zoom

  const rememberPosition = useCallback(() => {
    const container = scrollRef.current
    if (!container) return
    anchorTopRef.current = container.scrollTop / appliedRowPitchRef.current
  }, [])

  useLayoutEffect(() => {
    const container = scrollRef.current
    if (!active || !container) return
    container.scrollLeft = 0
    container.scrollTop = 0
    anchorTopRef.current = 0
  }, [active, bookId, notebookId])

  useLayoutEffect(() => {
    const container = scrollRef.current
    if (!active || !container) return
    const sync = () => {
      rememberPosition()
      const style = getComputedStyle(container)
      const width = Math.max(0, container.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight))
      const height = container.clientHeight
      const composerReserve = commandRowHeight
        + (parseFloat(style.getPropertyValue('--app-gutter')) || 0)
        + (parseFloat(style.getPropertyValue('--app-gap')) || 0) + 16
      const fitHeight = Math.max(0, height - (parseFloat(style.paddingTop) || 0) - composerReserve)
      const minimumZoom = parseFloat(style.getPropertyValue('--notebook-minimum-zoom')) || 0
      setSurface(current => current.width === width && current.height === height
        && current.fitHeight === fitHeight && current.minimumZoom === minimumZoom
        ? current
        : { width, height, fitHeight, minimumZoom })
    }
    sync()
    container.addEventListener('scroll', rememberPosition, { passive: true })
    const observer = new ResizeObserver(sync)
    observer.observe(container)
    return () => {
      container.removeEventListener('scroll', rememberPosition)
      observer.disconnect()
    }
  }, [active, bookId, notebookId, commandRowHeight, rememberPosition])

  useLayoutEffect(() => () => {
    revealCleanupRef.current?.()
    revealCleanupRef.current = null
  }, [active, bookId, notebookId])

  useLayoutEffect(() => {
    const container = scrollRef.current
    if (!active || !container) return
    container.scrollTop = anchorTopRef.current * rowPitch
    appliedRowPitchRef.current = rowPitch
    rememberPosition()
  }, [active, rememberPosition, rowPitch])

  const revealCell = useCallback((cellId: string) => {
    revealCleanupRef.current?.()
    revealCleanupRef.current = revealNotebookCells(() => scrollRef.current, [cellId], {
      keep: selectedNotebookCellOnly(cellId),
      horizontal: false,
    })
  }, [])

  const revealCells = useCallback((cellIds: readonly string[], mode: NotebookRevealMode = 'center') => {
    if (cellIds.length === 0) return
    revealCleanupRef.current?.()
    revealCleanupRef.current = revealNotebookCells(() => scrollRef.current, cellIds, {
      mode,
      waitMs: CREATED_CELL_RENDER_WAIT_MS,
    })
  }, [])

  return { scrollRef, surface, zoom, cellHeight, revealCell, revealCells }
}
