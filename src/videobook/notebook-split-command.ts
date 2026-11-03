import {
  compileNotebookSplitOutputs,
  formatSplitTimestamp,
  notebookSplitPieces,
  roundedSplitSeconds,
  type NotebookSplitOutputMode,
} from '../../server/src/notebook-split-plan'
import {
  cutRangesOutside,
  trimKeepRanges,
  type TrimRequest,
  type VideoRange,
} from '../../server/src/video-cut-ranges'
import { nonBlankStringValue, recordValue } from './value-decoders'

export {
  compileNotebookSplitOutputs,
  formatSplitTimestamp,
  minimumSplitPieceSeconds,
  notebookSplitCutPoints,
  notebookSplitPieces,
  notebookSplitRanges,
  notebookSplitSummary,
  roundedSplitSeconds,
  type NotebookSplitOutputMode,
  type NotebookSplitRange,
} from '../../server/src/notebook-split-plan'

export type NotebookSplitDestination = 'new' | 'in_place'

export type NotebookSplitCommand = {
  sourceReference: string
  cutPointsSeconds: number[]
  outputMode?: NotebookSplitOutputMode
  selectedChunkIndexes?: number[]
  cutSource?: 'scenes'
  trim?: TrimRequest
  destination?: NotebookSplitDestination
}

export type NotebookSplitSelection = {
  cutPointsSeconds: number[]
  outputMode: Exclude<NotebookSplitOutputMode, 'all'>
  selectedChunkIndexes: number[]
}

const NOTEBOOK_SPLIT_SCENES_PATTERN =
  /^(?:(?:at|by|into|on)\s+)?(?:the\s+)?(?:scenes?|scene\s+(?:cuts|changes)|camera\s+(?:cuts|changes)|shots?)$/iu

const NOTEBOOK_SPLIT_REFERENCE_SOURCE = '[a-z0-9][a-z0-9-]*'

const NOTEBOOK_SPLIT_COMMAND_PATTERN = new RegExp(
  `^(?:please\\s+)?(?:/split|split)\\s+@(${NOTEBOOK_SPLIT_REFERENCE_SOURCE})(?:\\s+([\\s\\S]+?))?(?:\\s+please)?[.!]?$`,
  'iu',
)

type NotebookToolCall = (
  tool: string,
  args: Record<string, unknown>,
) => Promise<unknown>

// Header title for the split confirm sheet: the piece being cut, or the
// generic label while nothing is selected.
export function splitSelectionTitle(input: {
  pieces: readonly { startSeconds: number; endSeconds: number; durationSeconds: number }[]
  selectedIndex: number
}): string {
  const selected = input.pieces[input.selectedIndex] ?? input.pieces[0]
  if (!selected) return 'Split video'
  return `Cutting ${formatSplitTimestamp(selected.startSeconds)}–${formatSplitTimestamp(selected.endSeconds)} (${selected.durationSeconds.toFixed(3)}s)`
}

export function splitFrameStepSeconds(fps: number | null | undefined): number | null {
  if (typeof fps !== 'number' || !Number.isFinite(fps) || !(fps > 0)) return null
  return 1 / fps
}

export function notebookSplitCellBudget(
  outputMode: NotebookSplitOutputMode,
  pieceCount: number,
): number {
  return outputMode === 'all' ? Math.max(1, pieceCount) : 1
}

function timestampSeconds(value: string): number | null {
  const normalized = value.trim().toLowerCase()
  const seconds = normalized.match(
    /^(\d+(?:\.\d+)?)\s*(?:s|secs?|seconds?)?$/u,
  )
  if (seconds) return Number(seconds[1])

  const minuteSeconds = normalized.match(
    /^(\d+)\s*(?:m|mins?|minutes?)\s*(?:(\d+(?:\.\d+)?)\s*(?:s|secs?|seconds?)?)?$/u,
  )
  if (minuteSeconds) {
    return Number(minuteSeconds[1]) * 60 + Number(minuteSeconds[2] ?? 0)
  }

  const clock = normalized.match(
    /^(?:(\d+):)?(\d+):([0-5]?\d(?:\.\d+)?)$/u,
  )
  if (!clock) return null
  return Number(clock[1] ?? 0) * 3600
    + Number(clock[2]) * 60
    + Number(clock[3])
}

function splitBoundaryPhrase(value: string): string {
  return value
    .trim()
    .replace(/^(?:into|at)\s+/iu, '')
    .replace(
      /\s+(?:and|plus)\s+(?:(?:keep|use)\s+)?(?:the\s+)?(?:remaining|remainder|rest)(?:\s+(?:clip|part|video))?$/iu,
      '',
    )
    .trim()
}

function splitBoundaryValues(value: string): string[] {
  const phrase = splitBoundaryPhrase(value)
  if (!phrase) return []
  return phrase
    .split(/\s*(?:,|;|\band\b|\bthen\b)\s*/iu)
    .map((part) => part.trim())
    .filter(Boolean)
}

