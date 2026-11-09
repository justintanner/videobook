import { describe, expect, it } from 'vitest'
import type { NotebookCell, UsageEntry } from 'videobook-engine'
import { createCommandPlan } from './command-plan'
import {
  buildJobsRows,
  countJobsBands,
  filterJobsBands,
  formatDuration,
  groupJobsRows,
  humanizeJobType,
  type JobsScreenJob,
  type JobsScreenPlan,
} from './jobs-presentation'
import { parseNotebookGridAddress } from './notebook-grid'

const NOW = Date.parse('2026-08-29T09:12:03Z')
const READY_ASSETS = [{
  artifactId: '01a04918-a21b-72aa-abd1-dcada9eb903e',
  status: 'ready',
  mediaUrl: '/files/book-1/01a04918-a21b-72aa-abd1-dcada9eb903e/proxy.mp4',
}]

function cell(address: string, overrides: Partial<NotebookCell>): NotebookCell {
  const slot = parseNotebookGridAddress(address)
  if (!slot) throw new Error(`bad address ${address}`)
  return { id: `cell-${address}`, type: 'video', slot, ...overrides } as NotebookCell
}

function job(overrides: Partial<JobsScreenJob>): JobsScreenJob {
  return {
    id: 1,
    operationId: '01a04b45-50f6-74b1-8ecc-e335eedcf26f',
    type: 'extract_waveform',
    state: 'done',
    artifactId: null,
    attempts: 1,
    maxAttempts: 1,
    error: null,
    payload: null,
    enqueuedAt: NOW - 60_000,
    startedAt: NOW - 59_000,
    finishedAt: NOW - 58_600,
    ...overrides,
  }
}

function plan(overrides: Partial<JobsScreenPlan>): JobsScreenPlan {
  return {
    planId: 'plan-1',
    cellId: 'cell-@c4',
    status: 'awaiting-output',
    outputArtifactId: '01a04918-a21b-72aa-abd1-dcada9eb903e',
    error: null,
    createdAt: '2026-08-29T09:08:41Z',
    updatedAt: '2026-08-29T09:09:00Z',
    plan: createCommandPlan({
      planId: 'plan-1',
      sourceSurface: 'ui',
      actor: 'videobook-user',
      bookId: 'book-1',
      summary: 'Generate with bytedance/seedance-2-5 and insert the result',
      normalizedReferences: [],
      stages: [{
        stageId: 'plan-1:generation:0',
        kind: 'queued',
        summary: 'Generate video',
        jobType: 'generation',
        tool: 'generate_video',
        input: {},
        provider: 'kie',
        model: 'bytedance/seedance-2-5',
        estimatedCostUsd: 8.19,
        insertsOutput: true,
        continuation: { sequenceId: 'sequence-1', baseRevision: 'revision-1', destination: {} },
      }],
    }),
    ...overrides,
  }
}

describe('humanizeJobType', () => {
  it('uses the curated title for known types and title-cases the rest', () => {
    expect(humanizeJobType('run_notebook')).toBe('Run notebook')
    expect(humanizeJobType('generate_video')).toBe('Generate video')
    expect(humanizeJobType('media-probe')).toBe('Media probe')
  })
})

describe('formatDuration', () => {
  it('scales from tenths of a second to hours', () => {
    expect(formatDuration(400)).toBe('0.4s')
    expect(formatDuration(12_400)).toBe('12s')
    expect(formatDuration(108_000)).toBe('1m 48s')
    expect(formatDuration(3_720_000)).toBe('1h 02m')
    expect(formatDuration(-5)).toBe('0.0s')
  })
})

