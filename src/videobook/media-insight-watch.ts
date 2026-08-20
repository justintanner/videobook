import type { MediaInsightKind } from './media-insights'

/** Queue jobs that can produce each insight sidecar. */
export const mediaInsightJobTypes: Record<MediaInsightKind, readonly string[]> = {
  transcript: ['transcribe', 'transcribe_video_audio'],
  analysis: ['analyze_video'],
}

export type MediaInsightWatchJob = {
  artifactId: string | null
  type: string
  state: string
  enqueuedAt: number
  error: { message: string } | null
}

export type MediaInsightWatchStep =
  | { kind: 'ready' }
  | { kind: 'failed'; message: string }
  | { kind: 'continue' }

function fallbackFailureMessage(insight: MediaInsightKind): string {
  return insight === 'transcript'
    ? 'Transcription failed'
    : 'Video analysis failed'
}

/**
 * Decide whether an enqueued transcribe / analyze job has settled. Jobs older
 * than `since` are ignored so a previous run's completed job never resolves a
 * fresh request.
 */
export function mediaInsightWatchStep(input: {
  insight: MediaInsightKind
  artifactId: string
  since: number
  hasInsight: boolean
  hadInsight: boolean
  jobs: readonly MediaInsightWatchJob[]
}): MediaInsightWatchStep {
  const runs = input.jobs.filter((job) =>
    job.artifactId === input.artifactId
    && mediaInsightJobTypes[input.insight].includes(job.type)
    && job.enqueuedAt >= input.since)
  const failed = runs.find((job) =>
    job.state === 'failed' || job.state === 'aborted')
  if (failed) {
    return {
      kind: 'failed',
      message: failed.error?.message ?? fallbackFailureMessage(input.insight),
    }
  }
  if (runs.some((job) => job.state === 'done')) return { kind: 'ready' }
  if (input.hasInsight && !input.hadInsight) return { kind: 'ready' }
  return { kind: 'continue' }
}
