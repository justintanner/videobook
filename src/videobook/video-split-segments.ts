import {
  compileNotebookSplitOutputs,
  minimumSplitPieceSeconds,
  roundedSplitSeconds,
  type NotebookSplitOutputMode,
  type NotebookSplitRange,
} from './notebook-split-command'

type SplitSegment = {
  durationSeconds: number
  endSeconds: number
  index: number
  startSeconds: number
}

type SplitSegmentEdit = {
  cutPointsSeconds: number[]
  selectedIndex: number
}

type SplitPreviewWindows = {
  segment: NotebookSplitRange
  surroundings: NotebookSplitRange[]
}

function uniqueSorted(values: readonly number[]): number[] {
  return [...new Set(values.map(roundedSplitSeconds))]
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right)
}

function cutsFromBoundaries(boundaries: readonly number[]): number[] {
  return uniqueSorted(boundaries.slice(1, -1))
}

function sameCuts(
  left: readonly number[],
  right: readonly number[],
): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index])
}

export function splitSegments(input: {
  cutPointsSeconds: readonly number[]
  sourceDurationSeconds: number
}): SplitSegment[] {
  const duration = roundedSplitSeconds(input.sourceDurationSeconds)
  const cuts = uniqueSorted(input.cutPointsSeconds)
    .filter((value) => value > 0 && value < duration)
  const boundaries = [0, ...cuts, duration]
  return boundaries.slice(0, -1).map((startSeconds, index) => {
    const endSeconds = boundaries[index + 1]!
    return {
      durationSeconds: roundedSplitSeconds(endSeconds - startSeconds),
      endSeconds,
      index,
      startSeconds,
    }
  })
}

export function durationTargetsToCutPoints(
  targets: readonly number[],
): number[] {
  let cursor = 0
  return targets.map((target) => {
    cursor = roundedSplitSeconds(cursor + target)
    return cursor
  })
}

export function segmentOutputRanges(input: {
  cutPointsSeconds: readonly number[]
  mode: NotebookSplitOutputMode
  selectedIndex: number
  sourceDurationSeconds: number
}): NotebookSplitRange[][] {
  return compileNotebookSplitOutputs({
    cutPointsSeconds: input.cutPointsSeconds,
    outputMode: input.mode,
    selectedChunkIndexes: [input.selectedIndex],
    sourceDurationSeconds: input.sourceDurationSeconds,
  })
}

export function previewWindows(input: {
  leadSeconds?: number
  segment: Pick<SplitSegment, 'endSeconds' | 'startSeconds'>
  sourceDurationSeconds: number
}): SplitPreviewWindows {
  const leadSeconds = input.leadSeconds ?? 1.5
  const duration = roundedSplitSeconds(input.sourceDurationSeconds)
  const startSeconds = roundedSplitSeconds(input.segment.startSeconds)
  const endSeconds = roundedSplitSeconds(input.segment.endSeconds)
  const surroundings: NotebookSplitRange[] = []
  const beforeStart = Math.max(0, roundedSplitSeconds(startSeconds - leadSeconds))
  if (startSeconds > beforeStart) {
    surroundings.push({ startSeconds: beforeStart, endSeconds: startSeconds })
  }
  const afterEnd = Math.min(duration, roundedSplitSeconds(endSeconds + leadSeconds))
  if (afterEnd > endSeconds) {
    surroundings.push({ startSeconds: endSeconds, endSeconds: afterEnd })
  }
  return {
    segment: { startSeconds, endSeconds },
    surroundings,
  }
}

function segmentBoundLimits(input: {
  cutPointsSeconds: readonly number[]
  index: number
  sourceDurationSeconds: number
}): {
  maxEnd: number
  maxStart: number
  minEnd: number
  minStart: number
} {
  const duration = roundedSplitSeconds(input.sourceDurationSeconds)
  const segments = splitSegments(input)
  const segment = segments[input.index]
  if (!segment) {
    return {
      maxEnd: duration,
      maxStart: 0,
      minEnd: minimumSplitPieceSeconds,
      minStart: 0,
    }
  }
  const previousStart = segments[input.index - 1]?.startSeconds ?? 0
  const nextEnd = segments[input.index + 1]?.endSeconds ?? duration
  const minStart = input.index === 0
    ? 0
    : roundedSplitSeconds(previousStart + minimumSplitPieceSeconds)
  const maxEnd = input.index === segments.length - 1
    ? duration
    : roundedSplitSeconds(nextEnd - minimumSplitPieceSeconds)
  return {
    maxEnd,
    maxStart: roundedSplitSeconds(segment.endSeconds - minimumSplitPieceSeconds),
    minEnd: roundedSplitSeconds(segment.startSeconds + minimumSplitPieceSeconds),
    minStart,
  }
}

