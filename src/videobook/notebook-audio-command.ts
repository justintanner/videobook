import type { NotebookCell, NotebookDocument } from 'videobook-engine'
import { resolveGeneratedVideoArtifact } from 'videobook-engine/notebook-media-artifact'
import {
  notebookCellTag,
  resolveNotebookCellReference,
} from './notebook-addressing'
import { nextNotebookHorizontalGenerationSlot } from './notebook-grid'

export type NotebookAudioCommand = {
  sourceReference: string
}

export type NotebookAudioCommandRun = {
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

function matchingAction(
  document: NotebookDocument,
  sourceCellId: string,
): NotebookCell | null {
  const actionIds = new Set(document.edges
    .filter((edge) =>
      edge.source === sourceCellId && edge.targetInput === 'video')
    .map((edge) => edge.target))
  return document.cells.find((cell) =>
    cell.type === 'extract_audio' && actionIds.has(cell.id)) ?? null
}

export function resolveNotebookAudioSource(
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

export async function enqueueNotebookAudioCommand(input: {
  actor: string
  bookId: string
  callTool: NotebookToolCall
  command: NotebookAudioCommand
  document: NotebookDocument
  expectedRevision?: string
}): Promise<NotebookAudioCommandRun> {
  const source = resolveNotebookAudioSource(
    input.document,
    input.command.sourceReference,
  )
  const existing = matchingAction(input.document, source.id)
  let actionCellId = existing?.id ?? null
  let actionAddress = existing ? notebookCellTag(existing) : null

  if (!actionCellId || !actionAddress) {
    const created = objectValue(await input.callTool('create_notebook_cell', {
      book_id: input.bookId,
      notebook_id: input.document.id,
      ...(input.expectedRevision
        ? { expected_revision: input.expectedRevision }
        : {}),
      cell: {
        type: 'extract_audio',
        label: 'Extract audio',
        slot: nextNotebookHorizontalGenerationSlot(
          input.document.cells,
          [source.slot],
        ),
      },
    }))
    actionCellId = stringValue(created?.id)
    actionAddress = stringValue(created?.address)
    if (!actionCellId || !actionAddress) {
      throw new Error('The server did not return the Extract Audio cell')
    }
    await input.callTool('set_notebook_cell_input', {
      book_id: input.bookId,
      notebook_id: input.document.id,
      target_cell_id: actionCellId,
      target_input: 'video',
      source_cell_id: source.id,
    })
  }

  const accepted = objectValue(await input.callTool('run_notebook_cell', {
    book_id: input.bookId,
    notebook_id: input.document.id,
    cell_id: actionCellId,
    actor: input.actor,
    ...(existing && input.expectedRevision
      ? { expected_revision: input.expectedRevision }
      : {}),
  }))
  const jobId = stringValue(accepted?.job_id)
  const runId = stringValue(accepted?.run_id)
  if (!jobId || !runId) {
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
