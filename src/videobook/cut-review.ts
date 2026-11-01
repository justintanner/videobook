import type { SceneData, SceneMarker } from '../../server/src/scene-cuts'

export type CutReviewStatus = 'pending' | 'kept' | 'removed'

export type CutReviewRow = {
  t: number
  score: number | null
  status: CutReviewStatus
}

export function cutKey(seconds: number): string {
  return seconds.toFixed(3)
}

function matchTolerance(frameStep: number | null): number {
  return Math.max(frameStep ?? 0, 0.02)
}

function detectedCutScore(
  scenes: SceneData,
  seconds: number,
  frameStep: number | null,
): number | null {
  const tolerance = matchTolerance(frameStep)
  return scenes.cuts.find((marker) => Math.abs(marker.t - seconds) <= tolerance)?.score ?? null
}

export function cutReviewRows(input: {
  cutPointsSeconds: readonly number[]
  frameStep: number | null
  removedSeconds: readonly number[]
  reviewedKeys: ReadonlySet<string>
  scenes: SceneData
}): CutReviewRow[] {
  const active = input.cutPointsSeconds.map((t) => ({
    t,
    score: detectedCutScore(input.scenes, t, input.frameStep),
    status: input.reviewedKeys.has(cutKey(t)) ? 'kept' as const : 'pending' as const,
  }))
  const removed = input.removedSeconds.map((t) => ({
    t,
    score: detectedCutScore(input.scenes, t, input.frameStep),
    status: 'removed' as const,
  }))
  return [...active, ...removed].sort((left, right) => left.t - right.t)
}

export function weakerCandidates(input: {
  cutPointsSeconds: readonly number[]
  frameStep: number | null
  removedSeconds: readonly number[]
  scenes: SceneData
}): SceneMarker[] {
  const tolerance = matchTolerance(input.frameStep)
  const known = [...input.cutPointsSeconds, ...input.removedSeconds]
  return input.scenes.cuts.filter((marker) =>
    known.every((t) => Math.abs(t - marker.t) > tolerance))
}

export function nextPendingCut(rows: readonly CutReviewRow[], after: number): number | null {
  const pending = rows.filter((row) => row.status === 'pending')
  return (pending.find((row) => row.t > after) ?? pending[0])?.t ?? null
}

export function previousCut(rows: readonly CutReviewRow[], before: number): number | null {
  const earlier = rows.filter((row) => row.status !== 'removed' && row.t < before)
  return earlier.at(-1)?.t ?? null
}

export function reviewProgress(rows: readonly CutReviewRow[]): { done: number; total: number } {
  return {
    done: rows.filter((row) => row.status !== 'pending').length,
    total: rows.length,
  }
}
