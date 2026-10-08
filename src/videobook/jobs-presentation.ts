import type { NotebookCell } from 'videobook-engine'
import type { CommandPlan } from '@/videobook/command-plan'
import { notebookGridTag } from '@/videobook/notebook-grid'
import { isPublishedPostCell } from '@/videobook/notebook-published-post'
import type { ProviderTaskStatus } from '../../server/src/provider-status-link'

export interface JobsScreenJob {
  providerTask?: ProviderTaskStatus | null
  id: number
  operationId: string
  type: string
  state: string
  artifactId: string | null
  attempts: number
  maxAttempts: number
  error: { message: string; code: string | null } | null
  payload: Record<string, unknown> | null
  enqueuedAt: number
  startedAt: number | null
  finishedAt: number | null
}

export interface JobsScreenPlan {
  planId: string
  cellId: string
  status: string
  plan: CommandPlan
  outputArtifactId: string | null
  error: string | null
  createdAt: string
  updatedAt: string
}

export interface JobsScreenAsset {
  artifactId: string
  status: string
  mediaUrl: string | null
}

export type JobsRowTone =
  | 'review'
  | 'failed'
  | 'running'
  | 'queued'
  | 'done'
  | 'cancelled'
  | 'omitted'

type JobsBandId = 'attention' | 'running' | 'queued' | 'finished'

export type JobsRowAction = 'continue' | 'retry' | 'switch' | 'omit' | 'cancel'

export type JobsFilter = 'all' | 'attention' | 'active' | 'finished'

type JobsRowSource =
  | { kind: 'job'; jobId: number }
  | { kind: 'plan'; planId: string }

interface JobsRowTarget {
  tag: string | null
  label: string | null
}

export interface JobsRow {
  providerTask?: ProviderTaskStatus | null
  key: string
  source: JobsRowSource
  tone: JobsRowTone
  band: JobsBandId
  statusLabel: string
  title: string
  detail: string | null
  target: JobsRowTarget
  summary: string
  note: string | null
  errorCode: string | null
  errorDetail: string | null
  attempt: string
  timestamp: number
  sortAt: number
  duration: string | null
  live: boolean
  actions: JobsRowAction[]
}

export interface JobsBand {
  id: JobsBandId
  label: string
  rows: JobsRow[]
}

export interface JobsCounts {
  total: number
  attention: number
  active: number
  finished: number
}

const JOB_TITLES: Record<string, string> = {
  run_notebook: 'Run notebook',
  semantic_index: 'Semantic index',
  extract_waveform: 'Extract waveform',
  extract_video_poster: 'Create video poster',
  extract_audio: 'Extract audio',
  transcribe: 'Transcribe',
}

const BAND_LABELS: Record<JobsBandId, string> = {
  attention: 'Needs attention',
  running: 'Running',
  queued: 'Queued',
  finished: 'Finished',
}

const BAND_ORDER: JobsBandId[] = ['attention', 'running', 'queued', 'finished']

