interface NotebookScrollTarget {
  readonly scrollHeight: number
  scrollTo: (options: ScrollToOptions) => void
}

type FrameScheduler = (callback: FrameRequestCallback) => number

export function revealNotebookResult(
  resolveTarget: () => NotebookScrollTarget | null,
  scheduleFrame: FrameScheduler = (callback) => window.requestAnimationFrame(callback),
): void {
  scheduleFrame(() => {
    scheduleFrame(() => {
      const target = resolveTarget()
      if (!target) return
      target.scrollTo({
        top: target.scrollHeight,
        behavior: 'smooth',
      })
    })
  })
}

export function revealNotebookCell(
  resolveTarget: () => HTMLElement | null,
  cellId: string,
): () => void {
  const container = resolveTarget()
  if (!container) return () => undefined
  const composer = container.closest('.app-shell')
    ?.querySelector('.command-composer:not([hidden])')
  let frame = 0
  let stopped = false
  const stop = () => {
    stopped = true
    window.cancelAnimationFrame(frame)
    observer.disconnect()
    container.scrollTo({ top: container.scrollTop, behavior: 'instant' })
    window.removeEventListener('pointerdown', stop, true)
    window.removeEventListener('wheel', stop, true)
    window.removeEventListener('keydown', stop, true)
    window.removeEventListener('resize', stop)
  }
  const reveal = () => {
    if (stopped) return
    const target = resolveTarget()
    if (!target) return stop()
    const selected = target.querySelectorAll('.react-flow__node.selected')
    const cell = selected.length === 1 ? selected[0] : null
    if (!cell || cell.getAttribute('data-id') !== cellId) return stop()
    const viewport = target.getBoundingClientRect()
    const bottom = Math.min(
      viewport.top + target.clientHeight,
      composer?.getBoundingClientRect().top ?? viewport.bottom,
    )
    const height = bottom - viewport.top
    if (height <= 0) return
    const bounds = cell.getBoundingClientRect()
    const offset = Math.max(16, (height - bounds.height) / 2)
    const top = Math.max(0, Math.min(
      target.scrollHeight - target.clientHeight,
      target.scrollTop + bounds.top - viewport.top - offset,
    ))
    if (Math.abs(top - target.scrollTop) <= 2) return
    target.scrollTo({
      top,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    })
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
