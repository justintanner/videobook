import { notebookOccupiedSlots } from 'videobook-engine/notebook-grid'
import { v7 as uuidv7 } from 'uuid'
import { nextVerticalSlotFrom } from 'videobook-engine/notebook-grid'
import type {
  NotebookCell,
  NotebookDocument,
  NotebookGridSlot,
} from 'videobook-engine'
import { notebookCellTag } from './notebook-addressing'
import { resolveNotebookVideoSourceCell } from './notebook-video-source'
import { nonBlankStringValue, recordValue } from './value-decoders'

export type NotebookSplitOutputMode = 'all' | 'keep' | 'remove'

export type NotebookSplitRange = {
  endSeconds: number
  startSeconds: number
}

type NotebookSplitOutputGroup = NotebookSplitRange[]

export type NotebookSplitCommand = {
  sourceReference: string
  cutPointsSeconds: number[]
  outputMode?: NotebookSplitOutputMode
  selectedChunkIndexes?: number[]
}

const NOTEBOOK_SPLIT_REFERENCE_SOURCE = '[a-z0-9][a-z0-9-]*'

const NOTEBOOK_SPLIT_COMMAND_PATTERN = new RegExp(
  `^(?:please\\s+)?(?:/split|split)\\s+@(${NOTEBOOK_SPLIT_REFERENCE_SOURCE})(?:\\s+([\\s\\S]+?))?(?:\\s+please)?[.!]?$`,
  'iu',
)

type NotebookSplitOutputDraft = {
  chunkIndex: number
  endSeconds: number
  outputCell: NotebookCell
  startSeconds: number
}

type NotebookSplitDraft = {
  actionCell: NotebookCell
  createdCellIds: string[]
  cutPointsSeconds: number[]
  document: NotebookDocument
  outputs: NotebookSplitOutputDraft[]
  sourceCellId: string
  sourceAddress: string
}

export type NotebookSplitRun = {
  actionCellId: string
  actionAddress: string
  outputs: Array<{
    chunkIndex: number
    outputCellId: string
    outputAddress: string
  }>
  cutPointsSeconds: number[]
  jobId: string
  runId: string
  sourceCellId: string
  sourceAddress: string
}

type NotebookToolCall = (
  tool: string,
  args: Record<string, unknown>,
) => Promise<unknown>

export const minimumSplitPieceSeconds = 0.02

export function roundedSplitSeconds(value: number): number {
  return Math.round(value * 1000) / 1000
}

export function formatSplitTimestamp(value: number): string {
  const totalMilliseconds = Math.max(0, Math.round(value * 1000))
  const minutes = Math.floor(totalMilliseconds / 60_000)
  const seconds = (totalMilliseconds - minutes * 60_000) / 1000
  return `${minutes}:${seconds.toFixed(3).padStart(6, '0')}`
}

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
  const outputs = outputMode === 'all' ? Math.max(1, pieceCount) : 1
  return outputs + 1
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

function splitSlots(
  cells: readonly NotebookCell[],
  outputCount: number,
  sourceSlot: NotebookGridSlot,
): { action: NotebookGridSlot; outputs: NotebookGridSlot[] } {
  const occupied = notebookOccupiedSlots(cells)
  const action = nextVerticalSlotFrom(sourceSlot, occupied)
  const outputs: NotebookGridSlot[] = []
  let cursor = action
  for (let index = 0; index < outputCount; index += 1) {
    const slot = nextVerticalSlotFrom(cursor, [...occupied, action, ...outputs])
    outputs.push(slot)
    cursor = slot
  }
  return { action, outputs }
}

function createOutput(input: {
  actionCell: NotebookCell
  chunkCount: number
  chunkIndex: number
  endSeconds: number
  slot: NotebookGridSlot
  source: NotebookCell
  startSeconds: number
}): NotebookSplitOutputDraft {
  const outputCell: NotebookCell = {
    id: uuidv7(),
    type: 'video',
    label: `Chunk ${String(input.chunkIndex + 1).padStart(2, '0')}`,
    slot: input.slot,
    inputs: {
      chunkCount: input.chunkCount,
      chunkIndex: input.chunkIndex,
      endSeconds: input.endSeconds,
      mediaRole: 'split-video-output',
      producerCellId: input.actionCell.id,
      sourceCellId: input.source.id,
      startSeconds: input.startSeconds,
      state: 'pending',
    },
  }
  return {
    chunkIndex: input.chunkIndex,
    endSeconds: input.endSeconds,
    outputCell,
    startSeconds: input.startSeconds,
  }
}

