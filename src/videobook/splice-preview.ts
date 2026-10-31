import {
  lowestScoreIndex,
  spliceCutForOverlap,
  type SpliceCut,
} from '../../server/src/splice-match'
import type { SplicePreviewMatch } from './use-splice-preview'

export type SpliceMatchQuality = 'seamless' | 'close' | 'visible' | 'hard'

export type SplicePlan = {
  cut: number
  frameIndex: number | null
  score: number | null
  trimmed: number
  total: number | null
  quality: SpliceMatchQuality | null
}

export const SPLICE_QUALITY_LABELS: Record<SpliceMatchQuality, string> = {
  seamless: 'Seamless match',
  close: 'Close match',
  visible: 'Visible cut',
  hard: 'Hard cut',
}

export function spliceMatchQuality(score: number): SpliceMatchQuality {
  if (score < 2) return 'seamless'
  if (score < 5) return 'close'
  if (score < 12) return 'visible'
  return 'hard'
}

function planFromCut(
  cut: SpliceCut,
  firstDuration: number,
  secondDuration: number | null,
): SplicePlan {
  return {
    cut: cut.timestamp,
    frameIndex: cut.frameIndex,
    score: cut.score,
    trimmed: Math.max(0, firstDuration - cut.timestamp),
    total: secondDuration === null ? null : cut.timestamp + secondDuration,
    quality: cut.score === null ? null : spliceMatchQuality(cut.score),
  }
}

export function splicePlan(
  overlap: number,
  match: SplicePreviewMatch | null,
  firstDuration: number | null,
  secondDuration: number | null,
): SplicePlan | null {
  if (match) {
    const cut = spliceCutForOverlap(match, overlap)
    return cut ? planFromCut(cut, match.firstDuration, match.secondDuration) : null
  }
  if (overlap !== 0 || firstDuration === null) return null
  return planFromCut(
    { frameIndex: null, timestamp: firstDuration, score: null },
    firstDuration,
    secondDuration,
  )
}

export function spliceScorePath(
  scores: readonly number[],
  width: number,
  height: number,
): string {
  if (scores.length === 0) return ''
  const peak = Math.max(...scores, 1)
  const step = scores.length > 1 ? width / (scores.length - 1) : 0
  return scores
    .map((score, index) => {
      const x = (index * step).toFixed(2)
      const y = ((score / peak) * height).toFixed(2)
      return `${index === 0 ? 'M' : 'L'}${x} ${y}`
    })
    .join(' ')
}

export function spliceWindowStart(match: SplicePreviewMatch): number {
  return match.windowStartFrame / match.fps
}

export function spliceWindowFraction(
  match: SplicePreviewMatch,
  seconds: number,
): number {
  const start = spliceWindowStart(match)
  const span = match.firstDuration - start
  if (span <= 0) return 1
  return Math.min(1, Math.max(0, (seconds - start) / span))
}

export function formatSpliceSeconds(seconds: number): string {
  return `${seconds.toFixed(2)}s`
}

export function overlapDraftValue(seconds: number): string {
  return String(Math.round(seconds * 1000) / 1000)
}

export function spliceBestOverlap(match: SplicePreviewMatch): number | null {
  const index = lowestScoreIndex(match.scores)
  if (index < 0) return null
  const frame = match.windowStartFrame + index
  return Math.max(1 / match.fps, match.firstDuration - (frame - 0.5) / match.fps)
}

export type SplicePlaybackPhase = 'first' | 'second'

export type SpliceTimeline = {
  cut: number
  total: number
  frameSeconds: number
}

export type SpliceTimelineSource = {
  phase: SplicePlaybackPhase
  time: number
}

export function spliceTimelineSource(
  timeline: SpliceTimeline,
  position: number,
): SpliceTimelineSource {
  const clamped = Math.min(Math.max(0, position), timeline.total)
  return clamped < timeline.cut
    ? { phase: 'first', time: clamped }
    : { phase: 'second', time: clamped - timeline.cut }
}
