interface CommandComposerFocusTarget {
  focus: (options?: FocusOptions) => void
}

type FrameScheduler = (callback: FrameRequestCallback) => number

export function restoreCommandComposerFocus(
  resolveTarget: () => CommandComposerFocusTarget | null,
  scheduleFrame: FrameScheduler = (callback) => window.requestAnimationFrame(callback),
): void {
  scheduleFrame(() => resolveTarget()?.focus({ preventScroll: true }))
}
