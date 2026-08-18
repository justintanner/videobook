import type {
  NotebookCell,
  NotebookCellType,
  NotebookDocument,
} from 'videobook-engine'
import {
  isNotebookExtractMediaCellType,
  isNotebookGenerationCellType,
  isNotebookMediaPresentationCellType,
} from './notebook-cell-types'
import { nonEmptyStringValue, recordValue } from './value-decoders'

const canonicalMediaAspectRatios = [
  ['3:1', 3],
  ['21:9', 21 / 9],
  ['2:1', 2],
  ['16:9', 16 / 9],
  ['3:2', 3 / 2],
  ['4:3', 4 / 3],
  ['5:4', 5 / 4],
  ['1:1', 1],
  ['4:5', 4 / 5],
  ['3:4', 3 / 4],
  ['2:3', 2 / 3],
  ['9:16', 9 / 16],
  ['1:2', 1 / 2],
  ['9:21', 9 / 21],
  ['1:3', 1 / 3],
] as const

const activeStatuses = new Set([
  'analyzing',
  'archiving',
  'awaiting-output',
  'changing-speed',
  'completing',
  'cropping',
  'deleting',
  'downloading',
  'generating',
  'isolating',
  'loading',
  'processing',
  'queued',
  'render-queued',
  'render-queued-landscape',
  'render-queued-portrait',
  'render-queued-square',
  'rendering',
  'rendering-landscape',
  'rendering-portrait',
  'rendering-square',
  'replacing-audio',
  'reversing',
  'running',
  'splicing',
  'transcribing',
  'trimming',
  'uploading',
])

const inspectorActionVerbs: Partial<Record<NotebookCellType, string>> = {
  analyze: 'Analyze',
  concat: 'Concatenate',
  extract_audio: 'Extract',
  extract_frame: 'Extract',
  generate_audio: 'Generate',
  generate_image: 'Generate',
  generate_video: 'Generate',
  prompt: 'Rewrite',
  splice: 'Splice',
  split_video: 'Split',
}

type ActionCell = Pick<
  NotebookCell,
  'model' | 'operation' | 'outputArtifactId' | 'tool' | 'type'
>

export type NotebookCellActionPresentation = {
  disabled: boolean
  label: 'Gen' | 'Re-run' | 'Run'
}

export type NotebookAudioInfo = {
  channelLayout: string
  channels: number
  codec: string
  durationSeconds: number
  sampleRateHz: number
}

export type NotebookAnalysisShot = {
  ordinal: number
  label: string
  startSeconds: number
  endSeconds: number
  durationSeconds: number
}

export type NotebookAnalysisInfo = {
  sourceDurationSeconds: number
  llmExchanges?: NotebookAnalysisLlmExchangeSummary[]
  outputJson?: unknown
  outputUrl?: string | null
  shots: NotebookAnalysisShot[]
}

export type NotebookAnalysisLlmExchangeSummary = {
  model: string
  provider: string
  responseFormat?: NotebookAnalysisResponseFormat | null
  stage: string
}

export type NotebookAnalysisResponseFormat = {
  name: string | null
  strict: boolean
  type: string
}

export type NotebookAnalysisLlmExchange = {
  complete: boolean
  input: unknown
  model: string
  provider: string
  response: unknown
  responseFormat: NotebookAnalysisResponseFormat | null
  stage: string
}

export type NotebookAudioPresentation = {
  details: string[]
  duration: string | null
  role: string
}

export type NotebookSplitFrameIds = {
  first: string | null
  last: string | null
}

export type NotebookCellRunObservation = {
  error: string | null
  state: 'active' | 'completed' | 'error' | 'pending'
  status: string | null
}

export type NotebookCellExecutionObservation = Pick<
  NotebookCellRunObservation,
  'error' | 'status'
>

export type NotebookCellStateOverlay = 'clock' | 'failed' | null

export type NotebookCellStateTone = 'active' | 'queued' | 'error' | null