function parseKeepRemoveRange(phrase: string): {
  endSeconds: number
  mode: Exclude<NotebookSplitOutputMode, 'all'>
  startSeconds: number
} | null {
  const match = phrase.trim().match(/^(keep|remove)\s+([\s\S]+)$/iu)
  if (!match) return null
  const range = match[2]!.trim().match(/^(.+?)\s*[-–]\s*(.+)$/u)
  if (!range) {
    throw new Error(
      'Use a keep/remove range, for example: /split @a1 keep 0.03-0.11',
    )
  }
  const startSeconds = timestampSeconds(range[1]!)
  const endSeconds = timestampSeconds(range[2]!)
  if (
    startSeconds === null
    || endSeconds === null
    || !Number.isFinite(startSeconds)
    || !Number.isFinite(endSeconds)
    || !(endSeconds > startSeconds)
    || startSeconds < 0
  ) {
    throw new Error(
      'Use positive split times, for example: /split @a1 keep 0.03-0.11',
    )
  }
  return {
    endSeconds: roundedSplitSeconds(endSeconds),
    mode: match[1]!.toLowerCase() === 'remove' ? 'remove' : 'keep',
    startSeconds: roundedSplitSeconds(startSeconds),
  }
}

export function parseNotebookSplitCommand(
  input: string,
): NotebookSplitCommand | null {
  const match = input.trim().match(NOTEBOOK_SPLIT_COMMAND_PATTERN)
  if (!match) return null
  const rest = match[2]?.trim() ?? ''
  if (NOTEBOOK_SPLIT_SCENES_PATTERN.test(rest)) {
    return {
      sourceReference: match[1]!.toLowerCase(),
      cutPointsSeconds: [],
      cutSource: 'scenes',
    }
  }
  if (rest && /^(keep|remove)\b/iu.test(rest)) {
    const parsed = parseKeepRemoveRange(rest)
    if (!parsed) return null
    const cutPointsSeconds = [parsed.startSeconds, parsed.endSeconds]
      .filter((value) => value > 0)
      .sort((left, right) => left - right)
    return {
      sourceReference: match[1]!.toLowerCase(),
      cutPointsSeconds,
      outputMode: parsed.mode,
      selectedChunkIndexes: [parsed.startSeconds > 0 ? 1 : 0],
    }
  }
  const values = rest ? splitBoundaryValues(rest) : []
  const cutPointsSeconds = values.map(timestampSeconds)
  if (cutPointsSeconds.some((value) => !Number.isFinite(value) || !(value! > 0))) {
    throw new Error(
      'Use positive split times, for example: /split @a3 at 15s, 28.5s',
    )
  }
  return {
    sourceReference: match[1]!.toLowerCase(),
    cutPointsSeconds: cutPointsSeconds
      .map((value) => roundedSplitSeconds(value!))
      .sort((left, right) => left - right),
  }
}

function pieceIndexes(pieces: readonly VideoRange[], ranges: readonly VideoRange[]): number[] {
  return ranges.flatMap((range) => pieces.flatMap((piece, index) =>
    piece.startSeconds >= range.startSeconds && piece.endSeconds <= range.endSeconds ? [index] : []))
}

export function trimSplitSelection(
  trim: TrimRequest,
  sourceDurationSeconds: number,
): NotebookSplitSelection {
  const keeps = trimKeepRanges(trim, sourceDurationSeconds)
  const cuts = cutRangesOutside(keeps, sourceDurationSeconds)
  const duration = roundedSplitSeconds(sourceDurationSeconds)
  const cutPointsSeconds = [...new Set(cuts.flatMap((cut) => [cut.startSeconds, cut.endSeconds]))]
    .filter((point) => point > 0 && point < duration)
    .sort((left, right) => left - right)
  const pieces = notebookSplitPieces({ cutPointsSeconds, sourceDurationSeconds })
  const removing = cuts.length === 1 || keeps.length > 1
  return {
    cutPointsSeconds,
    outputMode: removing ? 'remove' : 'keep',
    selectedChunkIndexes: pieceIndexes(pieces, removing ? cuts : keeps),
  }
}

function cutArgs(cuts: readonly VideoRange[]): Array<{ start: number; end: number }> {
  return cuts.map((cut) => ({ start: cut.startSeconds, end: cut.endSeconds }))
}

type NotebookSplitApplyCall = {
  tool: 'split_video' | 'trim_video'
  args: Record<string, unknown>
}

