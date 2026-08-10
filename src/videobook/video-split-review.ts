import { minimumSplitChunkSeconds } from './notebook-split-command'

export type SplitPreviewWindow = {
  endSeconds: number
  startSeconds: number
}

function roundedSeconds(value: number): number {
  return Math.round(value * 1000) / 1000
}

export function formatSplitTimestamp(value: number): string {
  const totalMilliseconds = Math.max(0, Math.round(value * 1000))
  const minutes = Math.floor(totalMilliseconds / 60_000)
  const seconds = (totalMilliseconds - minutes * 60_000) / 1000
  return `${minutes}:${seconds.toFixed(3).padStart(6, '0')}`
}

export function splitPreviewWindows(input: {
  cutPointSeconds: number
  nextBoundarySeconds: number
  previousBoundarySeconds: number
  windowSeconds?: number
}): { after: SplitPreviewWindow; before: SplitPreviewWindow } {
  const windowSeconds = input.windowSeconds ?? 1.5
  return {
    before: {
      endSeconds: input.cutPointSeconds,
      startSeconds: Math.max(
        input.previousBoundarySeconds,
        input.cutPointSeconds - windowSeconds,
      ),
    },
    after: {
      endSeconds: Math.min(
        input.nextBoundarySeconds,
        input.cutPointSeconds + windowSeconds,
      ),
      startSeconds: input.cutPointSeconds,
    },
  }
}

export function nudgeSplitCutPoint(input: {
  cutPointsSeconds: readonly number[]
  deltaSeconds: number
  index: number
  sourceDurationSeconds: number
}): number[] {
  const current = input.cutPointsSeconds[input.index]
  if (current === undefined) return [...input.cutPointsSeconds]
  const previous = input.cutPointsSeconds[input.index - 1] ?? 0
  const next = input.cutPointsSeconds[input.index + 1]
    ?? input.sourceDurationSeconds
  const minimum = previous + minimumSplitChunkSeconds
  const maximum = next - minimumSplitChunkSeconds
  const nudged = roundedSeconds(Math.min(
    maximum,
    Math.max(minimum, current + input.deltaSeconds),
  ))
  return input.cutPointsSeconds.map((value, index) =>
    index === input.index ? nudged : value)
}

export function insertSplitCutPoint(input: {
  chunkIndex: number
  cutPointsSeconds: readonly number[]
  sourceDurationSeconds: number
}): number[] {
  const boundaries = [
    0,
    ...input.cutPointsSeconds,
    input.sourceDurationSeconds,
  ]
  const start = boundaries[input.chunkIndex]
  const end = boundaries[input.chunkIndex + 1]
  if (
    start === undefined
    || end === undefined
    || end - start < minimumSplitChunkSeconds * 2
  ) {
    return [...input.cutPointsSeconds]
  }
  const cutPoint = roundedSeconds(start + (end - start) / 2)
  return [
    ...input.cutPointsSeconds.slice(0, input.chunkIndex),
    cutPoint,
    ...input.cutPointsSeconds.slice(input.chunkIndex),
  ]
}

export function removeSplitCutPoint(
  cutPointsSeconds: readonly number[],
  index: number,
): number[] {
  if (cutPointsSeconds.length <= 1) return [...cutPointsSeconds]
  return cutPointsSeconds.filter((_, candidateIndex) => candidateIndex !== index)
}

export function durationTargetsToCutPoints(
  targets: readonly number[],
): number[] {
  let cursor = 0
  return targets.map((target) => {
    cursor = roundedSeconds(cursor + target)
    return cursor
  })
}
