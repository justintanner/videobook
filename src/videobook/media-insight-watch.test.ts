import { describe, expect, it } from 'vitest'
import {
  mediaInsightWatchStep,
  type MediaInsightWatchJob,
} from './media-insight-watch'

const artifactId = '018f7cf5-0d31-7d96-8c0f-800000000001'
const since = 1_000

function job(
  partial: Partial<MediaInsightWatchJob> & Pick<MediaInsightWatchJob, 'state'>,
): MediaInsightWatchJob {
  return {
    artifactId,
    type: 'transcribe',
    enqueuedAt: since + 10,
    error: null,
    ...partial,
  }
}

describe('mediaInsightWatchStep', () => {
  it('keeps polling while the job is queued', () => {
    expect(mediaInsightWatchStep({
      insight: 'transcript',
      artifactId,
      since,
      hasInsight: false,
      hadInsight: false,
      jobs: [job({ state: 'queued' })],
    })).toEqual({ kind: 'continue' })
  })

  it('is ready when the transcript first appears', () => {
    expect(mediaInsightWatchStep({
      insight: 'transcript',
      artifactId,
      since,
      hasInsight: true,
      hadInsight: false,
      jobs: [job({ state: 'running' })],
    })).toEqual({ kind: 'ready' })
  })

  it('is ready when a re-run job finishes even though the insight existed', () => {
    expect(mediaInsightWatchStep({
      insight: 'transcript',
      artifactId,
      since,
      hasInsight: true,
      hadInsight: true,
      jobs: [job({ state: 'done' })],
    })).toEqual({ kind: 'ready' })
  })

  it('ignores completed jobs enqueued before the request', () => {
    expect(mediaInsightWatchStep({
      insight: 'transcript',
      artifactId,
      since,
      hasInsight: true,
      hadInsight: true,
      jobs: [job({ state: 'done', enqueuedAt: since - 1 })],
    })).toEqual({ kind: 'continue' })
  })

  it('reports the job error when the run fails', () => {
    expect(mediaInsightWatchStep({
      insight: 'transcript',
      artifactId,
      since,
      hasInsight: false,
      hadInsight: false,
      jobs: [job({ state: 'failed', error: { message: 'no audio stream' } })],
    })).toEqual({ kind: 'failed', message: 'no audio stream' })
  })

  it('falls back to a generic message for an aborted analysis', () => {
    expect(mediaInsightWatchStep({
      insight: 'analysis',
      artifactId,
      since,
      hasInsight: false,
      hadInsight: false,
      jobs: [job({ state: 'aborted', type: 'analyze_video' })],
    })).toEqual({ kind: 'failed', message: 'Video analysis failed' })
  })

  it('ignores jobs for other artifacts and other insights', () => {
    expect(mediaInsightWatchStep({
      insight: 'analysis',
      artifactId,
      since,
      hasInsight: false,
      hadInsight: false,
      jobs: [
        job({ state: 'done' }),
        job({ state: 'done', type: 'analyze_video', artifactId: 'other' }),
      ],
    })).toEqual({ kind: 'continue' })
  })
})
