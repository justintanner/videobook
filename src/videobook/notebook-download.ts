import type { NotebookGridSlot } from 'videobook-engine'
import { nonBlankStringValue, recordValue } from './value-decoders'

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
  result: Record<string, unknown> | null
  state: string
  type: string
}

type DownloadWatchStep =
  | { kind: 'continue' }
  | { kind: 'completed' }
  | { kind: 'redirected'; artifactId: string }
  | { kind: 'failed'; message: string }

export function downloadVideoCellInput(
  result: unknown,
  url: string,
  slot: NotebookGridSlot,
): DownloadVideoCellInput {
  const value = recordValue(result)
  const artifactId = nonBlankStringValue(value?.artifact_id)
  if (!artifactId) {
    throw new Error('The download did not return an artifact for the board')
  }
  const jobId = nonBlankStringValue(value?.job_id)
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

const MEDIA_FAILURE_JOB_TYPES: ReadonlySet<string> = new Set([
  'download_video',
  'process_image',
  'process_video',
  'process_audio',
  'process_upload',
  'complete_kie_task',
  'generate_media',
])

export function downloadWatchStep(
  artifactId: string,
  asset: DownloadWatchAsset | undefined,
  jobs: readonly DownloadWatchJob[],
): DownloadWatchStep {
  return mediaAssetWatchStep(artifactId, asset, jobs)
}

/** Watch step for board media that is still downloading, completing or process_*'ing. */
export function mediaAssetWatchStep(
  artifactId: string,
  asset: DownloadWatchAsset | undefined,
  jobs: readonly DownloadWatchJob[],
  recordedError?: string | null,
): DownloadWatchStep {
  const completedDownload = jobs.find((job) =>
    job.artifactId === artifactId
    && job.type === 'download_video'
    && job.state === 'done')
  const completedResult = recordValue(completedDownload?.result)
  const replacementArtifactId = completedResult?.retyped === true
    ? nonBlankStringValue(completedResult.assetId ?? completedResult.artifact_id)
    : null
  if (replacementArtifactId && replacementArtifactId !== artifactId) {
    return { kind: 'redirected', artifactId: replacementArtifactId }
  }
  if (asset?.status === 'ready') return { kind: 'completed' }
  const failed = jobs.find((job) =>
    job.artifactId === artifactId
    && (job.state === 'failed' || job.state === 'aborted')
    && MEDIA_FAILURE_JOB_TYPES.has(job.type))
  if (asset?.status === 'error' || failed) {
    return {
      kind: 'failed',
      message: failed?.error?.message
        ?? nonBlankStringValue(recordedError)
        ?? 'Media processing failed',
    }
  }
  return { kind: 'continue' }
}