describe('buildJobsRows', () => {
  const cells = [
    cell('@a3', { label: 'purr-loop.wav', outputArtifactId: 'artifact-a3' }),
    cell('@c4', { id: 'cell-@c4', type: 'generate_video', prompt: 'cat rolls over, slow dolly' }),
  ]

  it('maps a running job to its grid address, live summary and cancel action', () => {
    const [row] = buildJobsRows({
      jobs: [job({ state: 'running', artifactId: 'artifact-a3', startedAt: NOW - 4_000, finishedAt: null })],
      plans: [],
      cells,
      now: NOW,
    })
    expect(row).toMatchObject({
      tone: 'running',
      band: 'running',
      statusLabel: 'RUNNING',
      title: 'Extract waveform',
      detail: null,
      target: { tag: '@a3', label: 'purr-loop.wav' },
      summary: 'Extract waveform in progress',
      note: '4.0s elapsed',
      live: true,
      actions: ['cancel'],
    })
  })

  it('shows a job\'s actual beside its estimate, partial while a call is still running', () => {
    const usage = {
      id: 'op-1', count: 3, inputTokens: 1200, outputTokens: 300, cachedTokens: 0, missingTokens: 0,
      reportedUsd: 0.4, estimatedUsd: 0.41, unpriced: 0, pendingCount: 1, pendingUsd: 1.85,
      actualUsd: 0.81, estimateUsd: 2.72, settledEstimateUsd: 0.87, pendingEstimateUsd: 1.85, unsettled: 1, unestimated: 0,
    }
    const [running] = buildJobsRows({
      jobs: [job({ state: 'running', artifactId: 'artifact-a3', startedAt: NOW - 4_000, finishedAt: null, usage })],
      plans: [],
      cells,
      now: NOW,
    })
    expect(running?.note).toBe('4.0s elapsed · ~$0.81 actual · est. $0.87 · est. $1.85 in progress · partial: 2 of 3 calls settled')
    const settled = { ...usage, reportedUsd: 2.25, pendingCount: 0, pendingUsd: 0, actualUsd: 2.66, settledEstimateUsd: 2.72, pendingEstimateUsd: 0, unsettled: 0 }
    const [done] = buildJobsRows({
      jobs: [job({ state: 'done', artifactId: 'artifact-a3', startedAt: NOW - 4_000, finishedAt: NOW, usage: settled })],
      plans: [],
      cells,
      now: NOW,
    })
    expect(done?.note).toBe('~$2.66 actual · est. $2.72')
    const [free] = buildJobsRows({ jobs: [job({ state: 'done', usage: null })], plans: [], cells, now: NOW })
    expect(free?.note).toBeNull()
  })

  it('says which of a job\'s calls failed without a charge, with the provider\'s reason', () => {
    const usage = {
      id: 'op-1', count: 2, inputTokens: 0, outputTokens: 0, cachedTokens: 0, missingTokens: 0,
      reportedUsd: 0.4, estimatedUsd: 0, unpriced: 0, pendingCount: 0, pendingUsd: 0,
      actualUsd: 0.4, estimateUsd: 0.77, settledEstimateUsd: 0.77, pendingEstimateUsd: 0, unsettled: 0, unestimated: 0,
    }
    const rejected: UsageEntry = {
      id: 'call-1', provider: 'fal', model: 'minimax/h3-max/extend-video', activity: 'video', status: 'failed', basis: 'free',
      externalId: 'fal-oversized', inputTokens: null, outputTokens: null, cachedTokens: null, tokenBased: false, costUsd: 0,
      units: 0, unit: 'billable-units', rateSource: null, pricingVersion: null, artifactId: null, operation: null,
      warnings: ['fal answered HTTP 422 and billed 0 units: video_url: File size exceeds 52428800 bytes'],
      estimateUsd: 0.32, estimateSource: null, estimateRateAsOf: null, actualBasis: 'derived', cacheWriteTokens: null,
      listUsd: null, notebookId: null, cellId: null, jobId: 'op-1', runId: null, createdAt: 1, updatedAt: 1,
    }
    const [row] = buildJobsRows({
      jobs: [job({ type: 'generate_media', state: 'done', usage, notBilledCalls: [rejected, { ...rejected, id: 'call-2', externalId: 'fal-again' }] })],
      plans: [],
      cells,
      now: NOW,
    })
    expect(row?.note).toBe('$0.40 actual · est. $0.77 · 2 calls failed, not billed: fal answered HTTP 422 and billed 0 units: video_url: File size exceeds 52428800 bytes')
  })

  it('marks book-level jobs and surfaces the error code for failures', () => {
    const [row] = buildJobsRows({
      jobs: [job({
        type: 'run_notebook',
        state: 'failed',
        error: { code: 'INTERNAL_ERROR', message: 'Stale notebook revision' },
        attempts: 1,
        maxAttempts: 1,
      })],
      plans: [],
      cells,
      now: NOW,
    })
    expect(row).toMatchObject({
      tone: 'failed',
      band: 'attention',
      target: { tag: null, label: null },
      summary: 'Stale notebook revision',
      errorCode: 'INTERNAL_ERROR',
      attempt: '1/1',
      actions: ['retry'],
    })
    expect(row.errorDetail).toContain('INTERNAL_ERROR · Stale notebook revision')
    expect(row.errorDetail).toContain('operation 01a04b45-50f6-74b1-8ecc-e335eedcf26f')
  })

  it('hides the generic Error code but keeps it in the expanded detail', () => {
    const [row] = buildJobsRows({
      jobs: [job({ state: 'failed', error: { code: 'Error', message: 'Kie failed: credits insufficient' } })],
      plans: [],
      cells,
      now: NOW,
    })
    expect(row.errorCode).toBeNull()
    expect(row.errorDetail).toContain('Error · Kie failed: credits insufficient')
  })

  it('shows the provider and model beside the job when the payload names them', () => {
    const [row] = buildJobsRows({
      jobs: [job({ type: 'transcribe', payload: { provider: 'kie', model: 'whisper-large-v3' } })],
      plans: [],
      cells,
      now: NOW,
    })
    expect(row.detail).toBe('kie · whisper-large-v3')
    expect(row.duration).toBe('0.4s')
    expect(row.actions).toEqual([])
  })

  it('turns an awaiting-output plan into a review row with all four actions', () => {
    const [row] = buildJobsRows({ jobs: [], plans: [plan({})], cells, assets: READY_ASSETS, now: NOW })
    expect(row).toMatchObject({
      tone: 'review',
      band: 'attention',
      statusLabel: 'REVIEW',
      title: 'Generate video',
      detail: 'kie · bytedance/seedance-2-5',
      target: { tag: '@c4', label: 'cat rolls over, slow dolly' },
      summary: 'Output ready — review before inserting',
      note: 'est. $8.19 · output 01a04918',
      actions: ['continue', 'retry', 'switch', 'omit'],
    })
  })

  it('labels a historical fal plan quote as a per-call average', () => {
    const historical = plan({})
    const stage = historical.plan.stages[0]
    if (stage?.kind === 'queued') stage.estimateHistorical = true
    const [row] = buildJobsRows({ jobs: [], plans: [historical], cells, assets: READY_ASSETS, now: NOW })
    expect(row.note).toContain('per-call average $8.19, not this request\'s price')
  })

  it.each([
    { assets: [] },
    { assets: [{ ...READY_ASSETS[0], status: 'generating', mediaUrl: null }] },
    { assets: [{ ...READY_ASSETS[0], status: 'processing' }] },
    { assets: [{ ...READY_ASSETS[0], mediaUrl: null }] },
  ])('keeps unfinished media in progress without offering another paid attempt: %j', ({ assets }) => {
    const [row] = buildJobsRows({ jobs: [], plans: [plan({})], cells, assets, now: NOW })
    expect(row).toMatchObject({
      tone: 'running',
      band: 'running',
      statusLabel: 'RUNNING',
      summary: 'Waiting for generated media',
      live: true,
      actions: [],
    })
  })

  it('keeps retry actions available after a failed generation without offering an unavailable output', () => {
    const [row] = buildJobsRows({
      jobs: [],
      plans: [plan({ status: 'failed', error: 'Provider failed' })],
      cells,
      now: NOW,
    })
    expect(row).toMatchObject({
      tone: 'failed',
      summary: 'Provider failed',
      actions: ['retry', 'switch', 'omit'],
    })
  })

  it('files continued and omitted plans under finished with no retry actions', () => {
    const rows = buildJobsRows({
      jobs: [],
      plans: [plan({ planId: 'p-cont', status: 'continued' }), plan({ planId: 'p-omit', status: 'omitted' })],
      cells,
      now: NOW,
    })
    expect(rows.map((row) => [row.tone, row.band, row.summary, row.actions])).toEqual([
      ['done', 'finished', 'Generation complete', []],
      ['omitted', 'finished', 'Left out of the sequence', []],
    ])
  })
})