function cellCreateInput(cell: NotebookCell): Record<string, unknown> {
  return {
    id: cell.id,
    type: cell.type,
    ...(cell.label === undefined ? {} : { label: cell.label }),
    slot: cell.slot,
    ...(cell.provider === undefined ? {} : { provider: cell.provider }),
    ...(cell.operation === undefined ? {} : { operation: cell.operation }),
    ...(cell.tool === undefined ? {} : { tool: cell.tool }),
    ...(cell.inputs === undefined ? {} : { inputs: cell.inputs }),
  }
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

function assertSplitOutputRanges(
  ranges: readonly NotebookSplitRange[],
): void {
  for (const range of ranges) {
    const duration = roundedSplitSeconds(range.endSeconds - range.startSeconds)
    if (!(duration >= minimumSplitPieceSeconds)) {
      throw new Error(
        `Keep at least ${minimumSplitPieceSeconds}s in every output range`,
      )
    }
  }
}

export function notebookSplitPieces(input: {
  cutPointsSeconds: readonly number[]
  sourceDurationSeconds: number
}): NotebookSplitRange[] {
  const duration = roundedSplitSeconds(input.sourceDurationSeconds)
  if (!Number.isFinite(duration) || duration < minimumSplitPieceSeconds) {
    throw new Error(
      `Video must be at least ${minimumSplitPieceSeconds}s long to split`,
    )
  }
  const requested = input.cutPointsSeconds.length > 0
    ? input.cutPointsSeconds
    : [duration / 2]
  const cutPoints = requested
    .map((value) => roundedSplitSeconds(value))
    .sort((left, right) => left - right)
  if (cutPoints.some((value) => !Number.isFinite(value))) {
    throw new Error('Split times must be finite numbers')
  }
  const boundaries = [0, ...cutPoints, duration]
  const pieces = boundaries.slice(0, -1).map((startSeconds, index) => ({
    endSeconds: boundaries[index + 1]!,
    startSeconds,
  }))
  for (const piece of pieces) {
    if (!(piece.endSeconds > piece.startSeconds)) {
      throw new Error(
        `Keep at least ${minimumSplitPieceSeconds}s in every output range`,
      )
    }
  }
  return pieces
}

export function notebookSplitCutPoints(input: {
  cutPointsSeconds: readonly number[]
  sourceDurationSeconds: number
}): number[] {
  const pieces = notebookSplitPieces(input)
  assertSplitOutputRanges(pieces)
  return pieces.slice(0, -1).map((piece) => piece.endSeconds)
}

export function notebookSplitRanges(input: {
  cutPointsSeconds: readonly number[]
  sourceDurationSeconds: number
}): NotebookSplitRange[] {
  const pieces = notebookSplitPieces(input)
  assertSplitOutputRanges(pieces)
  return pieces
}

export function compileNotebookSplitOutputs(input: {
  cutPointsSeconds: readonly number[]
  outputMode?: NotebookSplitOutputMode
  selectedChunkIndexes?: readonly number[]
  sourceDurationSeconds: number
}): NotebookSplitOutputGroup[] {
  const pieces = notebookSplitPieces({
    cutPointsSeconds: input.cutPointsSeconds,
    sourceDurationSeconds: input.sourceDurationSeconds,
  })
  const mode = input.outputMode ?? 'all'
  if (mode === 'all') {
    assertSplitOutputRanges(pieces)
    return pieces.map((piece) => [piece])
  }
  const selected = new Set(
    (input.selectedChunkIndexes ?? [0]).filter((index) =>
      Number.isSafeInteger(index)
      && index >= 0
      && index < pieces.length),
  )
  if (selected.size === 0) selected.add(0)
  if (mode === 'keep') {
    const kept = pieces.filter((_, index) => selected.has(index))
    if (kept.length === 0) {
      throw new Error('Keep at least one split piece')
    }
    assertSplitOutputRanges(kept)
    return kept.map((piece) => [piece])
  }
  const remaining = pieces.filter((_, index) => !selected.has(index))
  if (remaining.length === 0) {
    throw new Error('Remove leaves nothing to keep')
  }
  const total = remaining.reduce(
    (sum, piece) => sum + (piece.endSeconds - piece.startSeconds),
    0,
  )
  assertSplitOutputRanges([{
    startSeconds: remaining[0]!.startSeconds,
    endSeconds: remaining[0]!.startSeconds + total,
  }])
  return [remaining]
}

export function notebookSplitSummary(input: {
  cutPointsSeconds: readonly number[]
  outputMode?: NotebookSplitOutputMode
  selectedChunkIndexes?: readonly number[]
  sourceAddress: string
  sourceDurationSeconds: number
}): string {
  const mode = input.outputMode ?? 'all'
  const pieces = notebookSplitPieces({
    cutPointsSeconds: input.cutPointsSeconds,
    sourceDurationSeconds: input.sourceDurationSeconds,
  })
  if (mode === 'all') {
    return `Split ${input.sourceAddress} into ${pieces.length} chunks`
  }
  const selectedIndex = input.selectedChunkIndexes?.[0] ?? 0
  const piece = pieces[selectedIndex] ?? pieces[0]!
  const range = `${formatSplitTimestamp(piece.startSeconds)}-${formatSplitTimestamp(piece.endSeconds)}`
  return mode === 'keep'
    ? `Cut ${range} out of ${input.sourceAddress}`
    : `Remove ${range} from ${input.sourceAddress}`
}

function outputLabel(
  mode: NotebookSplitOutputMode,
  group: NotebookSplitOutputGroup,
  chunkIndex: number,
): string {
  if (mode === 'all') {
    return `Chunk ${String(chunkIndex + 1).padStart(2, '0')}`
  }
  if (mode === 'keep') {
    const range = group[0]!
    return `Cut ${formatSplitTimestamp(range.startSeconds)}-${formatSplitTimestamp(range.endSeconds)}`
  }
  const first = group[0]!
  const last = group[group.length - 1]!
  const removedStart = first.endSeconds
  const removedEnd = last.startSeconds
  if (group.length >= 2 && removedEnd > removedStart) {
    return `Without ${formatSplitTimestamp(removedStart)}-${formatSplitTimestamp(removedEnd)}`
  }
  return `Without ${formatSplitTimestamp(first.startSeconds)}-${formatSplitTimestamp(last.endSeconds)}`
}

export function planNotebookSplitCommand(input: {
  command: NotebookSplitCommand
  document: NotebookDocument
  sourceDurationSeconds: number
}): NotebookSplitDraft {
  const source = resolveNotebookVideoSourceCell(
    input.document,
    input.command.sourceReference,
  )
  if (
    !Number.isFinite(input.sourceDurationSeconds)
    || input.sourceDurationSeconds <= 0
  ) {
    throw new Error(
      `${notebookCellTag(source)} does not have a usable duration yet; wait for video processing to finish`,
    )
  }
  const outputMode = input.command.outputMode ?? 'all'
  const selectedChunkIndexes = input.command.selectedChunkIndexes ?? []
  const groups = compileNotebookSplitOutputs({
    cutPointsSeconds: input.command.cutPointsSeconds,
    outputMode,
    selectedChunkIndexes,
    sourceDurationSeconds: input.sourceDurationSeconds,
  })
  const cutPointsSeconds = notebookSplitPieces({
    cutPointsSeconds: input.command.cutPointsSeconds,
    sourceDurationSeconds: input.sourceDurationSeconds,
  }).slice(0, -1).map((piece) => piece.endSeconds)
  const slots = splitSlots(input.document.cells, groups.length, source.slot)
  const outputsSeconds = groups.map((group) => group.map((range) => ({
    endSeconds: range.endSeconds,
    startSeconds: range.startSeconds,
  })))
  const actionCell: NotebookCell = {
    id: uuidv7(),
    type: 'split_video',
    label: outputMode === 'all'
      ? `Split into ${groups.length} chunks`
      : notebookSplitSummary({
          cutPointsSeconds,
          outputMode,
          selectedChunkIndexes: selectedChunkIndexes.length > 0
            ? selectedChunkIndexes
            : [0],
          sourceAddress: notebookCellTag(source),
          sourceDurationSeconds: input.sourceDurationSeconds,
        }),
    slot: slots.action,
    provider: 'local',
    operation: outputMode === 'all' ? 'split_at_points' : 'split_ranges',
    tool: 'ffmpeg',
    inputs: {
      cutPointsSeconds,
      endSeconds: input.sourceDurationSeconds,
      sourceCellId: source.id,
      sourceDurationSeconds: input.sourceDurationSeconds,
      startSeconds: 0,
      state: 'ready',
      ...(outputMode === 'all'
        ? {}
        : { outputsSeconds, selectedChunkIndexes }),
    },
  }
  const outputs = groups.map((group, chunkIndex) => {
    const startSeconds = group[0]!.startSeconds
    const endSeconds = group.reduce(
      (end, range) => end + (range.endSeconds - range.startSeconds),
      startSeconds,
    )
    const output = createOutput({
      actionCell,
      chunkCount: groups.length,
      chunkIndex,
      endSeconds: group.length === 1 ? group[0]!.endSeconds : endSeconds,
      slot: slots.outputs[chunkIndex]!,
      source,
      startSeconds,
    })
    output.outputCell = {
      ...output.outputCell,
      label: outputLabel(outputMode, group, chunkIndex),
    }
    return output
  })
  const createdCells = [actionCell, ...outputs.map((output) => output.outputCell)]
  const createdEdges = [
    {
      id: uuidv7(),
      source: source.id,
      target: actionCell.id,
      targetInput: 'video',
    },
    ...outputs.map((output) => ({
      id: uuidv7(),
      source: actionCell.id,
      target: output.outputCell.id,
      targetInput: 'media',
    })),
  ]
  return {
    actionCell,
    createdCellIds: createdCells.map((cell) => cell.id),
    cutPointsSeconds,
    document: {
      ...input.document,
      cells: [...input.document.cells, ...createdCells],
      edges: [...input.document.edges, ...createdEdges],
    },
    outputs,
    sourceCellId: source.id,
    sourceAddress: notebookCellTag(source),
  }
}

export async function enqueueNotebookSplitCommand(input: {
  actor: string
  bookId: string
  callTool: NotebookToolCall
  draft: NotebookSplitDraft
  expectedRevision?: string
}): Promise<NotebookSplitRun> {
  const createdCellIds: string[] = []
  let runRequested = false
  try {
    const cells = [
      input.draft.actionCell,
      ...input.draft.outputs.map((output) => output.outputCell),
    ]
    for (const [index, cell] of cells.entries()) {
      createdCellIds.push(cell.id)
      const createdValue = await input.callTool('create_notebook_cell', {
        book_id: input.bookId,
        notebook_id: input.draft.document.id,
        ...(index === 0 && input.expectedRevision
          ? { expected_revision: input.expectedRevision }
          : {}),
        cell: cellCreateInput(cell),
      })
      const created = recordValue(createdValue)
      const createdId = nonBlankStringValue(created?.id)
      if (createdId !== cell.id) {
        throw new Error('The server did not preserve the planned split cell')
      }
    }

    await input.callTool('connect_notebook_cells', {
      book_id: input.bookId,
      notebook_id: input.draft.document.id,
      source_cell_id: input.draft.sourceCellId,
      target_cell_id: input.draft.actionCell.id,
      target_input: 'video',
    })
    for (const output of input.draft.outputs) {
      await input.callTool('connect_notebook_cells', {
        book_id: input.bookId,
        notebook_id: input.draft.document.id,
        source_cell_id: input.draft.actionCell.id,
        target_cell_id: output.outputCell.id,
        target_input: 'media',
      })
    }

    runRequested = true
    const acceptedValue = await input.callTool('run_notebook', {
      actor: input.actor,
      book_id: input.bookId,
      notebook_id: input.draft.document.id,
      cell_ids: [input.draft.actionCell.id],
    })
    const accepted = recordValue(acceptedValue)
    const jobId = nonBlankStringValue(accepted?.job_id)
    const runId = nonBlankStringValue(accepted?.run_id)
    if (!jobId || !runId) {
      throw new Error('The server did not return a notebook split run')
    }
    return {
      actionCellId: input.draft.actionCell.id,
      actionAddress: notebookCellTag(input.draft.actionCell),
      outputs: input.draft.outputs.map((output) => ({
        chunkIndex: output.chunkIndex,
        outputCellId: output.outputCell.id,
        outputAddress: notebookCellTag(output.outputCell),
      })),
      cutPointsSeconds: input.draft.cutPointsSeconds,
      jobId,
      runId,
      sourceCellId: input.draft.sourceCellId,
      sourceAddress: input.draft.sourceAddress,
    }
  } catch (error) {
    if (!runRequested) {
      for (const cellId of createdCellIds.reverse()) {
        await input.callTool('delete_notebook_cell', {
          book_id: input.bookId,
          notebook_id: input.draft.document.id,
          cell_id: cellId,
        }).catch(() => undefined)
      }
    }
    throw error
  }
}
