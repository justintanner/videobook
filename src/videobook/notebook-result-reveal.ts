export type NotebookRevealMode = 'center' | 'offscreen'

export interface NotebookRevealRect {
  readonly top: number
  readonly bottom: number
  readonly left: number
  readonly right: number
}

export interface NotebookRevealGeometry {
  readonly visible: NotebookRevealRect
  readonly cells: NotebookRevealRect
  readonly scrollTop: number
  readonly scrollLeft: number
  readonly maxScrollTop: number
  readonly maxScrollLeft: number
}

interface NotebookScrollPosition {
  readonly top: number
  readonly left: number
}

interface NotebookRevealOptions {
  readonly mode?: NotebookRevealMode
  readonly horizontal?: boolean
  readonly waitMs?: number
  readonly keep?: (container: HTMLElement) => boolean
}

const REVEAL_MARGIN_PX = 16
const SCROLL_TOLERANCE_PX = 2

function clamp(value: number, max: number): number {
  return Math.max(0, Math.min(Math.max(0, max), value))
}

function rectContains(outer: NotebookRevealRect, inner: NotebookRevealRect): boolean {
  return inner.top >= outer.top && inner.bottom <= outer.bottom
    && inner.left >= outer.left && inner.right <= outer.right
}

function centeredTop(geometry: NotebookRevealGeometry): number {
  const { visible, cells } = geometry
  const height = cells.bottom - cells.top
  const offset = Math.max(REVEAL_MARGIN_PX, (visible.bottom - visible.top - height) / 2)
  return clamp(geometry.scrollTop + cells.top - visible.top - offset, geometry.maxScrollTop)
}

function nearestLeft(geometry: NotebookRevealGeometry): number {
  const { visible, cells } = geometry
  const fitsWidth = cells.right - cells.left <= visible.right - visible.left - REVEAL_MARGIN_PX * 2
  if (cells.left < visible.left || !fitsWidth) {
    return clamp(geometry.scrollLeft + cells.left - visible.left - REVEAL_MARGIN_PX, geometry.maxScrollLeft)
  }
  if (cells.right > visible.right) {
    return clamp(geometry.scrollLeft + cells.right - visible.right + REVEAL_MARGIN_PX, geometry.maxScrollLeft)
  }
  return geometry.scrollLeft
}

export function notebookRevealScroll(
  geometry: NotebookRevealGeometry,
  mode: NotebookRevealMode,
  horizontal = true,
): NotebookScrollPosition | null {
  if (geometry.visible.bottom <= geometry.visible.top) return null
  if (mode === 'offscreen' && rectContains(geometry.visible, geometry.cells)) return null
  const top = centeredTop(geometry)
  const left = horizontal ? nearestLeft(geometry) : geometry.scrollLeft
  const moved = Math.abs(top - geometry.scrollTop) > SCROLL_TOLERANCE_PX
    || Math.abs(left - geometry.scrollLeft) > SCROLL_TOLERANCE_PX
  return moved ? { top, left } : null
}

function unionRect(elements: readonly Element[]): NotebookRevealRect {
  const rects = elements.map((element) => element.getBoundingClientRect())
  return {
    top: Math.min(...rects.map((rect) => rect.top)),
    bottom: Math.max(...rects.map((rect) => rect.bottom)),
    left: Math.min(...rects.map((rect) => rect.left)),
    right: Math.max(...rects.map((rect) => rect.right)),
  }
}

function measureReveal(
  container: HTMLElement,
  composer: Element | null,
  cells: readonly Element[],
): NotebookRevealGeometry {
  const viewport = container.getBoundingClientRect()
  return {
    visible: {
      top: viewport.top,
      bottom: Math.min(
        viewport.top + container.clientHeight,
        composer?.getBoundingClientRect().top ?? viewport.bottom,
      ),
      left: viewport.left,
      right: viewport.left + container.clientWidth,
    },
    cells: unionRect(cells),
    scrollTop: container.scrollTop,
    scrollLeft: container.scrollLeft,
    maxScrollTop: container.scrollHeight - container.clientHeight,
    maxScrollLeft: container.scrollWidth - container.clientWidth,
  }
}

function renderedCells(container: HTMLElement, cellIds: readonly string[]): Element[] {
  return cellIds
    .map((cellId) => container.querySelector(`.react-flow__node[data-id="${cellId}"]`))
    .filter((cell): cell is Element => cell !== null)
}

function scrollBehavior(): ScrollBehavior {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
}

function mainCommandComposer(container: HTMLElement): Element | null {
  const composers = container.closest('.app-shell')
    ?.querySelectorAll('.command-composer:not([hidden])')
  return Array.from(composers ?? []).find((composer) => !composer.closest('dialog')) ?? null
}

export function selectedNotebookCellOnly(cellId: string): (container: HTMLElement) => boolean {
  return (container) => {
    const selected = container.querySelectorAll('.react-flow__node.selected')
    return selected.length === 1 && selected[0].getAttribute('data-id') === cellId
  }
}

export function revealNotebookCells(
  resolveTarget: () => HTMLElement | null,
  cellIds: readonly string[],
  options: NotebookRevealOptions = {},
): () => void {
  const container = resolveTarget()
  if (!container || cellIds.length === 0) return () => undefined
  const composer = mainCommandComposer(container)
  const mode = options.mode ?? 'center'
  const deadline = performance.now() + (options.waitMs ?? 0)
  let frame = 0
  let stopped = false
  const stop = () => {
    stopped = true
    window.cancelAnimationFrame(frame)
    observer.disconnect()
    container.scrollTo({ top: container.scrollTop, left: container.scrollLeft, behavior: 'instant' })
    window.removeEventListener('pointerdown', stop, true)
    window.removeEventListener('wheel', stop, true)
    window.removeEventListener('keydown', stop, true)
    window.removeEventListener('resize', stop)
  }
  const reveal = () => {
    if (stopped) return
    const target = resolveTarget()
    if (!target || options.keep?.(target) === false) return stop()
    const cells = renderedCells(target, cellIds)
    if (cells.length < cellIds.length && performance.now() < deadline) return schedule()
    if (cells.length === 0) return stop()
    const next = notebookRevealScroll(
      measureReveal(target, composer, cells),
      mode,
      options.horizontal ?? true,
    )
    if (next) target.scrollTo({ ...next, behavior: scrollBehavior() })
  }
  const schedule = () => {
    if (stopped) return
    window.cancelAnimationFrame(frame)
    frame = window.requestAnimationFrame(() => {
      frame = window.requestAnimationFrame(reveal)
    })
  }
  const observer = new ResizeObserver(schedule)
  observer.observe(container)
  if (composer) observer.observe(composer)
  window.addEventListener('pointerdown', stop, true)
  window.addEventListener('wheel', stop, { capture: true, passive: true })
  window.addEventListener('keydown', stop, true)
  window.addEventListener('resize', stop)
  schedule()
  return stop
}