function notebookSplitApplyCalls(input: {
  bookId: string
  command: NotebookSplitCommand
  notebookId: string
  sourceDurationSeconds: number
}): NotebookSplitApplyCall[] {
  const { command } = input
  const base = {
    book_id: input.bookId,
    notebook_id: input.notebookId,
    asset_id: command.sourceReference,
  }
  const outputMode = command.outputMode ?? 'all'
  if (outputMode === 'all') {
    return [{ tool: 'split_video', args: { ...base, cut_points: command.cutPointsSeconds } }]
  }
  const groups = compileNotebookSplitOutputs({
    cutPointsSeconds: command.cutPointsSeconds,
    outputMode,
    selectedChunkIndexes: command.selectedChunkIndexes,
    sourceDurationSeconds: input.sourceDurationSeconds,
  })
  const destination = command.destination ?? 'new'
  const applied = destination === 'in_place' ? groups.slice(0, 1) : groups
  return applied.map((keeps) => ({
    tool: 'trim_video',
    args: {
      ...base,
      cuts: cutArgs(cutRangesOutside(keeps, input.sourceDurationSeconds)),
      output: destination,
    },
  }))
}

export async function applyNotebookSplitCommand(input: {
  bookId: string
  callTool: NotebookToolCall
  command: NotebookSplitCommand
  notebookId: string
  sourceDurationSeconds: number
}): Promise<unknown[]> {
  const results: unknown[] = []
  for (const call of notebookSplitApplyCalls(input)) {
    results.push(await input.callTool(call.tool, call.args))
  }
  return results
}

export type NotebookClipOutput = {
  cellId: string
  address: string
}

export type NotebookClipRun = {
  jobId: string
  runId: string
  outputs: NotebookClipOutput[]
}

function clipOutput(value: unknown): NotebookClipOutput | null {
  const record = recordValue(value)
  const cellId = nonBlankStringValue(record?.cell_id)
  const address = nonBlankStringValue(record?.address)
  return cellId && address ? { cellId, address } : null
}

export function notebookClipRun(value: unknown): NotebookClipRun | null {
  const record = recordValue(value)
  const jobId = nonBlankStringValue(record?.job_id)
  const runId = nonBlankStringValue(record?.run_id)
  if (!record || !jobId || !runId) return null
  const listed = Array.isArray(record.cells) ? record.cells : [record]
  const outputs = listed.map(clipOutput).filter((output) => output !== null)
  return outputs.length > 0 ? { jobId, runId, outputs } : null
}

function secondsValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return undefined
  return timestampSeconds(value) ?? undefined
}

function routedCuts(value: unknown): VideoRange[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const record = recordValue(entry)
    const startSeconds = secondsValue(record?.start)
    const endSeconds = secondsValue(record?.end)
    return startSeconds === undefined || endSeconds === undefined ? [] : [{ startSeconds, endSeconds }]
  })
}

function routedTrimRequest(params: Readonly<Record<string, unknown>>): TrimRequest {
  const cutStart = secondsValue(params.cut_start)
  const cutEnd = secondsValue(params.cut_end)
  const cuts = [
    ...(cutStart === undefined || cutEnd === undefined ? [] : [{ startSeconds: cutStart, endSeconds: cutEnd }]),
    ...routedCuts(params.cuts),
  ]
  return {
    keepStart: secondsValue(params.trim_start),
    keepEnd: secondsValue(params.trim_end),
    ...(cuts.length === 0 ? {} : { cuts }),
    headSeconds: secondsValue(params.head_seconds),
    tailSeconds: secondsValue(params.tail_seconds),
  }
}

function routedSplitPoints(params: Readonly<Record<string, unknown>>): number[] | null {
  const durations = Array.isArray(params.durations) ? params.durations.map(secondsValue) : null
  if (durations) {
    if (durations.some((value) => value === undefined || !(value > 0))) return null
    return durations.reduce<number[]>((points, length) =>
      [...points, roundedSplitSeconds((points.at(-1) ?? 0) + length!)], [])
  }
  const points = Array.isArray(params.cut_points) ? params.cut_points.map(secondsValue) : []
  if (points.length === 0 || points.some((value) => value === undefined || !(value > 0))) return null
  return points.map((value) => roundedSplitSeconds(value!)).sort((left, right) => left - right)
}

export function routedNotebookSplitCommand(input: {
  tool: string
  params: Readonly<Record<string, unknown>>
  sourceReference: string
}): NotebookSplitCommand | { error: string } {
  const { params, sourceReference } = input
  if (input.tool === 'trim_video') {
    return {
      sourceReference,
      cutPointsSeconds: [],
      trim: routedTrimRequest(params),
      destination: params.output === 'in_place' ? 'in_place' : 'new',
    }
  }
  if (params.scenes === true) return { sourceReference, cutPointsSeconds: [], cutSource: 'scenes' }
  const cutPointsSeconds = routedSplitPoints(params)
  return cutPointsSeconds
    ? { sourceReference, cutPointsSeconds }
    : { error: 'The chat model did not select valid split times.' }
}
