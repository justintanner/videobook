import type { NotebookCell, NotebookDocument } from 'videobook-engine'
import {
  formatSplitTimestamp,
  planNotebookSplit,
  roundedSplitSeconds,
  type NotebookSplitDraft,
  type NotebookSplitOutputMode,
} from '../../server/src/notebook-split-plan'
import { notebookCellTag } from './notebook-addressing'
import { resolveNotebookVideoSourceCell } from './notebook-video-source'
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

export type NotebookSplitCommand = {
  sourceReference: string
  cutPointsSeconds: number[]
  outputMode?: NotebookSplitOutputMode
  selectedChunkIndexes?: number[]
  cutSource?: 'scenes'
}

const NOTEBOOK_SPLIT_SCENES_PATTERN =
  /^(?:(?:at|by|into|on)\s+)?(?:the\s+)?(?:scenes?|scene\s+(?:cuts|changes)|camera\s+(?:cuts|changes)|shots?)$/iu

const NOTEBOOK_SPLIT_REFERENCE_SOURCE = '[a-z0-9][a-z0-9-]*'

const NOTEBOOK_SPLIT_COMMAND_PATTERN = new RegExp(
  `^(?:please\\s+)?(?:/split|split)\\s+@(${NOTEBOOK_SPLIT_REFERENCE_SOURCE})(?:\\s+([\\s\\S]+?))?(?:\\s+please)?[.!]?$`,
  'iu',
)

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

export function planNotebookSplitCommand(input: {
  command: NotebookSplitCommand
  document: NotebookDocument
  sourceDurationSeconds: number
}): NotebookSplitDraft {
  return planNotebookSplit({
    cutPointsSeconds: input.command.cutPointsSeconds,
    document: input.document,
    outputMode: input.command.outputMode,
    selectedChunkIndexes: input.command.selectedChunkIndexes,
    source: resolveNotebookVideoSourceCell(input.document, input.command.sourceReference),
    sourceDurationSeconds: input.sourceDurationSeconds,
  })
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
