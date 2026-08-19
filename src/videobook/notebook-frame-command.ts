import type { NotebookDocument } from 'videobook-engine'
import { notebookCellTag } from './notebook-addressing'
import { resolveNotebookVideoSourceCell } from './notebook-video-source'
import { nonBlankStringValue, recordValue } from './value-decoders'

type NotebookFrameMode = 'first' | 'last' | 'time'

export type NotebookFrameCommand = {
  frameMode: NotebookFrameMode
  sourceReference: string
  timestampSeconds?: number
}

type NotebookFrameCommandRun = {
  actionCellId: string
  actionAddress: string
  outputCellId: string | null
  jobId: string
  runId: string
  reusedAction: boolean
  sourceCellId: string
  sourceAddress: string
}

type NotebookToolCall = (
  tool: string,
  args: Record<string, unknown>,
) => Promise<unknown>

const NOTEBOOK_FRAME_REFERENCE_SOURCE = '[a-z0-9][a-z0-9-]*'

const NOTEBOOK_FRAME_COMMAND_PATTERN = new RegExp(
  `^(?:please\\s+)?(?:extracte?|capture|grab|get)\\s+(?:the\\s+)?(first|last)\\s+frame\\s+(?:of|from)\\s+@(${NOTEBOOK_FRAME_REFERENCE_SOURCE})(?:\\s+please)?[.!]?$`,
  'iu',
)

function normalizedTimestamp(value: unknown): number | null {
  const timestamp = Number(value)
  return Number.isFinite(timestamp) && timestamp >= 0
    ? Math.round(timestamp * 1_000) / 1_000
    : null
}

export function parseNotebookFrameCommand(
  input: string,
): NotebookFrameCommand | null {
  const match = input.trim().match(NOTEBOOK_FRAME_COMMAND_PATTERN)
  if (!match) return null
  return {
    frameMode: match[1]!.toLowerCase() as 'first' | 'last',
    sourceReference: match[2]!.toLowerCase(),
  }
}

export async function enqueueNotebookFrameCommand(input: {
  actor: string
  bookId: string
  callTool: NotebookToolCall
  command: NotebookFrameCommand
  document: NotebookDocument
  expectedRevision?: string
}): Promise<NotebookFrameCommandRun> {
  const timestampSeconds = input.command.frameMode === 'time'
    ? normalizedTimestamp(input.command.timestampSeconds)
    : null
  if (input.command.frameMode === 'time' && timestampSeconds === null) {
    throw new Error('A valid timestamp is required for time-mode frame extraction')
  }
  const source = resolveNotebookVideoSourceCell(
    input.document,
    input.command.sourceReference,
  )
  const accepted = recordValue(await input.callTool('extract_notebook_frame', {
    book_id: input.bookId,
    notebook_id: input.document.id,
    source_cell_id: source.id,
    frame_mode: input.command.frameMode,
    ...(timestampSeconds === null
      ? {}
      : { timestamp_seconds: timestampSeconds }),
    ...(input.expectedRevision
      ? { expected_revision: input.expectedRevision }
      : {}),
  }))
  const cellId = nonBlankStringValue(accepted?.cell_id)
  const address = nonBlankStringValue(accepted?.address)
  const jobId = nonBlankStringValue(accepted?.job_id)
  const runId = nonBlankStringValue(accepted?.run_id)
  if (!cellId || !address || !jobId || !runId) {
    throw new Error('The server did not return the frame extraction cell')
  }
  return {
    actionCellId: cellId,
    actionAddress: address,
    outputCellId: cellId,
    jobId,
    runId,
    reusedAction: false,
    sourceCellId: source.id,
    sourceAddress: notebookCellTag(source),
  }
}
