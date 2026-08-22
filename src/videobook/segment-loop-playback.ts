type SegmentLoopWindow = {
  endSeconds: number
  startSeconds: number
}

type SegmentLoopAction =
  | { type: 'continue' }
  | { type: 'seek'; timeSeconds: number; windowIndex: number }

const DEFAULT_FRAME_SECONDS = 1 / 60

function windowAt(
  windows: readonly SegmentLoopWindow[],
  index: number,
): SegmentLoopWindow | undefined {
  return windows[index]
}

export function nextSegmentLoopAction(input: {
  activeWindowIndex: number
  currentTimeSeconds: number
  frameDurationSeconds?: number
  pendingSeekSeconds?: number | null
  windows: readonly SegmentLoopWindow[]
}): SegmentLoopAction {
  const windows = input.windows.filter((window) =>
    Number.isFinite(window.startSeconds)
    && Number.isFinite(window.endSeconds)
    && window.endSeconds > window.startSeconds)
  if (windows.length === 0) return { type: 'continue' }
  const frameDurationSeconds = input.frameDurationSeconds ?? DEFAULT_FRAME_SECONDS
  const pendingSeekSeconds = input.pendingSeekSeconds
  if (
    typeof pendingSeekSeconds === 'number'
    && Number.isFinite(pendingSeekSeconds)
    && Math.abs(input.currentTimeSeconds - pendingSeekSeconds) > frameDurationSeconds
  ) {
    return { type: 'continue' }
  }
  const activeWindowIndex = Math.min(
    windows.length - 1,
    Math.max(0, input.activeWindowIndex),
  )
  const window = windowAt(windows, activeWindowIndex)!
  const currentTimeSeconds = input.currentTimeSeconds
  if (
    currentTimeSeconds >= window.startSeconds
    && currentTimeSeconds < window.endSeconds
  ) {
    return { type: 'continue' }
  }
  if (currentTimeSeconds >= window.endSeconds) {
    const windowIndex = (activeWindowIndex + 1) % windows.length
    const next = windows[windowIndex]!
    return {
      type: 'seek',
      timeSeconds: next.startSeconds,
      windowIndex,
    }
  }
  return {
    type: 'seek',
    timeSeconds: window.startSeconds,
    windowIndex: activeWindowIndex,
  }
}

export function defaultSlowLoopPlayback(durationSeconds: number): boolean {
  return durationSeconds > 0 && durationSeconds < 0.25
}
