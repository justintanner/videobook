import type { NotebookCellType } from 'videobook-engine'
import { isNotebookMediaWorkCellType } from './notebook-cell-types'

type MediaWorkAsset = {
  artifactId: string
  createdAt: string
  status: string
}

type MediaWorkJob = {
  artifactId: string | null
  enqueuedAt: number
  error: { message: string } | null
  startedAt: number | null
  state: string
}

type CellWorkState = {
  error?: string
  startedAt?: string
  status: string
}

function jobStartedAt(job: MediaWorkJob | undefined): string | undefined {
  const value = job?.startedAt ?? job?.enqueuedAt
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? new Date(value).toISOString()
    : undefined
}

export function notebookMediaWorkState(
  kind: NotebookCellType,
  asset: MediaWorkAsset | undefined,
  jobs: readonly MediaWorkJob[],
  fallback: CellWorkState,
): CellWorkState {
  if (!isNotebookMediaWorkCellType(kind) || !asset) return fallback
  if (asset.status === 'ready') return { status: 'completed' }
  const artifactJobs = jobs.filter((job) => job.artifactId === asset.artifactId)
  const activeJob = artifactJobs.find((job) =>
    job.state === 'queued'
    || job.state === 'running'
    || job.state === 'completing')
  const failedJob = artifactJobs.find((job) =>
    job.state === 'failed' || job.state === 'aborted')
  if (asset.status === 'error' || (!activeJob && failedJob)) {
    return {
      status: 'error',
      error: failedJob?.error?.message
        ?? fallback.error
        ?? 'Media processing failed',
    }
  }
  return {
    status: asset.status,
    startedAt: jobStartedAt(activeJob)
      ?? jobStartedAt(artifactJobs[0])
      ?? asset.createdAt,
  }
}
