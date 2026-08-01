import { v7 as uuidv7 } from 'uuid'
import type {
  NotebookCell,
  NotebookDocument,
  NotebookGridSlot,
} from 'videobook-engine'

export type NotebookSplitCommand = {
  sourceReference: string
  splitAtSeconds: number
}

export type NotebookSplitBranchRole = 'first' | 'remaining'

export type NotebookSplitBranchDraft = {
  actionCell: NotebookCell
  outputCell: NotebookCell
  role: NotebookSplitBranchRole
}

export type NotebookSplitDraft = {
  branches: [NotebookSplitBranchDraft, NotebookSplitBranchDraft]
  createdCellIds: string[]
  document: NotebookDocument
  sourceCellId: string
  sourceSlug: string
  splitAtSeconds: number
}

export type NotebookSplitRun = {
  branches: Array<{
    actionCellId: string
    actionSlug: string
    outputCellId: string
    outputSlug: string
    role: NotebookSplitBranchRole
  }>
  jobId: string
  runId: string
  sourceCellId: string
  sourceSlug: string
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

function normalizedSlugPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
}

function uniqueSlug(
  cells: readonly NotebookCell[],
  prefix: string,
  stem: string,
): string {
  const normalized = normalizedSlugPart(stem) || 'clip'
  const base = normalized.startsWith(`${prefix}-`)
    ? normalized
    : `${prefix}-${normalized}`
  const occupied = new Set(cells.map((cell) => cell.slug))
  if (!occupied.has(base)) return base
  for (let ordinal = 2; ; ordinal += 1) {
    const candidate = `${base}-${String(ordinal).padStart(2, '0')}`
    if (!occupied.has(candidate)) return candidate
  }
}

function splitTimeSlug(seconds: number): string {
  return `${String(seconds).replace('.', '-')}s`
}

function splitBranchSlots(
  cells: readonly NotebookCell[],
  source: NotebookGridSlot,
): [
  { action: NotebookGridSlot; output: NotebookGridSlot },
  { action: NotebookGridSlot; output: NotebookGridSlot },
] {
  const occupied = new Set(cells.map((cell) =>
    `${cell.slot.row}:${cell.slot.column}`))
  const columns = [source.column - 1, source.column + 1] as const
  for (let actionRow = source.row + 1; ; actionRow += 2) {
    const slots = columns.map((column) => ({
      action: { row: actionRow, column },
      output: { row: actionRow + 1, column },
    })) as [
      { action: NotebookGridSlot; output: NotebookGridSlot },
      { action: NotebookGridSlot; output: NotebookGridSlot },
    ]
    if (slots.every(({ action, output }) =>
      !occupied.has(`${action.row}:${action.column}`)
      && !occupied.has(`${output.row}:${output.column}`))) {
      return slots
    }
  }
}

function createBranch(input: {
  cells: readonly NotebookCell[]
  endSeconds: number
  role: NotebookSplitBranchRole
  slot: { action: NotebookGridSlot; output: NotebookGridSlot }
  source: NotebookCell
  sourceDurationSeconds: number
  startSeconds: number
  timeSlug: string
}): NotebookSplitBranchDraft {
  const sourceStem = input.source.slug.replace(/^vid-/u, '')
  const stem = input.role === 'first'
    ? `${sourceStem}-first-${input.timeSlug}`
    : `${sourceStem}-remaining`
  const actionCell: NotebookCell = {
    id: uuidv7(),
    type: 'split_video',
    slug: uniqueSlug(input.cells, 'split-video', stem),
    slot: input.slot.action,
    provider: 'local',
    operation: 'split_range',
    tool: 'ffmpeg',
    inputs: {
      endSeconds: input.endSeconds,
      sourceCellId: input.source.id,
      sourceDurationSeconds: input.sourceDurationSeconds,
      splitRole: input.role,
      startSeconds: input.startSeconds,
      state: 'ready',
    },
  }
  const outputCell: NotebookCell = {
    id: uuidv7(),
    type: 'video',
    slug: uniqueSlug(
      [...input.cells, actionCell],
      'vid',
      stem,
    ),
    slot: input.slot.output,
    inputs: {
      endSeconds: input.endSeconds,
      mediaRole: 'split-video-output',
      producerCellId: actionCell.id,
      sourceCellId: input.source.id,
      splitRole: input.role,
      startSeconds: input.startSeconds,
      state: 'pending',
    },
  }
  return { actionCell, outputCell, role: input.role }
}

