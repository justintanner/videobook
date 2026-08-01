import type {
  NotebookCell,
  NotebookDocument,
  NotebookGridSlot,
} from 'videobook-engine'
import { nextNotebookCellSlug } from './notebook-download'

export type NotebookFrameMode = 'first' | 'last'

export type NotebookFrameCommand = {
  frameMode: NotebookFrameMode
  sourceReference: string
}

export type NotebookFrameCommandRun = {
  actionCellId: string
  actionSlug: string
  outputCellId: string | null
  jobId: string
  runId: string
  reusedAction: boolean
  sourceCellId: string
  sourceSlug: string
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

function frameMode(cell: NotebookCell): NotebookFrameMode | null {
  if (cell.inputs?.frameMode === 'last') return 'last'
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
  requestedMode: NotebookFrameMode,
): NotebookCell | null {
  const actionIds = new Set(document.edges
    .filter((edge) =>
      edge.source === sourceCellId && edge.targetInput === 'video')
    .map((edge) => edge.target))
  return document.cells.find((cell) =>
    cell.type === 'extract_frame'
    && actionIds.has(cell.id)
    && frameMode(cell) === requestedMode) ?? null
}

function firstEmptyRowBelow(
  cells: readonly NotebookCell[],
  source: NotebookGridSlot,
): NotebookGridSlot {
  const occupied = new Set(cells.map((cell) =>
    `${cell.slot.row}:${cell.slot.column}`))
  for (let row = source.row + 1; ; row += 1) {
    if (!occupied.has(`${row}:${source.column}`)) {
      return { row, column: source.column }
    }
  }
}

export function parseNotebookFrameCommand(
  input: string,
): NotebookFrameCommand | null {
  const match = input.trim().match(
    /^(?:please\s+)?(?:extract|capture|grab|get)\s+(?:the\s+)?(first|last)\s+frame\s+(?:of|from)\s+@([a-z0-9]+(?:-[a-z0-9]+)+)(?:\s+please)?[.!]?$/iu,
  )
  if (!match) return null
  return {
    frameMode: match[1]!.toLowerCase() as NotebookFrameMode,
    sourceReference: match[2]!.toLowerCase(),
  }
}

export function resolveNotebookFrameSource(
  document: NotebookDocument,
  sourceReference: string,
): NotebookCell {
  const reference = sourceReference.replace(/^@/u, '').toLowerCase()
  const exact = document.cells.find((cell) =>
    cell.slug.toLowerCase() === reference
    || cell.id.toLowerCase() === reference)
  const prefixMatches = exact
    ? []
    : document.cells.filter((cell) =>
        cell.id.toLowerCase().startsWith(reference))
  if (prefixMatches.length > 1) {
    throw new Error(`Cell reference @${reference} is ambiguous`)
  }
  const source = exact ?? prefixMatches[0]
  if (!source) throw new Error(`Video cell @${reference} was not found`)
  if (!videoSourceTypes.has(source.type)) {
    throw new Error(`@${source.slug} is not a video-producing cell`)
  }
  if (!source.outputArtifactId) {
    throw new Error(`@${source.slug} does not have a video output yet`)
  }
  return source
}

export async function enqueueNotebookFrameCommand(input: {
  actor: string
  bookId: string
  callTool: NotebookToolCall
  command: NotebookFrameCommand
  document: NotebookDocument
}): Promise<NotebookFrameCommandRun> {
  const source = resolveNotebookFrameSource(
    input.document,
    input.command.sourceReference,
  )
  const existing = matchingAction(
    input.document,
    source.id,
    input.command.frameMode,
  )
  let actionCellId = existing?.id ?? null
  let actionSlug = existing?.slug ?? null
  let outputCellId = existing
    ? frameOutputCellId(input.document, existing.id)
    : null

  if (!actionCellId || !actionSlug) {
    const created = objectValue(await input.callTool('create_notebook_cell', {
      book_id: input.bookId,
      notebook_id: input.document.id,
      cell: {
        type: 'extract_frame',
        slug: nextNotebookCellSlug('extract_frame', input.document.cells),
        slot: firstEmptyRowBelow(input.document.cells, source.slot),
        inputs: { frameMode: input.command.frameMode },
      },
    }))
    actionCellId = stringValue(created?.id)
    actionSlug = stringValue(created?.slug)
    outputCellId = stringValue(objectValue(created?.output_cell)?.id)
    if (!actionCellId || !actionSlug) {
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
  }))
  const jobId = stringValue(accepted?.job_id)
  const runId = stringValue(accepted?.run_id)
  if (!jobId || !runId) {
    throw new Error('The server did not return an Extract Frame run')
  }
  return {
    actionCellId,
    actionSlug,
    outputCellId,
    jobId,
    runId,
    reusedAction: existing !== null,
    sourceCellId: source.id,
    sourceSlug: source.slug,
  }
}
