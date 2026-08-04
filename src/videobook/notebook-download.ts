import type { NotebookGridSlot } from 'videobook-engine'

type DownloadVideoCellInput = {
  type: 'video'
  slot: NotebookGridSlot
  inputs: Record<string, unknown>
  output_artifact_id: string
}

type DownloadWatchAsset = {
  artifactId: string
  status: string
}

type DownloadWatchJob = {
  artifactId: string | null
  error: { message: string } | null
  state: string
}

export type DownloadWatchStep =
  | { kind: 'continue' }
  | { kind: 'completed' }
  | { kind: 'failed'; message: string }

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

export function downloadVideoCellInput(
  result: unknown,
  url: string,
  slot: NotebookGridSlot,
): DownloadVideoCellInput {
  const value = objectValue(result)
  const artifactId = stringValue(value?.artifact_id)
  if (!artifactId) {
    throw new Error('The download did not return an artifact for the board')
  }
  const jobId = stringValue(value?.job_id)
  return {
    type: 'video',
    slot,
    inputs: {
      sourceOperation: 'download_video',
      sourceUrl: url,
      ...(jobId ? { jobId } : {}),
    },
    output_artifact_id: artifactId,
  }
}

export function downloadWatchStep(
  artifactId: string,
  asset: DownloadWatchAsset | undefined,
  jobs: readonly DownloadWatchJob[],
): DownloadWatchStep {
  if (asset?.status === 'ready') return { kind: 'completed' }
  const failed = jobs.find((job) =>
    job.artifactId === artifactId
    && (job.state === 'failed' || job.state === 'aborted'))
  if (asset?.status === 'error' || failed) {
    return {
      kind: 'failed',
      message: failed?.error?.message ?? 'Download or media processing failed',
    }
  }
  return { kind: 'continue' }
}
