import type { NotebookCell, NotebookDocument } from 'videobook-engine'
import { notebookCellTag } from './notebook-addressing'
import { notebookCellIsActiveStatus } from './notebook-cell-presentation'
import { resolveNotebookVideoSourceCell } from './notebook-video-source'
import { nonBlankStringValue, recordValue } from './value-decoders'

export type NotebookAudioCommand = {
  sourceReference: string
}

type NotebookAudioCommandRun = {
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

function matchingAction(
  document: NotebookDocument,
  sourceCellId: string,
): NotebookCell | null {
  const actionIds = new Set(document.edges
    .filter((edge) =>
      edge.source === sourceCellId
      && (edge.targetInput === 'video' || edge.targetInput === 'segment'))
    .map((edge) => edge.target))
  return document.cells.find((cell) =>
    actionIds.has(cell.id)
    && (
      cell.type === 'extract_audio'
      || cell.inputs?.mediaRole === 'extract-audio-output'
    )) ?? null
}

/**
 * The run id of an extraction the server is still working on for this cell,
 * or null once the cell has settled (completed, failed, or never run).
 */
function inFlightRunId(
  document: NotebookDocument,
  cellId: string,
): string | null {
  const execution = recordValue(document.execution)
  const state = execution ? recordValue(execution[cellId]) : null
  const status = nonBlankStringValue(state?.status)
  const runId = nonBlankStringValue(state?.runId)
  return status && runId && notebookCellIsActiveStatus(status) ? runId : null
}

function acceptedRun(
  value: unknown,
): { jobId: string; runId: string } {
  const accepted = recordValue(value)
  const jobId = nonBlankStringValue(accepted?.job_id)
  const runId = nonBlankStringValue(accepted?.run_id)
  if (!jobId || !runId) {
    throw new Error('The server did not return an Extract Audio run')
  }
  return { jobId, runId }
}

export async function enqueueNotebookAudioCommand(input: {
  actor: string
  bookId: string
  callTool: NotebookToolCall
  command: NotebookAudioCommand
  document: NotebookDocument
  expectedRevision?: string
}): Promise<NotebookAudioCommandRun> {
  const source = resolveNotebookVideoSourceCell(
    input.document,
    input.command.sourceReference,
  )
  const sourceCellId = source.id
  const sourceAddress = notebookCellTag(source)
  const revision = input.expectedRevision
    ? { expected_revision: input.expectedRevision }
    : {}
  const existing = matchingAction(input.document, source.id)

  if (existing) {
    // The source already has an audio cell. Never hand the caller a fake run
    // to watch: either attach to the extraction still in flight, or ask the
    // server to re-run the cell so the watch tracks a real run id.
    const reused = {
      actionCellId: existing.id,
      actionAddress: notebookCellTag(existing),
      outputCellId: existing.id,
      reusedAction: true,
      sourceCellId,
      sourceAddress,
    }
    const activeRunId = inFlightRunId(input.document, existing.id)
    if (activeRunId) {
      return { ...reused, jobId: '', runId: activeRunId }
    }
    const rerun = acceptedRun(await input.callTool('run_notebook_cell', {
      book_id: input.bookId,
      notebook_id: input.document.id,
      cell_id: existing.id,
      actor: input.actor,
      ...revision,
    }))
    return { ...reused, ...rerun }
  }

  const accepted = recordValue(await input.callTool('extract_notebook_audio', {
    book_id: input.bookId,
    notebook_id: input.document.id,
    source_cell_id: source.id,
    label: 'Extract audio',
    ...revision,
  }))
  const actionCellId = nonBlankStringValue(accepted?.cell_id)
  const actionAddress = nonBlankStringValue(accepted?.address)
  if (!actionCellId || !actionAddress) {
    throw new Error('The server did not return an Extract Audio run')
  }
  return {
    actionCellId,
    actionAddress,
    outputCellId: actionCellId,
    ...acceptedRun(accepted),
    reusedAction: false,
    sourceCellId,
    sourceAddress,
  }
}
