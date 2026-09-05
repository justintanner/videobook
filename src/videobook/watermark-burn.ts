import type { WatermarkHandlePlacement, WatermarkPosition } from './watermark-review'

type WatermarkBurnWatchJob = {
  id: number
  artifactId: string | null
  state: string
  error: { message: string } | null
  result: Record<string, unknown> | null
}

type WatermarkBurnWatchAsset = {
  status: string
}

type WatermarkBurnWatchStep =
  | { kind: 'missing' }
  | { kind: 'continue' }
  | { kind: 'completed'; result: Record<string, unknown> | null }
  | { kind: 'failed'; message: string }

const ACTIVE_JOB_STATES = new Set(['queued', 'running', 'completing'])

function jobFailed(job: WatermarkBurnWatchJob): boolean {
  return job.state === 'failed' || job.state === 'aborted'
}

/**
 * One poll of a queued watermark burn. The burn job is the anchor: until it
 * is done the asset may still read "ready" (a queued job holds no lease).
 * After it, the reprocess it enqueues is any later job on the same asset,
 * and the asset must settle back to ready.
 */
export function watermarkBurnWatchStep(
  artifactId: string,
  jobId: number,
  asset: WatermarkBurnWatchAsset | undefined,
  jobs: readonly WatermarkBurnWatchJob[],
): WatermarkBurnWatchStep {
  const job = jobs.find((candidate) => candidate.id === jobId)
  if (!job) return { kind: 'missing' }
  if (jobFailed(job)) {
    return { kind: 'failed', message: job.error?.message ?? 'Watermark burn failed' }
  }
  if (job.state !== 'done') return { kind: 'continue' }
  const followUps = jobs.filter((candidate) =>
    candidate.artifactId === artifactId && candidate.id > jobId)
  const failedFollowUp = followUps.find(jobFailed)
  if (failedFollowUp || asset?.status === 'error') {
    return {
      kind: 'failed',
      message: failedFollowUp?.error?.message ?? 'Post-watermark processing failed',
    }
  }
  if (followUps.some((candidate) => ACTIVE_JOB_STATES.has(candidate.state))) {
    return { kind: 'continue' }
  }
  if (asset && asset.status !== 'ready') return { kind: 'continue' }
  return { kind: 'completed', result: job.result }
}

interface WatermarkAppliedSummary {
  includeQr: boolean
  includeHandle: boolean
  handle: string
  handlePlacement: WatermarkHandlePlacement
  handleVerticalPercent: number
  handleOpacity: number
  qrOpacity: number
  requestedPosition: WatermarkPosition
  corner: string | null
  placementSource: string | null
}

export function watermarkAppliedMessage(summary: WatermarkAppliedSummary): string {
  const frameAware = summary.placementSource === 'vision' || summary.placementSource === 'cached'
    ? ' (frame-aware)'
    : ''
  const handleOpacity = Math.round(summary.handleOpacity * 100)
  const handlePosition = summary.includeHandle
    ? summary.handlePlacement === 'center'
      ? ` · handle ${summary.handleVerticalPercent}% from top at ${handleOpacity}%`
      : ` · handle ${summary.handlePlacement.replace('-', ' ')} at ${handleOpacity}%`
    : ''
  const qrAppearance = summary.includeQr ? ` · QR ${Math.round(summary.qrOpacity * 100)}%` : ''
  const corner = summary.corner ?? summary.requestedPosition
  if (summary.includeQr) {
    return summary.includeHandle
      ? `QR + @${summary.handle} watermarks burned in — QR ${corner}${frameAware}${qrAppearance}${handlePosition}.`
      : `QR watermark burned in — ${corner}${frameAware}${qrAppearance}.`
  }
  return `@${summary.handle} watermark burned in${handlePosition}.`
}

export function watermarkQueuedMessage(
  includeQr: boolean,
  includeHandle: boolean,
  handle: string,
  targetLabel: string,
): string {
  const subject = includeQr
    ? includeHandle ? `QR + @${handle} watermarks` : 'QR watermark'
    : `@${handle} watermark`
  return `Burning ${subject} into ${targetLabel}…`
}
