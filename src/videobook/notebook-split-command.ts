import { v7 as uuidv7 } from 'uuid'
import { nextVerticalSlotFrom } from 'videobook-engine/notebook-grid'
import type {
  NotebookCell,
  NotebookDocument,
  NotebookGridSlot,
} from 'videobook-engine'
import { resolveGeneratedVideoArtifact } from 'videobook-engine/notebook-media-artifact'
import {
  notebookCellTag,
  resolveNotebookCellReference,
} from './notebook-addressing'

export type NotebookSplitCommand = {
  sourceReference: string
  cutPointsSeconds: number[]
}

// Accepts a grid address (@a3) or a cell id / id prefix; the resolver
// validates whichever form arrives.
const NOTEBOOK_SPLIT_REFERENCE_SOURCE = '[a-z0-9][a-z0-9-]*'

const NOTEBOOK_SPLIT_COMMAND_PATTERN = new RegExp(
  `^(?:please\\s+)?(?:/split|split)\\s+@(${NOTEBOOK_SPLIT_REFERENCE_SOURCE})(?:\\s+([\\s\\S]+?))?(?:\\s+please)?[.!]?$`,
  'iu',
)

export type NotebookSplitOutputDraft = {
  chunkIndex: number
  endSeconds: number
  outputCell: NotebookCell
  startSeconds: number
}

export type NotebookSplitDraft = {
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

export const minimumSplitChunkSeconds = 0.5
const videoSourceTypes = new Set<NotebookCell['type']>([
  'video',
  'generate_video',
  'concat',
  'splice',
])

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
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
  const occupied = cells.map((cell) => cell.slot)
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

export function parseNotebookSplitCommand(
  input: string,
): NotebookSplitCommand | null {
  const match = input.trim().match(NOTEBOOK_SPLIT_COMMAND_PATTERN)
  if (!match) return null
  const values = match[2] ? splitBoundaryValues(match[2]) : []
  const cutPointsSeconds = values.map(timestampSeconds)
  if (cutPointsSeconds.some((value) => !Number.isFinite(value) || !(value! > 0))) {
    throw new Error(
      'Use positive split times, for example: /split @a3 at 15s, 28.5s',
    )
  }
  return {
    sourceReference: match[1]!.toLowerCase(),
    cutPointsSeconds: cutPointsSeconds
      .map((value) => Math.round(value! * 1000) / 1000)
      .sort((left, right) => left - right),
  }
}

export type NotebookSplitRange = {
  endSeconds: number
  startSeconds: number
}

export function notebookSplitCutPoints(input: {
  cutPointsSeconds: readonly number[]
  sourceDurationSeconds: number
}): number[] {
  const duration = Math.round(input.sourceDurationSeconds * 1000) / 1000
  if (!Number.isFinite(duration) || duration < minimumSplitChunkSeconds * 2) {
    throw new Error(
      `Video must be at least ${minimumSplitChunkSeconds * 2}s long to split`,
    )
  }
  const requested = input.cutPointsSeconds.length > 0
    ? input.cutPointsSeconds
    : [duration / 2]
  const cutPoints = requested
    .map((value) => Math.round(value * 1000) / 1000)
    .sort((left, right) => left - right)
  if (cutPoints.some((value) => !Number.isFinite(value))) {
    throw new Error('Split times must be finite numbers')
  }
  const boundaries = [0, ...cutPoints, duration]
  for (let index = 1; index < boundaries.length; index += 1) {
    if (boundaries[index]! - boundaries[index - 1]! < minimumSplitChunkSeconds) {
      throw new Error(
        `Keep at least ${minimumSplitChunkSeconds}s between every split and the video ends`,
      )
    }
  }
  return cutPoints
}

export function notebookSplitRanges(input: {
  cutPointsSeconds: readonly number[]
  sourceDurationSeconds: number
}): NotebookSplitRange[] {
  const cutPoints = notebookSplitCutPoints(input)
  const boundaries = [0, ...cutPoints, input.sourceDurationSeconds]
  return boundaries.slice(0, -1).map((startSeconds, index) => ({
    endSeconds: boundaries[index + 1]!,
    startSeconds,
  }))
}

export function resolveNotebookSplitSource(
  document: NotebookDocument,
  sourceReference: string,
): NotebookCell {
  const source = resolveNotebookCellReference(document, sourceReference)
  if (!videoSourceTypes.has(source.type)) {
    throw new Error(`${notebookCellTag(source)} is not a video-producing cell`)
  }
  if (!resolveGeneratedVideoArtifact(document, source)) {
    throw new Error(`${notebookCellTag(source)} does not have a video output yet`)
  }
  return source
}

export function planNotebookSplitCommand(input: {
  command: NotebookSplitCommand
  document: NotebookDocument
  sourceDurationSeconds: number
}): NotebookSplitDraft {
  const source = resolveNotebookSplitSource(
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
  const cutPointsSeconds = notebookSplitCutPoints({
    cutPointsSeconds: input.command.cutPointsSeconds,
    sourceDurationSeconds: input.sourceDurationSeconds,
  })
  const ranges = notebookSplitRanges({
    cutPointsSeconds,
    sourceDurationSeconds: input.sourceDurationSeconds,
  })
  const slots = splitSlots(input.document.cells, ranges.length, source.slot)
  const actionCell: NotebookCell = {
    id: uuidv7(),
    type: 'split_video',
    label: `Split into ${ranges.length} chunks`,
    slot: slots.action,
    provider: 'local',
    operation: 'split_at_points',
    tool: 'ffmpeg',
    inputs: {
      cutPointsSeconds,
      endSeconds: input.sourceDurationSeconds,
      sourceCellId: source.id,
      sourceDurationSeconds: input.sourceDurationSeconds,
      startSeconds: 0,
      state: 'ready',
    },
  }
  const outputs = ranges.map((range, chunkIndex) => createOutput({
    actionCell,
    chunkCount: ranges.length,
    chunkIndex,
    endSeconds: range.endSeconds,
    slot: slots.outputs[chunkIndex]!,
    source,
    startSeconds: range.startSeconds,
  }))
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
      const created = objectValue(createdValue)
      const createdId = stringValue(created?.id)
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
    const accepted = objectValue(acceptedValue)
    const jobId = stringValue(accepted?.job_id)
    const runId = stringValue(accepted?.run_id)
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
