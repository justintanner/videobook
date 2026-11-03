import { roundedSplitSeconds } from './notebook-split-command'
import { splitSegments } from './video-split-segments'

export type TimelineSpan = {
  startSeconds: number
  endSeconds: number
}

export type SplitResultTimeline = {
  sourceSeconds: number
  keptSeconds: number
  removedSeconds: number
  kept: TimelineSpan[]
  removed: TimelineSpan[]
  splicePointsSeconds: number[]
}

function mergeAdjacent(spans: readonly TimelineSpan[]): TimelineSpan[] {
  return spans.reduce<TimelineSpan[]>((merged, { startSeconds, endSeconds }) => {
    const span = { startSeconds, endSeconds }
    const last = merged.at(-1)
    if (last && last.endSeconds === span.startSeconds) {
      return [...merged.slice(0, -1), { startSeconds: last.startSeconds, endSeconds: span.endSeconds }]
    }
    return [...merged, span]
  }, [])
}

function totalSeconds(spans: readonly TimelineSpan[]): number {
  return roundedSplitSeconds(spans.reduce((sum, span) => sum + span.endSeconds - span.startSeconds, 0))
}

function splicePoints(kept: readonly TimelineSpan[]): number[] {
  return kept.slice(0, -1).map((_, index) =>
    totalSeconds(kept.slice(0, index + 1)))
}

export function splitResultTimeline(input: {
  cutPointsSeconds: readonly number[]
  outputMode: 'keep' | 'remove'
  selectedIndex: number
  sourceDurationSeconds: number
}): SplitResultTimeline | null {
  const segments = splitSegments(input)
  const selected = segments[input.selectedIndex] ?? segments[0]
  if (!selected) return null
  const others = segments.filter((segment) => segment.index !== selected.index)
  const keeping = input.outputMode === 'keep'
  const kept = mergeAdjacent(keeping ? [selected] : others)
  const removed = mergeAdjacent(keeping ? others : [selected])
  return {
    sourceSeconds: roundedSplitSeconds(input.sourceDurationSeconds),
    keptSeconds: totalSeconds(kept),
    removedSeconds: totalSeconds(removed),
    kept,
    removed,
    splicePointsSeconds: splicePoints(kept),
  }
}