export function setSegmentBounds(input: {
  cutPointsSeconds: readonly number[]
  endSeconds: number
  index: number
  sourceDurationSeconds: number
  startSeconds: number
}): SplitSegmentEdit {
  const duration = roundedSplitSeconds(input.sourceDurationSeconds)
  const current = splitSegments(input)
  const segment = current[input.index]
  if (!segment) {
    return {
      cutPointsSeconds: [...input.cutPointsSeconds],
      selectedIndex: input.index,
    }
  }
  const limits = segmentBoundLimits(input)
  let startSeconds = roundedSplitSeconds(Math.min(
    limits.maxStart,
    Math.max(limits.minStart, input.startSeconds),
  ))
  if (startSeconds > 0 && startSeconds < minimumSplitPieceSeconds) {
    startSeconds = minimumSplitPieceSeconds
  }
  let endSeconds = roundedSplitSeconds(Math.min(
    limits.maxEnd,
    Math.max(
      Math.max(limits.minEnd, startSeconds + minimumSplitPieceSeconds),
      input.endSeconds,
    ),
  ))
  if (
    endSeconds < duration
    && duration - endSeconds < minimumSplitPieceSeconds
  ) {
    endSeconds = roundedSplitSeconds(duration - minimumSplitPieceSeconds)
  }
  if (
    startSeconds === segment.startSeconds
    && endSeconds === segment.endSeconds
  ) {
    return {
      cutPointsSeconds: [...input.cutPointsSeconds],
      selectedIndex: input.index,
    }
  }
  const previous = current[input.index - 1]
  const next = current[input.index + 1]
  const keepBefore = previous
    ? uniqueSorted(input.cutPointsSeconds.filter((value) => value <= previous.startSeconds))
    : []
  const keepAfter = next
    ? uniqueSorted(input.cutPointsSeconds.filter((value) => value >= next.endSeconds))
    : []
  const inserted: number[] = []
  if (startSeconds > 0) inserted.push(startSeconds)
  if (endSeconds < duration) inserted.push(endSeconds)
  const cutPointsSeconds = uniqueSorted([
    ...keepBefore,
    ...inserted,
    ...keepAfter,
  ]).filter((value) => value > 0 && value < duration)
  const nextSegments = splitSegments({
    cutPointsSeconds,
    sourceDurationSeconds: duration,
  })
  const selectedIndex = nextSegments.findIndex((candidate) =>
    candidate.startSeconds === startSeconds && candidate.endSeconds === endSeconds)
  return {
    cutPointsSeconds,
    selectedIndex: selectedIndex >= 0 ? selectedIndex : input.index,
  }
}

export function moveSegmentStart(input: {
  cutPointsSeconds: readonly number[]
  deltaSeconds: number
  index: number
  sourceDurationSeconds: number
}): SplitSegmentEdit {
  const segments = splitSegments(input)
  const segment = segments[input.index]
  if (!segment) {
    return {
      cutPointsSeconds: [...input.cutPointsSeconds],
      selectedIndex: input.index,
    }
  }
  return setSegmentBounds({
    ...input,
    endSeconds: segment.endSeconds,
    startSeconds: roundedSplitSeconds(segment.startSeconds + input.deltaSeconds),
  })
}

export function moveSegmentEnd(input: {
  cutPointsSeconds: readonly number[]
  deltaSeconds: number
  index: number
  sourceDurationSeconds: number
}): SplitSegmentEdit {
  const segments = splitSegments(input)
  const segment = segments[input.index]
  if (!segment) {
    return {
      cutPointsSeconds: [...input.cutPointsSeconds],
      selectedIndex: input.index,
    }
  }
  return setSegmentBounds({
    ...input,
    endSeconds: roundedSplitSeconds(segment.endSeconds + input.deltaSeconds),
    startSeconds: segment.startSeconds,
  })
}

export function moveSegment(input: {
  cutPointsSeconds: readonly number[]
  deltaSeconds: number
  index: number
  sourceDurationSeconds: number
}): SplitSegmentEdit {
  const segments = splitSegments(input)
  const segment = segments[input.index]
  if (!segment) {
    return {
      cutPointsSeconds: [...input.cutPointsSeconds],
      selectedIndex: input.index,
    }
  }
  const duration = segment.durationSeconds
  const limits = segmentBoundLimits(input)
  const startSeconds = roundedSplitSeconds(Math.min(
    limits.maxEnd - duration,
    Math.max(limits.minStart, segment.startSeconds + input.deltaSeconds),
  ))
  const endSeconds = roundedSplitSeconds(startSeconds + duration)
  if (
    startSeconds === segment.startSeconds
    && endSeconds === segment.endSeconds
  ) {
    return {
      cutPointsSeconds: [...input.cutPointsSeconds],
      selectedIndex: input.index,
    }
  }
  return setSegmentBounds({
    ...input,
    endSeconds,
    startSeconds,
  })
}

export function splitSegmentInHalf(input: {
  cutPointsSeconds: readonly number[]
  index: number
  sourceDurationSeconds: number
}): SplitSegmentEdit {
  const segments = splitSegments(input)
  const segment = segments[input.index]
  if (
    !segment
    || segment.durationSeconds < minimumSplitPieceSeconds * 2
  ) {
    return {
      cutPointsSeconds: [...input.cutPointsSeconds],
      selectedIndex: input.index,
    }
  }
  const cut = roundedSplitSeconds(
    segment.startSeconds + segment.durationSeconds / 2,
  )
  const cutPointsSeconds = uniqueSorted([...input.cutPointsSeconds, cut])
    .filter((value) =>
      value > 0 && value < roundedSplitSeconds(input.sourceDurationSeconds))
  if (sameCuts(cutPointsSeconds, input.cutPointsSeconds)) {
    return {
      cutPointsSeconds: [...input.cutPointsSeconds],
      selectedIndex: input.index,
    }
  }
  return { cutPointsSeconds, selectedIndex: input.index }
}

export function mergeSegmentWithNext(input: {
  cutPointsSeconds: readonly number[]
  index: number
  sourceDurationSeconds: number
}): SplitSegmentEdit {
  const segments = splitSegments(input)
  const segment = segments[input.index]
  const next = segments[input.index + 1]
  if (!segment || !next) {
    return {
      cutPointsSeconds: [...input.cutPointsSeconds],
      selectedIndex: input.index,
    }
  }
  const cutPointsSeconds = cutsFromBoundaries([
    0,
    ...input.cutPointsSeconds.filter((value) => value !== segment.endSeconds),
    roundedSplitSeconds(input.sourceDurationSeconds),
  ])
  return {
    cutPointsSeconds,
    selectedIndex: input.index,
  }
}
