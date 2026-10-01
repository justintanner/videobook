// Whether a generated image or video output is still being produced, and
// what the inspector should say about it. Derived on every render from the
// notebook graph, the queued set, live run errors, and the job list — never
// stored, so a completed run flips the dock back to ready media by itself.
import type { NotebookCell, NotebookEdge } from 'videobook-engine'
import { isImageVideoGenerationResultCell } from './notebook-cell-presentation'
import type { NotebookRunJobView } from './notebook-run-watch'

export type MediaCellGenerationState =
  | { kind: 'ready' }
  | {
    kind: 'queued' | 'generating'
    startedAt: string | null
    model: string | null
    prompt: string | null
    producerCellId: string | null
    jobId: string | null
  }
  | { kind: 'failed'; message: string; producerCellId: string | null }

const ACTIVE_JOB_STATES = new Set(['queued', 'running', 'completing'])

function producerOf(
  cell: NotebookCell,
  cells: readonly NotebookCell[],
  edges: readonly NotebookEdge[],
): NotebookCell | null {
  const edge = edges.find((candidate) =>
    candidate.target === cell.id && candidate.targetInput === 'media')
  if (!edge) return null
  const producer = cells.find((candidate) => candidate.id === edge.source)
  return producer && (producer.type === 'generate_image'
    || producer.type === 'generate_video')
    ? producer
    : null
}

/** The generate_* cell feeding a generation output, or null. */
export function mediaGenerationProducer(
  cell: NotebookCell,
  cells: readonly NotebookCell[],
  edges: readonly NotebookEdge[],
): NotebookCell | null {
  return isImageVideoGenerationResultCell(cell)
    ? producerOf(cell, cells, edges)
    : null
}

/** Awaiting jobs are keyed by the producer cell; newer runs carry the output. */
function activeOutputJob(
  cellId: string,
  producerCellId: string | null,
  jobs: readonly NotebookRunJobView[] | undefined,
): NotebookRunJobView | null {
  const awaiting = (jobs ?? []).filter((job) => {
    if (job.type !== 'await_notebook_output' || !ACTIVE_JOB_STATES.has(job.state)) {
      return false
    }
    const payload = job.payload
    const outputCellId = typeof payload?.outputCellId === 'string'
      && payload.outputCellId
      ? payload.outputCellId
      : null
    if (outputCellId) return outputCellId === cellId
    const legacyCellId = typeof payload?.cellId === 'string' && payload.cellId
      ? payload.cellId
      : null
    return producerCellId !== null && legacyCellId === producerCellId
  })
  if (awaiting.length === 0) return null
  return awaiting.reduce((best, candidate) =>
    (candidate.operationId ?? '') > (best.operationId ?? '') ? candidate : best)
}

function producingState(
  cell: NotebookCell,
  producer: NotebookCell | null,
  job: NotebookRunJobView | null,
  queued: boolean,
): MediaCellGenerationState {
  const shared = {
    startedAt: typeof job?.startedAt === 'number'
      ? new Date(job.startedAt).toISOString()
      : null,
    model: producer?.model ?? null,
    prompt: producer?.prompt ?? cell.prompt ?? null,
    producerCellId: producer?.id ?? null,
    jobId: job?.operationId ?? null,
  }
  return {
    ...shared,
    kind: queued || job === null || job.state === 'queued' ? 'queued' : 'generating',
  }
}

export function mediaCellGenerationState(input: {
  cell: NotebookCell
  cells: readonly NotebookCell[]
  edges: readonly NotebookEdge[]
  queuedCellIds?: ReadonlySet<string>
  runErrors?: Readonly<Record<string, string>>
  jobs?: readonly NotebookRunJobView[]
}): MediaCellGenerationState {
  if (!isImageVideoGenerationResultCell(input.cell)) return { kind: 'ready' }
  const producer = producerOf(input.cell, input.cells, input.edges)
  const producerCellId = producer?.id ?? null
  const runError = input.runErrors?.[input.cell.id]
  if (runError) {
    return { kind: 'failed', message: runError, producerCellId }
  }
  const job = activeOutputJob(input.cell.id, producerCellId, input.jobs)
  if (job) {
    return producingState(
      input.cell,
      producer,
      job,
      input.queuedCellIds?.has(input.cell.id) ?? false,
    )
  }
  if (input.queuedCellIds?.has(input.cell.id)) {
    return producingState(input.cell, producer, null, true)
  }
  return { kind: 'ready' }
}
