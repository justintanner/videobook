// What the generating inspector shows about an in-flight provider request:
// the persisted payload plus the pending task that tracks it. Parsed from the
// inspect_generation_request tool result; everything else is derived.

import { parseProviderTaskStatus, type ProviderTaskStatus } from '../../server/src/provider-status-link'

export type GenerationRequestTask = {
  taskId: string
  submittedAt: string
  completing: boolean
}

export type HarCaptureMode = 'off' | 'failures' | 'all'

export type GenerationHarStatus = {
  mode: HarCaptureMode
  hasCapture: boolean
  captures: number
  path: string | null
  outcome: string | null
}

export type GenerationRequestInspection = {
  payload: unknown
  taskType: string | null
  task: GenerationRequestTask | null
  errorMessage: string | null
  providerTask?: ProviderTaskStatus | null
  har?: GenerationHarStatus | null
}

export type GenerationPayloadSetting = {
  key: string
  value: string
}

type JsonRecord = Record<string, unknown>

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

function parseTask(value: unknown): GenerationRequestTask | null {
  const record = asRecord(value)
  const taskId = asText(record?.taskId)
  const submittedAt = asText(record?.submittedAt)
  if (!record || !taskId || !submittedAt) return null
  return { taskId, submittedAt, completing: record.completing === true }
}

function parseHarCaptureMode(value: unknown): HarCaptureMode | null {
  return value === 'off' || value === 'failures' || value === 'all' ? value : null
}

function parseGenerationHarStatus(value: unknown): GenerationHarStatus | null {
  const record = asRecord(value)
  const mode = parseHarCaptureMode(record?.mode)
  if (!record || !mode) return null
  return {
    mode,
    hasCapture: record.hasCapture === true,
    captures: typeof record.captures === 'number' ? record.captures : 0,
    path: asText(record.path),
    outcome: asText(record.outcome),
  }
}

export function parseGenerationRequestInspection(
  value: unknown,
): GenerationRequestInspection {
  const record = asRecord(value) ?? {}
  const providerTask = parseProviderTaskStatus(record.providerTask)
  const har = parseGenerationHarStatus(record.har)
  return {
    payload: record.payload ?? null,
    taskType: asText(record.taskType),
    task: parseTask(record.task),
    errorMessage: asText(asRecord(record.error)?.message),
    ...(providerTask ? { providerTask } : {}),
    ...(har ? { har } : {}),
  }
}

/** Provider bodies nest generation fields under `input`, or keep them flat. */
function payloadFields(payload: unknown): JsonRecord | null {
  const record = asRecord(payload)
  if (!record) return null
  return asRecord(record.input) ?? record
}

/** The prompt exactly as the provider received it. */
export function generationPayloadSentPrompt(payload: unknown): string | null {
  return asText(payloadFields(payload)?.prompt)
    ?? asText(asRecord(payload)?.prompt)
}

const OMITTED_SETTING_KEYS = new Set(['prompt', 'model', 'callBackUrl'])

function settingValue(value: unknown): string | null {
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  if (typeof value !== 'string' || !value) return null
  return /^https?:\/\//i.test(value) ? null : value
}

/** Scalar generation knobs (duration, aspect ratio, seed…) in payload order. */
export function generationPayloadSettings(
  payload: unknown,
): GenerationPayloadSetting[] {
  const fields = payloadFields(payload)
  if (!fields) return []
  return Object.entries(fields).flatMap(([key, raw]) => {
    if (OMITTED_SETTING_KEYS.has(key)) return []
    const value = settingValue(raw)
    return value === null ? [] : [{ key, value }]
  })
}

export type GeneratingTimelineStepStatus = 'done' | 'active' | 'pending' | 'failed'

export type GeneratingTimelineStep = {
  id: 'started' | 'submitted' | 'generating' | 'landing'
  label: string
  status: GeneratingTimelineStepStatus
  /** ISO time the step began, when known. */
  at: string | null
}

type GeneratingTimelineInput = {
  runKind: 'queued' | 'generating' | 'failed'
  startedAt: string | null
  task: GenerationRequestTask | null
}

function baseTimelineStatuses(
  input: GeneratingTimelineInput,
): GeneratingTimelineStepStatus[] {
  if (input.runKind === 'queued') return ['active', 'pending', 'pending', 'pending']
  if (!input.task) return ['done', 'active', 'pending', 'pending']
  if (input.task.completing) return ['done', 'done', 'done', 'active']
  return ['done', 'done', 'active', 'pending']
}

/** Run → provider submit → provider work → download and commit. */
export function generatingTimeline(
  input: GeneratingTimelineInput,
): GeneratingTimelineStep[] {
  const statuses = baseTimelineStatuses(input)
  const failedAt = input.runKind === 'failed'
    ? statuses.findIndex((status) => status === 'active')
    : -1
  const steps: Omit<GeneratingTimelineStep, 'status'>[] = [
    { id: 'started', label: 'Run started', at: input.startedAt },
    { id: 'submitted', label: 'Submitted', at: input.task?.submittedAt ?? null },
    { id: 'generating', label: 'Provider generating', at: input.task?.submittedAt ?? null },
    { id: 'landing', label: 'Download & commit', at: null },
  ]
  return steps.map((step, index) => ({
    ...step,
    status: index === failedAt ? 'failed' : statuses[index] ?? 'pending',
  }))
}
