import type {
  NotebookCell,
  NotebookCellType,
  NotebookDocument,
} from 'videobook-engine'

const mediaCellTypes = new Set<NotebookCellType>([
  'audio',
  'image',
  'video',
  'character',
])

const generationCellTypes = new Set<NotebookCellType>([
  'generate_audio',
  'generate_image',
  'generate_video',
])

const cellSlugPrefixes = {
  audio: 'aud',
  image: 'img',
  video: 'vid',
  character: 'char',
  extract_audio: 'extract-audio',
  split_video: 'split-video',
  prompt: 'prompt',
  analyze: 'analyze',
  analysis: 'analysis',
  generate_video: 'generate-video',
  generate_image: 'generate-image',
  generate_audio: 'generate-audio',
  concat: 'concat',
  splice: 'splice',
} satisfies Record<NotebookCellType, string>

const activeStatuses = new Set([
  'awaiting-output',
  'completing',
  'queued',
  'running',
])

const inspectorActionVerbs: Partial<Record<NotebookCellType, string>> = {
  analyze: 'Analyze',
  concat: 'Concatenate',
  extract_audio: 'Extract',
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
  shots: NotebookAnalysisShot[]
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

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function isNotebookMediaCellType(type: NotebookCellType): boolean {
  return mediaCellTypes.has(type)
}

export function isNotebookGenerationCellType(type: NotebookCellType): boolean {
  return generationCellTypes.has(type)
}

export function notebookCellSlugPrefix(type: NotebookCellType): string {
  return cellSlugPrefixes[type]
}

export function notebookCellSupportsExecution(cell: ActionCell): boolean {
  return cell.type !== 'analysis'
    && !isNotebookMediaCellType(cell.type)
    && Boolean(cell.operation ?? cell.tool ?? cell.model)
}

export function notebookCellIsActiveStatus(status: string): boolean {
  return activeStatuses.has(status)
}

export function notebookCellExecutionObservation(
  document: Pick<NotebookDocument, 'execution'>,
  cellId: string,
): NotebookCellExecutionObservation {
  const execution = objectValue(document.execution)
  const cell = execution && objectValue(execution[cellId])
  return {
    error: stringValue(cell?.error),
    status: stringValue(cell?.status),
  }
}

export function notebookCellRunObservation(
  document: Pick<NotebookDocument, 'execution'>,
  cellId: string,
  runId: string,
): NotebookCellRunObservation {
  const execution = objectValue(document.execution)
  const cell = execution && objectValue(execution[cellId])
  if (!cell || stringValue(cell.runId) !== runId) {
    return { error: null, state: 'pending', status: null }
  }
  const status = stringValue(cell.status)
  const error = stringValue(cell.error)
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
  return isNotebookMediaCellType(type) ? null : status
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

export function notebookSplitFrameIds(
  inputs: Record<string, unknown> | undefined,
): NotebookSplitFrameIds {
  return {
    first: stringValue(inputs?.firstFrameArtifactId),
    last: stringValue(inputs?.lastFrameArtifactId),
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
