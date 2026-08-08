import type { NotebookCell, NotebookDocument } from 'videobook-engine'
import { resolveGeneratedVideoArtifact } from 'videobook-engine'
import {
  notebookCellTag,
  resolveNotebookCellReference,
} from './notebook-addressing'
import { nextNotebookHorizontalGenerationSlot } from './notebook-grid'

export type NotebookFrameMode = 'first' | 'last' | 'time'

export type NotebookFrameCommand = {
  frameMode: NotebookFrameMode
  sourceReference: string
  timestampSeconds?: number
}

export type NotebookFrameCommandRun = {
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

// Accepts a grid address (@a3) or a cell id / id prefix; the resolver
// validates whichever form arrives.
const NOTEBOOK_FRAME_REFERENCE_SOURCE = '[a-z0-9][a-z0-9-]*'

const NOTEBOOK_FRAME_COMMAND_PATTERN = new RegExp(
  `^(?:please\\s+)?(?:extracte?|capture|grab|get)\\s+(?:the\\s+)?(first|last)\\s+frame\\s+(?:of|from)\\s+@(${NOTEBOOK_FRAME_REFERENCE_SOURCE})(?:\\s+please)?[.!]?$`,
  'iu',
)

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function normalizedTimestamp(value: unknown): number | null {
  const timestamp = Number(value)
  return Number.isFinite(timestamp) && timestamp >= 0
    ? Math.round(timestamp * 1_000) / 1_000
    : null
}

function frameMode(cell: NotebookCell): NotebookFrameMode | null {
  if (cell.inputs?.frameMode === 'last') return 'last'
  if (cell.inputs?.frameMode === 'time') return 'time'
  if (
    cell.inputs?.frameMode === undefined
    || cell.inputs.frameMode === 'first'
  ) return 'first'
  return null
}

function frameOutputCellId(
  document: NotebookDocument,
  actionCellId: string,
): string | null {
  return document.edges.find((edge) =>
    edge.source === actionCellId && edge.targetInput === 'media')?.target ?? null
}

function matchingAction(
  document: NotebookDocument,
  sourceCellId: string,
  command: NotebookFrameCommand,
): NotebookCell | null {
  const actionIds = new Set(document.edges
    .filter((edge) =>
      edge.source === sourceCellId && edge.targetInput === 'video')
    .map((edge) => edge.target))
  const requestedTimestamp = command.frameMode === 'time'
    ? normalizedTimestamp(command.timestampSeconds)
    : null
  return document.cells.find((cell) => {
    if (cell.type !== 'extract_frame' || !actionIds.has(cell.id)) return false
    if (frameMode(cell) !== command.frameMode) return false
    if (command.frameMode !== 'time') return true
    return normalizedTimestamp(cell.inputs?.timestampSeconds) === requestedTimestamp
  }) ?? null
}

function frameActionLabel(command: NotebookFrameCommand): string {
  if (command.frameMode === 'last') return 'Last frame'
  if (command.frameMode === 'time') {
    const timestamp = normalizedTimestamp(command.timestampSeconds) ?? 0
    return `Frame at ${timestamp}s`
  }
  return 'First frame'
}

function frameActionInputs(
  command: NotebookFrameCommand,
): Record<string, unknown> {
  if (command.frameMode === 'time') {
    return {
      frameMode: 'time',
      timestampSeconds: normalizedTimestamp(command.timestampSeconds) ?? 0,
    }
  }
  return { frameMode: command.frameMode }
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

export function resolveNotebookFrameSource(
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

export async function enqueueNotebookFrameCommand(input: {
  actor: string
  bookId: string
  callTool: NotebookToolCall
  command: NotebookFrameCommand
  document: NotebookDocument
  expectedRevision?: string
}): Promise<NotebookFrameCommandRun> {
  if (
    input.command.frameMode === 'time'
    && normalizedTimestamp(input.command.timestampSeconds) === null
  ) {
    throw new Error('A valid timestamp is required for time-mode frame extraction')
  }
  const source = resolveNotebookFrameSource(
    input.document,
    input.command.sourceReference,
  )
  const existing = matchingAction(
    input.document,
    source.id,
    input.command,
  )
  let actionCellId = existing?.id ?? null
  let actionAddress = existing ? notebookCellTag(existing) : null
  let outputCellId = existing
    ? frameOutputCellId(input.document, existing.id)
    : null

  if (!actionCellId || !actionAddress) {
    const created = objectValue(await input.callTool('create_notebook_cell', {
      book_id: input.bookId,
      notebook_id: input.document.id,
      ...(input.expectedRevision
        ? { expected_revision: input.expectedRevision }
        : {}),
      cell: {
        type: 'extract_frame',
        label: frameActionLabel(input.command),
        slot: nextNotebookHorizontalGenerationSlot(
          input.document.cells,
          [source.slot],
        ),
        inputs: frameActionInputs(input.command),
      },
    }))
    actionCellId = stringValue(created?.id)
    actionAddress = stringValue(created?.address)
    outputCellId = stringValue(objectValue(created?.output_cell)?.id)
    if (!actionCellId || !actionAddress) {
      throw new Error('The server did not return the Extract Frame cell')
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
    throw new Error('The server did not return an Extract Frame run')
  }
  return {
    actionCellId,
    actionAddress,
    outputCellId,
    jobId,
    runId,
    reusedAction: existing !== null,
    sourceCellId: source.id,
    sourceAddress: notebookCellTag(source),
  }
}
