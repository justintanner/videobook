import type { NotebookCell, NotebookDocument } from 'videobook-engine'
import { notebookCellTag } from './notebook-addressing'
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
  const existing = matchingAction(input.document, source.id)
  let actionCellId = existing?.id ?? null
  let actionAddress = existing ? notebookCellTag(existing) : null

  if (existing && actionCellId && actionAddress) {
    return {
      actionCellId,
      actionAddress,
      outputCellId: actionCellId,
      jobId: existing.outputArtifactId ? 'reused' : '',
      runId: existing.outputArtifactId ? 'reused' : '',
      reusedAction: true,
      sourceCellId: source.id,
      sourceAddress: notebookCellTag(source),
    }
  }

  const accepted = recordValue(await input.callTool('extract_notebook_audio', {
    book_id: input.bookId,
    notebook_id: input.document.id,
    source_cell_id: source.id,
    label: 'Extract audio',
    ...(input.expectedRevision
      ? { expected_revision: input.expectedRevision }
      : {}),
  }))
  actionCellId = nonBlankStringValue(accepted?.cell_id)
  actionAddress = nonBlankStringValue(accepted?.address)
  const jobId = nonBlankStringValue(accepted?.job_id)
  const runId = nonBlankStringValue(accepted?.run_id)
  if (!actionCellId || !actionAddress || !jobId || !runId) {
    throw new Error('The server did not return an Extract Audio run')
  }
  return {
    actionCellId,
    actionAddress,
    outputCellId: actionCellId,
    jobId,
    runId,
    reusedAction: existing !== null,
    sourceCellId: source.id,
    sourceAddress: notebookCellTag(source),
  }
}