function cellCreateInput(cell: NotebookCell): Record<string, unknown> {
  return {
    id: cell.id,
    type: cell.type,
    slug: cell.slug,
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
  const match = input.trim().match(
    /^(?:please\s+)?(?:\/split|split)\s+@([a-z0-9]+(?:-[a-z0-9]+)+)(?:\s+([\s\S]+?))?(?:\s+please)?[.!]?$/iu,
  )
  if (!match) return null
  const splitAtSeconds = match[2]
    ? timestampSeconds(splitBoundaryPhrase(match[2]))
    : null
  if (!Number.isFinite(splitAtSeconds) || !(splitAtSeconds! > 0)) {
    throw new Error(
      'Name a positive split time, for example: split @vid-01 into 15s and the remaining',
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
      `@${source.slug} does not have a usable duration yet; wait for video processing to finish`,
    )
  }
  const firstDuration = input.command.splitAtSeconds
  const remainingDuration = input.sourceDurationSeconds - firstDuration
  if (
    firstDuration < minimumSplitChunkSeconds
    || remainingDuration < minimumSplitChunkSeconds
  ) {
    throw new Error(
      `Split @${source.slug} between ${minimumSplitChunkSeconds}s and ${(input.sourceDurationSeconds - minimumSplitChunkSeconds).toFixed(2)}s so both clips contain usable video`,
    )
  }

  const slots = splitBranchSlots(input.document.cells, source.slot)
  const timeSlug = splitTimeSlug(firstDuration)
  const first = createBranch({
    cells: input.document.cells,
    endSeconds: firstDuration,
    role: 'first',
    slot: slots[0],
    source,
    sourceDurationSeconds: input.sourceDurationSeconds,
    startSeconds: 0,
    timeSlug,
  })
  const remaining = createBranch({
    cells: [
      ...input.document.cells,
      first.actionCell,
      first.outputCell,
    ],
    endSeconds: input.sourceDurationSeconds,
    role: 'remaining',
    slot: slots[1],
    source,
    sourceDurationSeconds: input.sourceDurationSeconds,
    startSeconds: firstDuration,
    timeSlug,
  })
  const branches: NotebookSplitDraft['branches'] = [first, remaining]
  const createdCells = branches.flatMap((branch) => [
    branch.actionCell,
    branch.outputCell,
  ])
  const createdEdges = branches.flatMap((branch) => [
    {
      id: uuidv7(),
      source: source.id,
      target: branch.actionCell.id,
      targetInput: 'video',
    },
    {
      id: uuidv7(),
      source: branch.actionCell.id,
      target: branch.outputCell.id,
      targetInput: 'media',
    },
  ])
  return {
    branches,
    createdCellIds: createdCells.map((cell) => cell.id),
    document: {
      ...input.document,
      cells: [...input.document.cells, ...createdCells],
      edges: [...input.document.edges, ...createdEdges],
    },
    sourceCellId: source.id,
    sourceSlug: source.slug,
    splitAtSeconds: firstDuration,
  }
}

export async function enqueueNotebookSplitCommand(input: {
  actor: string
  bookId: string
  callTool: NotebookToolCall
  draft: NotebookSplitDraft
}): Promise<NotebookSplitRun> {
  const createdCellIds: string[] = []
  let runRequested = false
  try {
    for (const branch of input.draft.branches) {
      for (const cell of [branch.actionCell, branch.outputCell]) {
        createdCellIds.push(cell.id)
        const createdValue = await input.callTool('create_notebook_cell', {
          book_id: input.bookId,
          notebook_id: input.draft.document.id,
          cell: cellCreateInput(cell),
        })
        const created = objectValue(createdValue)
        const createdId = stringValue(created?.id)
        if (createdId !== cell.id) {
          throw new Error('The server did not preserve the planned split cell')
        }
      }
    }

    for (const branch of input.draft.branches) {
      await input.callTool('connect_notebook_cells', {
        book_id: input.bookId,
        notebook_id: input.draft.document.id,
        source_cell_id: input.draft.sourceCellId,
        target_cell_id: branch.actionCell.id,
        target_input: 'video',
      })
      await input.callTool('connect_notebook_cells', {
        book_id: input.bookId,
        notebook_id: input.draft.document.id,
        source_cell_id: branch.actionCell.id,
        target_cell_id: branch.outputCell.id,
        target_input: 'media',
      })
    }

    runRequested = true
    const acceptedValue = await input.callTool('run_notebook', {
      actor: input.actor,
      book_id: input.bookId,
      notebook_id: input.draft.document.id,
      cell_ids: input.draft.branches.map((branch) => branch.actionCell.id),
    })
    const accepted = objectValue(acceptedValue)
    const jobId = stringValue(accepted?.job_id)
    const runId = stringValue(accepted?.run_id)
    if (!jobId || !runId) {
      throw new Error('The server did not return a notebook split run')
    }
    return {
      branches: input.draft.branches.map((branch) => ({
        actionCellId: branch.actionCell.id,
        actionSlug: branch.actionCell.slug,
        outputCellId: branch.outputCell.id,
        outputSlug: branch.outputCell.slug,
        role: branch.role,
      })),
      jobId,
      runId,
      sourceCellId: input.draft.sourceCellId,
      sourceSlug: input.draft.sourceSlug,
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
