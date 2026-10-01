import type { NotebookCellRunObservation } from './notebook-cell-presentation'

export type NotebookRunJobView = {
  id?: number
  state: string
  errorMessage: string | null
  operationId?: string
  type?: string
  startedAt?: number | null
  payload?: Record<string, unknown> | null
}

type NotebookRunWatchStep =
  | { kind: 'continue'; sawRun: boolean }
  | { kind: 'completed' }
  | { kind: 'failed'; message: string }
  | { kind: 'superseded' }

export type NotebookRunWatchOutcomeKind =
  | 'completed'
  | 'failed'
  | 'superseded'
  | 'timeout'

export function notebookGenerationInterruptedMessage(
  errorMessage: string | null | undefined,
  state: string,
): string {
  const detail = errorMessage?.trim() || `Notebook run ${state}`
  return (
    `Generation was interrupted (${detail}). `
    + 'Clear the slot to reset the cell, then generate again.'
  )
}

export function selectEffectiveNotebookRunJob(input: {
  jobs: readonly NotebookRunJobView[]
  cellId: string
  runId: string
  jobOperationId: string
}): NotebookRunJobView | null {
  const awaits = input.jobs.filter((job) => {
    if (job.type !== 'await_notebook_output') return false
    const payload = job.payload
    if (!payload) return false
    return payload.cellId === input.cellId && payload.runId === input.runId
  })
  if (awaits.length > 0) {
    const newest = awaits.reduce((best, candidate) => {
      const bestId = best.operationId ?? ''
      const candidateId = candidate.operationId ?? ''
      return candidateId > bestId ? candidate : best
    })
    return newest
  }
  return input.jobs.find((job) => job.operationId === input.jobOperationId) ?? null
}

export function notebookRunWatchStep(input: {
  observation: NotebookCellRunObservation
  job: NotebookRunJobView | null
  address: string
  sawRun: boolean
}): NotebookRunWatchStep {
  if (input.observation.state === 'error') {
    return {
      kind: 'failed',
      message: input.observation.error ?? `@${input.address} failed`,
    }
  }
  if (input.observation.state === 'completed') {
    return { kind: 'completed' }
  }
  if (input.observation.state === 'pending' && input.sawRun) {
    return { kind: 'superseded' }
  }
  if (input.job?.state === 'failed' || input.job?.state === 'aborted') {
    return {
      kind: 'failed',
      message: notebookGenerationInterruptedMessage(
        input.job.errorMessage,
        input.job.state,
      ),
    }
  }
  return {
    kind: 'continue',
    sawRun: input.sawRun || input.observation.state === 'active',
  }
}

export function notebookRunJobViewFromRecord(job: {
  id?: number
  state: string
  operationId: string
  type: string
  startedAt?: number | null
  error: { message: string } | null
  payload?: Record<string, unknown> | null
}): NotebookRunJobView {
  return {
    state: job.state,
    errorMessage: job.error?.message ?? null,
    operationId: job.operationId,
    type: job.type,
    startedAt: job.startedAt ?? null,
    payload: job.payload ?? null,
    ...(typeof job.id === 'number' ? { id: job.id } : {}),
  }
}