describe('groupJobsRows', () => {
  const rows = buildJobsRows({
    jobs: [
      job({ id: 1, state: 'done', finishedAt: NOW - 50_000 }),
      job({ id: 2, state: 'queued', enqueuedAt: NOW - 5_000, startedAt: null, finishedAt: null }),
      job({ id: 3, state: 'queued', enqueuedAt: NOW - 4_000, startedAt: null, finishedAt: null }),
      job({ id: 4, state: 'running', startedAt: NOW - 20_000, finishedAt: null }),
      job({ id: 5, state: 'aborted', error: { code: null, message: 'Cancelled by user' }, finishedAt: NOW - 10_000 }),
      job({ id: 6, state: 'failed', error: { code: 'TIMEOUT', message: 'took too long' }, finishedAt: NOW - 1_000 }),
    ],
    plans: [plan({})],
    assets: READY_ASSETS,
    cells: [],
    now: NOW,
  })
  const bands = groupJobsRows(rows)

  it('orders bands attention, running, queued, finished and numbers the queue', () => {
    expect(bands.map((band) => [band.id, band.rows.map((row) => row.key)])).toEqual([
      ['attention', ['job:6', 'plan:plan-1']],
      ['running', ['job:4']],
      ['queued', ['job:2', 'job:3']],
      ['finished', ['job:5', 'job:1']],
    ])
    expect(bands[2].rows.map((row) => row.summary)).toEqual(['Next up', '1 ahead in queue'])
  })

  it('counts and filters bands for the header chips', () => {
    expect(countJobsBands(bands)).toEqual({ total: 7, attention: 2, active: 3, finished: 2 })
    expect(filterJobsBands(bands, 'active').map((band) => band.id)).toEqual(['running', 'queued'])
    expect(filterJobsBands(bands, 'attention').map((band) => band.id)).toEqual(['attention'])
    expect(filterJobsBands(bands, 'all').map((band) => band.id)).toEqual(['attention', 'running', 'queued', 'finished'])
  })
})
