import { v7 as uuidv7 } from 'uuid'
import { firstEmptyNotebookGridSlots } from 'videobook-engine/notebook-grid'
import type {
  NotebookCell,
  NotebookDocument,
  NotebookGridSlot,
} from 'videobook-engine'
import {
  notebookCellTag,
  resolveNotebookCellReference,
} from './notebook-addressing'

export type NotebookSplitCommand = {
  sourceReference: string
  splitAtSeconds: number
}

// Accepts a grid address (@a3) or a cell id / id prefix; the resolver
// validates whichever form arrives.
const NOTEBOOK_SPLIT_REFERENCE_SOURCE = '[a-z0-9][a-z0-9-]*'

const NOTEBOOK_SPLIT_COMMAND_PATTERN = new RegExp(
  `^(?:please\\s+)?(?:/split|split)\\s+@(${NOTEBOOK_SPLIT_REFERENCE_SOURCE})(?:\\s+([\\s\\S]+?))?(?:\\s+please)?[.!]?$`,
  'iu',
)

export type NotebookSplitOutputRole = 'first' | 'remaining'

export type NotebookSplitOutputDraft = {
  outputCell: NotebookCell
  role: NotebookSplitOutputRole
}

export type NotebookSplitDraft = {
  actionCell: NotebookCell
  createdCellIds: string[]
  document: NotebookDocument
  outputs: [NotebookSplitOutputDraft, NotebookSplitOutputDraft]
  sourceCellId: string
  sourceAddress: string
  splitAtSeconds: number
}

export type NotebookSplitRun = {
  actionCellId: string
  actionAddress: string
  outputs: Array<{
    outputCellId: string
    outputAddress: string
    role: NotebookSplitOutputRole
  }>
  jobId: string
  runId: string
  sourceCellId: string
  sourceAddress: string
  splitAtSeconds: number
}

type NotebookToolCall = (
  tool: string,
  args: Record<string, unknown>,
) => Promise<unknown>

const minimumSplitChunkSeconds = 0.5
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

function splitTimeLabel(seconds: number): string {
  return `${seconds}s`
}

function splitSlots(
  cells: readonly NotebookCell[],
): {
  action: NotebookGridSlot
  outputs: [NotebookGridSlot, NotebookGridSlot]
} {
  const [action, first, remaining] = firstEmptyNotebookGridSlots(
    cells.map((cell) => cell.slot),
    3,
  )
  return {
    action: action!,
    outputs: [first!, remaining!],
  }
}

function createOutput(input: {
  actionCell: NotebookCell
  endSeconds: number
  role: NotebookSplitOutputRole
  slot: NotebookGridSlot
  source: NotebookCell
  startSeconds: number
  timeLabel: string
}): NotebookSplitOutputDraft {
  const outputCell: NotebookCell = {
    id: uuidv7(),
    type: 'video',
    label: input.role === 'first'
      ? `First ${input.timeLabel}`
      : 'Remaining',
    slot: input.slot,
    inputs: {
      endSeconds: input.endSeconds,
      mediaRole: 'split-video-output',
      producerCellId: input.actionCell.id,
      sourceCellId: input.source.id,
      splitRole: input.role,
      startSeconds: input.startSeconds,
      state: 'pending',
    },
  }
  return { outputCell, role: input.role }
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
  const splitAtSeconds = match[2]
    ? timestampSeconds(splitBoundaryPhrase(match[2]))
    : null
  if (!Number.isFinite(splitAtSeconds) || !(splitAtSeconds! > 0)) {
    throw new Error(
      'Name a positive split time, for example: split @a3 into 15s and the remaining',
    )
  }
  return {
    sourceReference: match[1]!.toLowerCase(),
    splitAtSeconds: splitAtSeconds!,
  }
}

export function resolveNotebookSplitSource(
  document: NotebookDocument,
  sourceReference: string,
): NotebookCell {
  const source = resolveNotebookCellReference(document, sourceReference)
  if (!videoSourceTypes.has(source.type)) {
    throw new Error(`${notebookCellTag(source)} is not a video-producing cell`)
  }
  if (!source.outputArtifactId) {
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
  const firstDuration = input.command.splitAtSeconds
  const remainingDuration = input.sourceDurationSeconds - firstDuration
  if (
    firstDuration < minimumSplitChunkSeconds
    || remainingDuration < minimumSplitChunkSeconds
  ) {
    throw new Error(
      `Split ${notebookCellTag(source)} between ${minimumSplitChunkSeconds}s and ${(input.sourceDurationSeconds - minimumSplitChunkSeconds).toFixed(2)}s so both clips contain usable video`,
    )
  }

  const slots = splitSlots(input.document.cells)
  const timeLabel = splitTimeLabel(firstDuration)
  const actionCell: NotebookCell = {
    id: uuidv7(),
    type: 'split_video',
    label: `Split at ${timeLabel}`,
    slot: slots.action,
    provider: 'local',
    operation: 'split_range',
    tool: 'ffmpeg',
    inputs: {
      endSeconds: input.sourceDurationSeconds,
      sourceCellId: source.id,
      sourceDurationSeconds: input.sourceDurationSeconds,
      splitAtSeconds: firstDuration,
      startSeconds: 0,
      state: 'ready',
    },
  }
  const first = createOutput({
    actionCell,
    endSeconds: firstDuration,
    role: 'first',
    slot: slots.outputs[0],
    source,
    startSeconds: 0,
    timeLabel,
  })
  const remaining = createOutput({
    actionCell,
    endSeconds: input.sourceDurationSeconds,
    role: 'remaining',
    slot: slots.outputs[1],
    source,
    startSeconds: firstDuration,
    timeLabel,
  })
  const outputs: NotebookSplitDraft['outputs'] = [first, remaining]
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
    document: {
      ...input.document,
      cells: [...input.document.cells, ...createdCells],
      edges: [...input.document.edges, ...createdEdges],
    },
    outputs,
    sourceCellId: source.id,
    sourceAddress: notebookCellTag(source),
    splitAtSeconds: firstDuration,
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
        outputCellId: output.outputCell.id,
        outputAddress: notebookCellTag(output.outputCell),
        role: output.role,
      })),
      jobId,
      runId,
      sourceCellId: input.draft.sourceCellId,
      sourceAddress: input.draft.sourceAddress,
      splitAtSeconds: input.draft.splitAtSeconds,
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