export function humanizeJobType(type: string): string {
  const known = JOB_TITLES[type]
  if (known) return known
  const words = type.replace(/[_-]+/g, ' ').trim()
  if (words.length === 0) return type
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export function formatDuration(ms: number): string {
  const clamped = Math.max(0, ms)
  if (clamped < 10_000) return `${(clamped / 1000).toFixed(1)}s`
  const totalSeconds = Math.round(clamped / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
}

function shortArtifactId(artifactId: string): string {
  return artifactId.slice(0, 8)
}

function jobRowTone(state: string): JobsRowTone {
  switch (state) {
    case 'queued': return 'queued'
    case 'running':
    case 'completing': return 'running'
    case 'failed': return 'failed'
    case 'aborted': return 'cancelled'
    default: return 'done'
  }
}

function planRowTone(status: string, outputReady: boolean): JobsRowTone {
  switch (status) {
    case 'awaiting-output': return outputReady ? 'review' : 'running'
    case 'failed': return 'failed'
    case 'queued': return 'queued'
    case 'omitted': return 'omitted'
    default: return 'done'
  }
}

function toneBand(tone: JobsRowTone): JobsBandId {
  switch (tone) {
    case 'review':
    case 'failed': return 'attention'
    case 'running': return 'running'
    case 'queued': return 'queued'
    default: return 'finished'
  }
}

function toneStatusLabel(tone: JobsRowTone): string {
  return tone.toUpperCase()
}

function cellTarget(cell: NotebookCell | undefined): JobsRowTarget {
  if (!cell) return { tag: null, label: null }
  return {
    tag: notebookGridTag(cell.slot),
    label: cell.label ?? cell.prompt ?? null,
  }
}

function jobTarget(job: JobsScreenJob, cells: NotebookCell[]): JobsRowTarget {
  if (!job.artifactId) return { tag: null, label: null }
  const cell = cells.find((candidate) =>
    !isPublishedPostCell(candidate)
    && candidate.outputArtifactId === job.artifactId)
  if (cell) return cellTarget(cell)
  return { tag: null, label: `artifact ${shortArtifactId(job.artifactId)}` }
}

function payloadString(payload: Record<string, unknown> | null, key: string): string | null {
  const value = payload?.[key]
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function jobDetail(job: JobsScreenJob): string | null {
  const parts = [payloadString(job.payload, 'provider'), payloadString(job.payload, 'model')]
    .filter((part): part is string => part !== null)
  return parts.length > 0 ? parts.join(' · ') : null
}

function jobActions(state: string): JobsRowAction[] {
  if (state === 'queued' || state === 'running' || state === 'completing') return ['cancel']
  if (state === 'failed' || state === 'aborted') return ['retry']
  return []
}

function jobSummary(job: JobsScreenJob, now: number): Pick<JobsRow, 'summary' | 'note' | 'duration' | 'live'> {
  const runningFor = job.startedAt === null
    ? null
    : formatDuration((job.finishedAt ?? now) - job.startedAt)
  switch (job.state) {
    case 'queued':
      return {
        summary: 'Waiting for a worker',
        note: `waiting ${formatDuration(now - job.enqueuedAt)}`,
        duration: null,
        live: false,
      }
    case 'running':
      return {
        summary: `${humanizeJobType(job.type)} in progress`,
        note: runningFor ? `${runningFor} elapsed` : null,
        duration: null,
        live: true,
      }
    case 'completing':
      return {
        summary: 'Finishing up',
        note: runningFor ? `${runningFor} elapsed` : null,
        duration: null,
        live: true,
      }
    case 'failed':
      return {
        summary: job.error?.message ?? 'Failed without an error message',
        note: null,
        duration: runningFor,
        live: false,
      }
    case 'aborted':
      return {
        summary: job.error?.message ?? 'Cancelled',
        note: 'nothing was written',
        duration: runningFor,
        live: false,
      }
    default:
      return {
        summary: 'Completed',
        note: null,
        duration: runningFor,
        live: false,
      }
  }
}

function jobErrorCode(job: JobsScreenJob): string | null {
  const code = job.error?.code ?? null
  return code && code !== 'Error' ? code : null
}

function jobRow(job: JobsScreenJob, cells: NotebookCell[], now: number): JobsRow {
  const tone = jobRowTone(job.state)
  const statusLabel = tone === 'done' && job.state !== 'done'
    ? job.state.toUpperCase()
    : toneStatusLabel(tone)
  const errorDetail = job.error
    ? [
        `${job.error.code ? `${job.error.code} · ` : ''}${job.error.message}`,
        `operation ${job.operationId} · enqueued ${new Date(job.enqueuedAt).toLocaleString()}`,
      ].join('\n')
    : null
  return {
    key: `job:${job.id}`,
    providerTask: job.providerTask,
    source: { kind: 'job', jobId: job.id },
    tone,
    band: toneBand(tone),
    statusLabel,
    title: humanizeJobType(job.type),
    detail: jobDetail(job),
    target: jobTarget(job, cells),
    ...jobSummary(job, now),
    errorCode: jobErrorCode(job),
    errorDetail,
    attempt: `${job.attempts}/${job.maxAttempts}`,
    timestamp: job.enqueuedAt,
    sortAt: job.finishedAt ?? job.startedAt ?? job.enqueuedAt,
    actions: jobActions(job.state),
  }
}

function planStage(plan: JobsScreenPlan) {
  const stage = plan.plan.stages.find((candidate) =>
    candidate.kind === 'queued' && candidate.jobType === 'generation')
  return stage?.kind === 'queued' ? stage : null
}

function planActions(plan: JobsScreenPlan, outputReady: boolean): JobsRowAction[] {
  const actions: JobsRowAction[] = []
  if (outputReady && plan.status !== 'continued' && plan.status !== 'omitted') {
    actions.push('continue')
  }
  if (plan.status === 'failed' || (plan.status === 'awaiting-output' && outputReady)) {
    actions.push('retry', 'switch', 'omit')
  }
  return actions
}

function planCostNote(plan: JobsScreenPlan): string | null {
  const stage = planStage(plan)
  const parts: string[] = []
  if (stage?.estimatedCostUsd !== undefined) parts.push(`est. $${stage.estimatedCostUsd.toFixed(2)}`)
  if (plan.outputArtifactId) parts.push(`output ${shortArtifactId(plan.outputArtifactId)}`)
  return parts.length > 0 ? parts.join(' · ') : null
}

function planSummary(plan: JobsScreenPlan, outputReady: boolean): Pick<JobsRow, 'summary' | 'note'> {
  const note = planCostNote(plan)
  switch (plan.status) {
    case 'awaiting-output':
      return {
        summary: outputReady
          ? 'Output ready — review before inserting'
          : 'Waiting for generated media',
        note,
      }
    case 'failed':
      return { summary: plan.error ?? 'Generation failed', note }
    case 'queued':
      return { summary: 'Generation queued', note }
    case 'continued':
      return { summary: 'Generation complete', note }
    case 'omitted':
      return {
        summary: 'Left out of the sequence',
        note: plan.outputArtifactId ? `output kept as ${shortArtifactId(plan.outputArtifactId)}` : null,
      }
    default:
      return { summary: 'Generation finished', note }
  }
}

function parsePlanTime(value: string): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function planTitle(
  plan: JobsScreenPlan,
  cell: NotebookCell | undefined,
  stage: ReturnType<typeof planStage>,
): string {
  if (cell?.type.startsWith('generate_')) return humanizeJobType(cell.type)
  if (stage) return 'Generate'
  return plan.plan.summary
}

function planRow(
  plan: JobsScreenPlan,
  cells: NotebookCell[],
  assets: JobsScreenAsset[],
): JobsRow {
  const outputReady = assets.some((asset) =>
    asset.artifactId === plan.outputArtifactId
    && asset.status === 'ready'
    && Boolean(asset.mediaUrl))
  const tone = planRowTone(plan.status, outputReady)
  const stage = planStage(plan)
  const cell = cells.find((candidate) => candidate.id === plan.cellId)
  const detail = stage
    ? [stage.provider, stage.model ?? stage.tool].filter((part): part is string => Boolean(part)).join(' · ')
    : null
  return {
    key: `plan:${plan.planId}`,
    source: { kind: 'plan', planId: plan.planId },
    tone,
    band: toneBand(tone),
    statusLabel: toneStatusLabel(tone),
    title: planTitle(plan, cell, stage),
    detail: detail && detail.length > 0 ? detail : null,
    target: cellTarget(cell),
    ...planSummary(plan, outputReady),
    errorCode: null,
    errorDetail: plan.error,
    attempt: '1/1',
    timestamp: parsePlanTime(plan.createdAt),
    sortAt: parsePlanTime(plan.updatedAt) || parsePlanTime(plan.createdAt),
    duration: null,
    live: tone === 'running',
    actions: planActions(plan, outputReady),
  }
}

interface BuildJobsRowsInput {
  jobs: JobsScreenJob[]
  plans: JobsScreenPlan[]
  cells: NotebookCell[]
  assets?: JobsScreenAsset[]
  now: number
}

export function buildJobsRows({ jobs, plans, cells, assets = [], now }: BuildJobsRowsInput): JobsRow[] {
  return [
    ...plans.map((plan) => planRow(plan, cells, assets)),
    ...jobs.map((job) => jobRow(job, cells, now)),
  ]
}

function withQueuePositions(rows: JobsRow[]): JobsRow[] {
  return rows.map((row, index) => ({
    ...row,
    summary: index === 0 ? 'Next up' : `${index} ahead in queue`,
  }))
}

function sortBand(id: JobsBandId, rows: JobsRow[]): JobsRow[] {
  switch (id) {
    case 'running':
      return [...rows].sort((a, b) => a.sortAt - b.sortAt)
    case 'queued':
      return withQueuePositions([...rows].sort((a, b) => a.timestamp - b.timestamp))
    default:
      return [...rows].sort((a, b) => b.sortAt - a.sortAt)
  }
}

export function groupJobsRows(rows: JobsRow[]): JobsBand[] {
  return BAND_ORDER.map((id) => ({
    id,
    label: BAND_LABELS[id],
    rows: sortBand(id, rows.filter((row) => row.band === id)),
  }))
}

export function countJobsBands(bands: JobsBand[]): JobsCounts {
  const size = (id: JobsBandId) => bands.find((band) => band.id === id)?.rows.length ?? 0
  const attention = size('attention')
  const active = size('running') + size('queued')
  const finished = size('finished')
  return { total: attention + active + finished, attention, active, finished }
}

export function filterJobsBands(bands: JobsBand[], filter: JobsFilter): JobsBand[] {
  if (filter === 'all') return bands.filter((band) => band.rows.length > 0)
  const wanted: JobsBandId[] = filter === 'attention'
    ? ['attention']
    : filter === 'active'
      ? ['running', 'queued']
      : ['finished']
  return bands.filter((band) => wanted.includes(band.id) && band.rows.length > 0)
}