export type NotebookCellStatePresentation = {
  error: string | null
  label: string | null
  overlay: NotebookCellStateOverlay
  startedAt: number | null
  tone: NotebookCellStateTone
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function hasOwnValue(
  value: Record<string, unknown>,
  key: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

export function notebookCellSupportsExecution(cell: ActionCell): boolean {
  return cell.type !== 'analysis'
    && !isNotebookMediaPresentationCellType(cell.type)
    && Boolean(cell.operation ?? cell.tool ?? cell.model)
}

export function notebookCellPresentsMedia(cell: ActionCell): boolean {
  if (!cell.outputArtifactId) return false
  return isNotebookMediaPresentationCellType(cell.type)
    || isNotebookExtractMediaCellType(cell.type)
}

export function notebookCellIsActiveStatus(status: string): boolean {
  return activeStatuses.has(status)
}

export function notebookCellClockLabel(
  status: string,
  kind: NotebookCellType,
): string {
  if (status === 'analyzing') return 'ANALYZING'
  if (status === 'archiving') return 'ARCHIVING'
  if (status === 'changing-speed') return 'CHANGING SPEED'
  if (status === 'queued') return 'QUEUED'
  if (status === 'completing') return 'FINISHING'
  if (status === 'cropping') return 'CROPPING'
  if (status === 'deleting') return 'DELETING'
  if (status === 'downloading') return 'DOWNLOADING'
  if (status === 'generating') return 'GENERATING'
  if (status === 'isolating') return 'ISOLATING VOCALS'
  if (status === 'loading') return 'LOADING'
  if (status === 'processing') return 'PROCESSING'
  if (status.startsWith('render-queued')) return 'QUEUED TO RENDER'
  if (status.startsWith('rendering')) return 'RENDERING'
  if (status === 'replacing-audio') return 'REPLACING AUDIO'
  if (status === 'reversing') return 'REVERSING'
  if (status === 'splicing') return 'SPLICING'
  if (status === 'transcribing') return 'TRANSCRIBING'
  if (status === 'trimming') return 'TRIMMING'
  if (status === 'uploading') return 'UPLOADING'
  if (status === 'awaiting-output') return 'GENERATING'
  if (kind.startsWith('generate_')) return 'GENERATING'
  if (kind === 'analyze') return 'ANALYZING'
  if (kind.startsWith('extract_')) return 'EXTRACTING'
  if (kind === 'split_video') return 'SPLITTING'
  if (kind === 'splice') return 'SPLICING'
  if (kind === 'concat') return 'CONCATENATING'
  if (kind === 'prompt') return 'REWRITING'
  return 'RUNNING'
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || value.length === 0) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function notebookCellStateFromStatus(
  kind: NotebookCellType,
  status: string,
  options?: {
    error?: string | null
    startedAt?: string | number | null
  },
): NotebookCellStatePresentation {
  // Only an error *status* selects the failed overlay. A leftover error
  // string alongside an active status is stale client state from the previous
  // attempt (re-queue overrides status but not the recorded error) and must
  // not outrank the new run's clock.
  if (status === 'error') {
    return {
      overlay: 'failed',
      label: null,
      startedAt: null,
      error: options?.error
        ?? (isNotebookMediaPresentationCellType(kind)
          ? 'Media processing failed'
          : 'Generation failed'),
      tone: 'error',
    }
  }

  if (notebookCellIsActiveStatus(status)) {
    return {
      overlay: 'clock',
      label: notebookCellClockLabel(status, kind),
      startedAt: parseTimestamp(options?.startedAt),
      error: null,
      tone: status === 'queued' ? 'queued' : 'active',
    }
  }

  return {
    overlay: null,
    label: null,
    startedAt: null,
    error: null,
    tone: null,
  }
}

export function notebookCellStatePresentation(
  document: Pick<NotebookDocument, 'execution'>,
  cellId: string,
  kind: NotebookCellType,
  options?: {
    error?: string | null
    status?: string | null
  },
): NotebookCellStatePresentation {
  const execution = recordValue(document.execution)
  const cell = execution && recordValue(execution[cellId])
  const status = options?.status
    ?? nonEmptyStringValue(cell?.status)
    ?? 'ready'
  const error = options?.error !== undefined
    ? options.error
    : nonEmptyStringValue(cell?.error)
  const startedAt = parseTimestamp(cell?.startedAt)
    ?? parseTimestamp(cell?.updatedAt)
  return notebookCellStateFromStatus(kind, status, { error, startedAt })
}

export function notebookCellExecutionObservation(
  document: Pick<NotebookDocument, 'execution'>,
  cellId: string,
): NotebookCellExecutionObservation {
  const execution = recordValue(document.execution)
  const cell = execution && recordValue(execution[cellId])
  return {
    error: nonEmptyStringValue(cell?.error),
    status: nonEmptyStringValue(cell?.status),
  }
}

export function notebookCellRunObservation(
  document: Pick<NotebookDocument, 'execution'>,
  cellId: string,
  runId: string,
): NotebookCellRunObservation {
  const execution = recordValue(document.execution)
  const cell = execution && recordValue(execution[cellId])
  if (!cell || nonEmptyStringValue(cell.runId) !== runId) {
    return { error: null, state: 'pending', status: null }
  }
  const status = nonEmptyStringValue(cell.status)
  const error = nonEmptyStringValue(cell.error)
  if (error || status === 'error') {
    return { error, state: 'error', status }
  }
  if (status === 'completed') {
    return { error: null, state: 'completed', status }
  }
  return {
    error: null,
    state: status && notebookCellIsActiveStatus(status) ? 'active' : 'pending',
    status,
  }
}

export function notebookCellActionPresentation(
  cell: ActionCell,
  status: string,
): NotebookCellActionPresentation | null {
  if (!notebookCellSupportsExecution(cell)) return null
  const disabled = notebookCellIsActiveStatus(status)
  if (isNotebookGenerationCellType(cell.type)) {
    return { disabled, label: 'Gen' }
  }
  return {
    disabled,
    label: cell.outputArtifactId || status === 'completed' || status === 'error'
      ? 'Re-run'
      : 'Run',
  }
}

export function notebookCellInspectorActionLabel(
  type: NotebookCellType,
  label: NotebookCellActionPresentation['label'],
): string {
  const verb = inspectorActionVerbs[type]
  if (!verb) return label
  return label === 'Re-run' ? `${verb} again` : verb
}

export function notebookCellStatusLabel(
  type: NotebookCellType,
  status: string,
): string | null {
  return isNotebookMediaPresentationCellType(type) ? null : status
}

export function formatMediaTime(seconds: number): string {
  const hundredths = Math.round(Math.max(0, seconds) * 100)
  const minutes = Math.floor(hundredths / 6000)
  const remainingHundredths = hundredths - minutes * 6000
  const wholeSeconds = Math.floor(remainingHundredths / 100)
  const fraction = remainingHundredths % 100
  const formattedSeconds = String(wholeSeconds).padStart(2, '0')
  return fraction === 0
    ? `${minutes}:${formattedSeconds}`
    : `${minutes}:${formattedSeconds}.${String(fraction).padStart(2, '0')}`
}

function greatestCommonDivisor(left: number, right: number): number {
  let first = Math.abs(Math.round(left))
  let second = Math.abs(Math.round(right))
  while (second > 0) {
    const remainder = first % second
    first = second
    second = remainder
  }
  return first
}

export function formatMediaAspectRatio(
  width: number | null,
  height: number | null,
): string | null {
  if (
    width === null
    || height === null
    || !Number.isFinite(width)
    || !Number.isFinite(height)
    || width <= 0
    || height <= 0
  ) return null
  const ratio = width / height
  const nearest = canonicalMediaAspectRatios.reduce((best, candidate) =>
    Math.abs(candidate[1] - ratio) < Math.abs(best[1] - ratio)
      ? candidate
      : best)
  if (Math.abs(nearest[1] - ratio) / ratio <= 0.03) return nearest[0]
  const roundedWidth = Math.round(width)
  const roundedHeight = Math.round(height)
  if (roundedWidth < 1 || roundedHeight < 1) return null
  const divisor = greatestCommonDivisor(roundedWidth, roundedHeight)
  return `${roundedWidth / divisor}:${roundedHeight / divisor}`
}

export function notebookCellMediaCaption(input: {
  type: NotebookCellType
  hasMedia: boolean
  prompt: string | null
  tool: string | null
  model: string | null
}): { prompt: string; tool: string | null; model: string | null } | null {
  if (input.type !== 'image' || !input.hasMedia || !input.prompt) return null
  return {
    prompt: input.prompt,
    tool: input.tool,
    model: input.model,
  }
}

export function notebookAudioPresentation(input: {
  audioInfo: NotebookAudioInfo | null
  durationSeconds: number | null
  hasOutput: boolean
  inputs: Record<string, unknown> | undefined
}): NotebookAudioPresentation {
  const start = finiteNumber(input.inputs?.startSeconds)
  const end = finiteNumber(input.inputs?.endSeconds)
  const inputDuration = finiteNumber(input.inputs?.durationSeconds)
  const duration = input.audioInfo?.durationSeconds
    ?? input.durationSeconds
    ?? inputDuration
    ?? (start !== null && end !== null && end > start ? end - start : null)
  const role = input.inputs?.audioRole === 'continuous-source'
    ? 'Continuous source'
    : input.inputs?.audioRole === 'scene'
      ? 'Scene audio'
      : input.hasOutput
        ? 'Audio output'
        : 'Select audio media'
  return {
    role,
    duration: duration !== null && duration > 0 ? formatMediaTime(duration) : null,
    details: [
      input.audioInfo?.codec.toUpperCase() ?? null,
      input.audioInfo ? `${input.audioInfo.sampleRateHz / 1000} kHz` : null,
      input.audioInfo?.channelLayout ?? null,
    ].filter((value): value is string => Boolean(value)),
  }
}

export function notebookAudioSummary(
  input: Parameters<typeof notebookAudioPresentation>[0],
): string {
  const presentation = notebookAudioPresentation(input)
  return [
    presentation.role,
    presentation.duration,
    ...presentation.details,
  ].filter((value): value is string => Boolean(value)).join(' · ')
}

export function notebookOutputVersionArtifactIds(
  inputs: Record<string, unknown> | undefined,
  outputArtifactId: string | undefined,
): string[] {
  const persisted = Array.isArray(inputs?.outputVersionArtifactIds)
    ? inputs.outputVersionArtifactIds.filter(
        (value): value is string => typeof value === 'string' && value.length > 0,
      )
    : []
  return [...new Set([
    ...persisted,
    ...(outputArtifactId ? [outputArtifactId] : []),
  ])]
}

function notebookAnalysisResponseFormat(
  input: unknown,
): NotebookAnalysisResponseFormat | null {
  const request = recordValue(input)
  const text = request && recordValue(request.text)
  const format = text && recordValue(text.format)
  const type = nonEmptyStringValue(format?.type)
  if (!type) return null
  return {
    name: nonEmptyStringValue(format?.name),
    strict: format?.strict === true,
    type,
  }
}

export function notebookAnalysisLlmExchanges(
  outputJson: unknown,
): NotebookAnalysisLlmExchange[] {
  const output = recordValue(outputJson)
  if (!output) return []
  const recorded = Array.isArray(output.llmExchanges)
    ? output.llmExchanges
    : []
  const exchanges = recorded.flatMap((value, index) => {
    const exchange = recordValue(value)
    if (
      !exchange
      || !hasOwnValue(exchange, 'input')
      || !hasOwnValue(exchange, 'response')
    ) {
      return []
    }
    const input = recordValue(exchange.input)
    return [{
      complete: true,
      input: exchange.input,
      model: nonEmptyStringValue(exchange.model)
        ?? nonEmptyStringValue(input?.model)
        ?? 'Unknown',
      provider: nonEmptyStringValue(exchange.provider) ?? 'Unknown',
      response: exchange.response,
      responseFormat: notebookAnalysisResponseFormat(exchange.input),
      stage: nonEmptyStringValue(exchange.stage) ?? `call_${index + 1}`,
    }]
  })
  if (exchanges.length > 0) return exchanges

  const request = recordValue(output.request)
  if (
    !request
    || !hasOwnValue(output, 'raw')
  ) {
    return []
  }
  return [{
    complete: false,
    input: request,
    model: nonEmptyStringValue(request.model) ?? 'Unknown',
    provider: nonEmptyStringValue(request.provider) ?? 'Unknown',
    response: output.raw,
    responseFormat: null,
    stage: 'legacy_analysis',
  }]
}

export function notebookSplitFrameIds(
  inputs: Record<string, unknown> | undefined,
): NotebookSplitFrameIds {
  return {
    first: nonEmptyStringValue(inputs?.firstFrameArtifactId),
    last: nonEmptyStringValue(inputs?.lastFrameArtifactId),
  }
}

export function notebookSplitRange(
  inputs: Record<string, unknown> | undefined,
): { startSeconds: number; endSeconds: number } | null {
  const startSeconds = finiteNumber(inputs?.startSeconds)
  const endSeconds = finiteNumber(inputs?.endSeconds)
  return startSeconds !== null && endSeconds !== null && endSeconds > startSeconds
    ? { startSeconds, endSeconds }
    : null
}
