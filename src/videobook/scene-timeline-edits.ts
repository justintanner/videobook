import {
  minimumSplitPieceSeconds,
  roundedSplitSeconds,
} from '../../server/src/notebook-split-plan'

export type SceneCutEdit = {
  cutPointsSeconds: number[]
  selectedIndex: number
}

export function snapToFrame(seconds: number, frameStep: number | null): number {
  if (frameStep === null) return roundedSplitSeconds(seconds)
  return roundedSplitSeconds(Math.round(seconds / frameStep) * frameStep)
}

function pieceIndexAt(cutPointsSeconds: readonly number[], seconds: number): number {
  return cutPointsSeconds.filter((cut) => cut <= seconds).length
}

export function addSceneCut(input: {
  cutPointsSeconds: readonly number[]
  seconds: number
  sourceDurationSeconds: number
}): SceneCutEdit | null {
  const seconds = roundedSplitSeconds(input.seconds)
  if (seconds < minimumSplitPieceSeconds) return null
  if (input.sourceDurationSeconds - seconds < minimumSplitPieceSeconds) return null
  const tooClose = input.cutPointsSeconds.some((cut) =>
    Math.abs(cut - seconds) < minimumSplitPieceSeconds)
  if (tooClose) return null
  const cutPointsSeconds = [...input.cutPointsSeconds, seconds].sort((left, right) => left - right)
  return { cutPointsSeconds, selectedIndex: pieceIndexAt(cutPointsSeconds, seconds) }
}

export function removeSceneCut(input: {
  cutPointsSeconds: readonly number[]
  index: number
}): SceneCutEdit {
  const cutPointsSeconds = input.cutPointsSeconds.filter((_, index) => index !== input.index)
  return { cutPointsSeconds, selectedIndex: Math.max(0, input.index) }
}

export function moveSceneCut(input: {
  cutPointsSeconds: readonly number[]
  index: number
  seconds: number
  sourceDurationSeconds: number
}): SceneCutEdit {
  const previous = input.cutPointsSeconds[input.index - 1] ?? 0
  const next = input.cutPointsSeconds[input.index + 1] ?? input.sourceDurationSeconds
  const low = previous + minimumSplitPieceSeconds
  const high = next - minimumSplitPieceSeconds
  const clamped = roundedSplitSeconds(Math.min(high, Math.max(low, input.seconds)))
  const cutPointsSeconds = input.cutPointsSeconds.map((cut, index) =>
    index === input.index ? clamped : cut)
  return { cutPointsSeconds, selectedIndex: input.index + 1 }
}

export function filmstripTileFrames(input: {
  frames: number
  tiles: number
}): number[] {
  const tiles = Math.max(1, input.tiles)
  return Array.from({ length: tiles }, (_, tile) =>
    Math.min(input.frames - 1, Math.floor(((tile + 0.5) / tiles) * input.frames)))
}
