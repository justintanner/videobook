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
