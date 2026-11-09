import { describe, expect, it } from 'vitest'
import { asJobs } from './workspace-responses'

describe('asJobs', () => {
  it('keeps the usage totals list_jobs attaches to a job and drops malformed ones', () => {
    const usage = {
      id: 'run-notebook-1', count: 2, inputTokens: 1200, outputTokens: 300, cachedTokens: 0, missingTokens: 0,
      reportedUsd: 0, estimatedUsd: 0.41, unpriced: 0, pendingCount: 1, pendingUsd: 1.85,
      actualUsd: 0.41, estimateUsd: 2.27, settledEstimateUsd: 0.42, pendingEstimateUsd: 1.85, unsettled: 1, unestimated: 0,
    }
    const [costed, malformed, uncosted] = asJobs([
      { id: 1, operationId: 'run-notebook-1', type: 'run_notebook', state: 'done', usage },
      { id: 2, operationId: 'run-notebook-2', type: 'run_notebook', state: 'done', usage: { ...usage, count: '2' } },
      { id: 3, operationId: 'run-notebook-3', type: 'run_notebook', state: 'done' },
    ])
    expect(costed?.usage).toEqual(usage)
    expect(malformed?.usage).toBeNull()
    expect(uncosted?.usage).toBeNull()
  })

  it('keeps the not-billed calls list_jobs attaches to a job and drops malformed ones', () => {
    const rejected = {
      id: 'call-1', provider: 'fal', model: 'minimax/h3-max/extend-video', status: 'failed', basis: 'free', costUsd: 0,
      warnings: ['fal answered HTTP 422 and billed 0 units: video_url: File size exceeds 52428800 bytes'],
    }
    const [job, plain] = asJobs([
      { id: 1, operationId: 'generate-1', type: 'generate_media', state: 'failed', notBilledCalls: [rejected, { ...rejected, id: 'call-2', warnings: 'none' }, null] },
      { id: 2, operationId: 'generate-2', type: 'generate_media', state: 'done' },
    ])
    expect(job?.notBilledCalls).toEqual([rejected])
    expect(plain?.notBilledCalls).toEqual([])
  })
})
