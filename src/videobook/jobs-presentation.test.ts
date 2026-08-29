import { describe, expect, it } from 'vitest'
import type { NotebookCell } from 'videobook-engine'
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
    const [row] = buildJobsRows({ jobs: [], plans: [plan({})], cells, now: NOW })
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

  it('files continued and omitted plans under finished with no retry actions', () => {
    const rows = buildJobsRows({
      jobs: [],
      plans: [plan({ planId: 'p-cont', status: 'continued' }), plan({ planId: 'p-omit', status: 'omitted' })],
      cells,
      now: NOW,
    })
    expect(rows.map((row) => [row.tone, row.band, row.summary, row.actions])).toEqual([
      ['done', 'finished', 'Inserted into the sequence', []],
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
