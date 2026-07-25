import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react'
import {
  Background,
  Handle,
  Panel,
  Position,
  ReactFlow,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type FitViewOptions,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react'
import {
  Activity,
  AudioWaveform,
  BookOpen,
  Check,
  ChevronDown,
  CircleDot,
  Film,
  Image,
  Library,
  LoaderCircle,
  Mic,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  RefreshCw,
  Settings,
  Sparkles,
  Square,
  Trash2,
  Undo2,
  Video,
} from 'lucide-react'
import { useMcp } from 'use-mcp/react'
import type {
  EditPreview,
  NotebookCellReference,
  NotebookCellType,
  NotebookDocument,
  PinnedSearchResult,
  Sequence,
  TimedSequenceClip,
} from 'videobook-engine'
import {
  adaptCommandArgs,
  parseCommandArgs,
  selectCommandForInput,
  type CommandToolArgs,
  type ServerCommand,
} from '@/lib/command-registry'
import {
  CommandComposer,
  type ComposerOutcome,
} from '@/components/videobook/CommandComposer'
import { NotebookStageBoard } from '@/components/videobook/NotebookStageBoard'
import { MomentSearch } from '@/components/videobook/MomentSearch'
import {
  CanonicalSequencePlayer,
  type TimelineKeyboardAction,
} from '@/components/videobook/CanonicalSequencePlayer'
import {
  notebookEdges,
  notebookNodes,
  type NotebookCellData,
} from '@/videobook/notebook-draft'
import {
  validateCommandPlan,
  type CommandPlan,
  type EditCommandStage,
} from '@/videobook/command-plan'
import {
  nextNotebookGridSlot,
  notebookGridPosition,
  notebookGridSlot,
  resolveNotebookGridMove,
  type NotebookGridSlot,
} from '@/videobook/notebook-grid'
import type { InitialWorkspacePayload } from '@/videobook/initial-workspace'

type Screen = 'notebook' | 'library' | 'timeline' | 'jobs' | 'settings'

type ToolResponse = {
  content?: Array<{ type: string; text?: string }>
  isError?: boolean
}

type BookSummary = {
  bookId: string
  slug: string
  createdAt: number
  artifactCount: number
  notebookCount: number
}

type AssetRecord = {
  id: string
  artifactId: string
  type: string
  createdAt: string
  mediaUrl: string | null
  thumbnailUrl: string | null
  status: string
  prompt: string | null
  width: number | null
  height: number | null
}

type IngestStatus = {
  artifactId: string
  state: string
  missingOutputs: string[]
  phases: Record<string, string>
}

type AudioTranscriptWord = {
  wordId: string
  startTick: number
  durationTicks: number
  text: string
  confidence?: number
  corrected: boolean
}

type AudioTranscriptSegment = {
  segmentId: string
  text: string
  speaker?: string
  kind: string
  range: {
    timeBase: { numerator: number; denominator: number }
  }
  words: AudioTranscriptWord[]
}

type AudioNotebookState = {
  spine: {
    artifactId: string
    slug: string
    kind: string
  } | null
  waveform: number[] | null
  transcript: {
    transcriptId: string
    language: string
    segments: AudioTranscriptSegment[]
  } | null
}

type TranscriptEditRecord = {
  actionId: string
  kind: string
  restored: boolean
}

type PendingCommandPlan = {
  plan: CommandPlan
  previews: Record<string, EditPreview>
}

type JobRecord = {
  id: number
  operationId: string
  type: string
  state: string
  artifactId: string | null
  attempts: number
  maxAttempts: number
  error: { message: string; code: string | null } | null
  enqueuedAt: number
  startedAt: number | null
  finishedAt: number | null
}

type GenerationPlanRecord = {
  planId: string
  cellId: string
  status: string
  plan: CommandPlan
  outputArtifactId: string | null
  error: string | null
  createdAt: string
  updatedAt: string
}

type ProviderRecord = {
  envKey: string
  provider: string
  label: string
  keyStatus: string
  maskedKey: string | null
}

type InitialWorkspace = {
  books: BookSummary[]
  bookId: string
  notebook: NotebookDocument | null
  assets: AssetRecord[]
  ingestStatuses: IngestStatus[]
  audioNotebook: AudioNotebookState
  sequence: Sequence | null
  jobs: JobRecord[]
  commands: ServerCommand[]
}

const supportedUiActions = new Set([
  'switch_book',
  'open_notebook',
  'open_projects',
  'open_provider_keys',
])

interface CanvasCellData extends NotebookCellData {
  asset?: AssetRecord
  onRun?: () => void
}

type CanvasNode = Node<CanvasCellData>

const mcpUrl = new URL('/mcp', window.location.origin).toString()

const screenNavigation: Array<{
  id: Exclude<Screen, 'notebook'>
  label: string
  icon: typeof BookOpen
}> = [
  { id: 'library', label: 'Library', icon: Library },
  { id: 'timeline', label: 'Timeline', icon: Film },
  { id: 'jobs', label: 'Jobs', icon: Activity },
  { id: 'settings', label: 'Settings', icon: Settings },
]

const cellPalette: Array<{
  type: NotebookCellType
  label: string
  icon: typeof BookOpen
}> = [
  { type: 'prompt', label: 'Prompt', icon: CircleDot },
  { type: 'image', label: 'Image', icon: Image },
  { type: 'video', label: 'Video', icon: Video },
  { type: 'character', label: 'Character', icon: BookOpen },
  { type: 'scene', label: 'Scene', icon: Film },
]

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function responseText(result: unknown): string | null {
  const response = result as ToolResponse
  return response.content?.find((item) => item.type === 'text')?.text ?? null
}

function parseResult(result: unknown): unknown {
  const response = result as ToolResponse
  const text = responseText(result)
  if (response.isError) throw new Error(text ?? 'MCP tool failed')
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

function messageFor(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value
  const item = record(value)
  if (!item) return fallback
  for (const key of ['message', 'job_id', 'notebook_id', 'slug', 'bookId']) {
    const candidate = asString(item[key])
    if (candidate) return `${fallback}: ${candidate}`
  }
  return fallback
}

function asBooks(value: unknown): BookSummary[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const item = record(entry)
    const bookId = item && asString(item.bookId)
    const slug = item && asString(item.slug)
    const createdAt = item && asNumber(item.createdAt)
    if (!item || !bookId || !slug || createdAt === null) return []
    return [{
      bookId,
      slug,
      createdAt,
      artifactCount: asNumber(item.artifactCount) ?? 0,
      notebookCount: asNumber(item.notebookCount) ?? 0,
    }]
  })
}

function asNotebookCell(value: unknown): NotebookDocument['cells'][number] | null {
  const item = record(value)
  const id = item && asString(item.id)
  const type = item && asString(item.type)
  const title = item && asString(item.title)
  const position = item && record(item.position)
  const x = position && asNumber(position.x)
  const y = position && asNumber(position.y)
  if (!item || !id || !title || x === null || y === null) return null
  if (![
    'source',
    'audio',
    'transcript',
    'note',
    'search',
    'selects',
    'prompt',
    'character',
    'scene',
    'asset',
    'image',
    'video',
    'sequence',
  ].includes(type ?? '')) return null
  const inputs = record(item.inputs)
  const references = Array.isArray(item.references)
    ? item.references as NotebookCellReference[]
    : undefined
  const pinnedResults = Array.isArray(item.pinned_results ?? item.pinnedResults)
    ? (item.pinned_results ?? item.pinnedResults) as PinnedSearchResult[]
    : undefined
  return {
    id,
    type: type as NotebookCellType,
    title,
    position: { x, y },
    ...(asString(item.entity_id ?? item.entityId)
      ? { entityId: asString(item.entity_id ?? item.entityId)! }
      : {}),
    ...(asString(item.prompt) !== null ? { prompt: asString(item.prompt)! } : {}),
    ...(asString(item.model) !== null ? { model: asString(item.model)! } : {}),
    ...(inputs ? { inputs } : {}),
    ...(references ? { references } : {}),
    ...(pinnedResults ? { pinnedResults } : {}),
    ...(asString(item.output_artifact_id ?? item.outputArtifactId)
      ? { outputArtifactId: asString(item.output_artifact_id ?? item.outputArtifactId)! }
      : {}),
  }
}

function asNotebook(value: unknown): NotebookDocument | null {
  const item = record(value)
  const id = item && asString(item.id)
  const name = item && asString(item.name)
  const createdAt = item && asString(item.created_at ?? item.createdAt)
  if (!item || !id || !name || !createdAt) return null
  const cells = Array.isArray(item.cells)
    ? item.cells.flatMap((cell) => {
      const parsed = asNotebookCell(cell)
      return parsed ? [parsed] : []
    })
    : []
  const edges = Array.isArray(item.edges)
    ? item.edges.flatMap((edge) => {
      const parsed = record(edge)
      const edgeId = parsed && asString(parsed.id)
      const source = parsed && asString(parsed.source)
      const target = parsed && asString(parsed.target)
      const targetInput = parsed && asString(parsed.targetInput ?? parsed.target_input)
      return edgeId && source && target && targetInput
        ? [{ id: edgeId, source, target, targetInput }]
        : []
    })
    : []
  return {
    id,
    name,
    createdAt,
    ...(record(item.properties) ? { properties: record(item.properties)! } : {}),
    cells,
    edges,
  }
}

function asNotebooks(value: unknown): NotebookDocument[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
      const notebook = asNotebook(entry)
      return notebook ? [notebook] : []
    })
    : []
}

function asAssets(value: unknown): AssetRecord[] {
  const container = record(value)
  const source = Array.isArray(value)
    ? value
    : Array.isArray(container?.assets)
      ? container.assets
      : []
  return source.flatMap((entry) => {
    const item = record(entry)
    const id = item && asString(item.id)
    const artifactId = item && asString(item.artifact_id ?? item.artifactId)
    const type = item && asString(item.type)
    if (!item || !id || !artifactId || !type) return []
    return [{
      id,
      artifactId,
      type,
      createdAt: asString(item.created_at ?? item.createdAt) ?? '',
      mediaUrl: asString(item.media_url ?? item.mediaUrl),
      thumbnailUrl: asString(item.thumbnail_url ?? item.thumbnailUrl),
      status: asString(item.status) ?? 'ready',
      prompt: asString(item.prompt),
      width: asNumber(item.width),
      height: asNumber(item.height),
    }]
  })
}

function asIngestStatuses(value: unknown): IngestStatus[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const item = record(entry)
    const artifactId = item && asString(item.artifactId)
    const state = item && asString(item.state)
    const phases = item && record(item.phases)
    if (!artifactId || !state || !phases) return []
    return [{
      artifactId,
      state,
      missingOutputs: Array.isArray(item.missingOutputs)
        ? item.missingOutputs.flatMap((value) => typeof value === 'string' ? [value] : [])
        : [],
      phases: Object.fromEntries(
        Object.entries(phases).flatMap(([key, state]) =>
          typeof state === 'string' ? [[key, state]] : []),
      ),
    }]
  })
}

function asAudioNotebook(value: unknown): AudioNotebookState {
  const item = record(value)
  const spineValue = record(item?.spine)
  const artifactId = asString(spineValue?.artifact_id ?? spineValue?.artifactId)
  const slug = asString(spineValue?.slug)
  const kind = asString(spineValue?.kind)
  const waveformValue = record(item?.waveform)
  const waveform = Array.isArray(waveformValue?.peaks)
    ? waveformValue.peaks.flatMap((peak) =>
      typeof peak === 'number' && Number.isFinite(peak) ? [peak] : [])
    : null
  const transcriptValue = record(item?.transcript)
  const transcriptId = asString(transcriptValue?.transcriptId)
  const language = asString(transcriptValue?.language)
  const segments = Array.isArray(transcriptValue?.segments)
    ? transcriptValue.segments.flatMap((entry) => {
      const segment = record(entry)
      const segmentId = asString(segment?.segmentId)
      const text = asString(segment?.text)
      const kindValue = asString(segment?.kind)
      const speaker = asString(segment?.speaker)
      const range = record(segment?.range)
      const timeBase = record(range?.timeBase)
      const numerator = asNumber(timeBase?.numerator)
      const denominator = asNumber(timeBase?.denominator)
      if (!segmentId || text === null || !kindValue || numerator === null || denominator === null) {
        return []
      }
      const words = Array.isArray(segment?.words)
        ? segment.words.flatMap((wordValue) => {
          const word = record(wordValue)
          const wordId = asString(word?.wordId)
          const wordText = asString(word?.text)
          const startTick = asNumber(word?.startTick)
          const durationTicks = asNumber(word?.durationTicks)
          const confidence = asNumber(word?.confidence)
          return wordId && wordText !== null && startTick !== null && durationTicks !== null
            ? [{
              wordId,
              text: wordText,
              startTick,
              durationTicks,
              ...(confidence !== null ? { confidence } : {}),
              corrected: word?.corrected === true,
            }]
            : []
        })
        : []
      return [{
        segmentId,
        text,
        kind: kindValue,
        ...(speaker ? { speaker } : {}),
        range: { timeBase: { numerator, denominator } },
        words,
      }]
    })
    : []
  return {
    spine: artifactId && slug && kind ? { artifactId, slug, kind } : null,
    waveform,
    transcript: transcriptId && language
      ? { transcriptId, language, segments }
      : null,
  }
}

function latestTranscriptEdit(notebook: NotebookDocument | null): TranscriptEditRecord | null {
  const edits = notebook?.properties?.transcriptEdits
  if (!Array.isArray(edits)) return null
  for (let index = edits.length - 1; index >= 0; index -= 1) {
    const edit = record(edits[index])
    const actionId = asString(edit?.actionId)
    const kind = asString(edit?.kind)
    if (actionId && kind && edit?.restored !== true) {
      return { actionId, kind, restored: false }
    }
  }
  return null
}

function asSequence(value: unknown): Sequence | null {
  const item = record(value)
  return item
    && asString(item.sequenceId)
    && asString(item.revision)
    && Array.isArray(item.tracks)
    && Array.isArray(item.clips)
    && Array.isArray(item.captions)
    ? value as Sequence
    : null
}

function asCommandPlan(value: unknown): CommandPlan {
  const item = record(value)
  if (
    !item
    || item.planVersion !== 1
    || !asString(item.planId)
    || !Array.isArray(item.stages)
  ) {
    throw new Error('The server returned an invalid CommandPlan')
  }
  const plan = value as CommandPlan
  validateCommandPlan(plan)
  return plan
}

function sequenceClipReference(sequence: Sequence | null, value: string | undefined) {
  if (!sequence || !value) return null
  const token = value.replace(/^@/u, '').toLowerCase()
  const matches = sequence.clips.filter((clip) =>
    clip.clipId.toLowerCase().startsWith(token))
  return matches.length === 1 ? matches[0] : null
}

function sequenceTrackReference(sequence: Sequence | null, value: string | undefined) {
  if (!sequence || !value) return null
  const token = value.replace(/^@/u, '').toLowerCase()
  const matches = sequence.tracks.filter((track) =>
    track.trackId.toLowerCase().startsWith(token)
    || track.name.toLowerCase() === token)
  return matches.length === 1 ? matches[0] : null
}

function requestFromEditStage(
  stages: CommandPlan['stages'],
): Record<string, unknown> | Record<string, unknown>[] {
  const stage = stages.find(
    (candidate): candidate is EditCommandStage => candidate.kind === 'edit',
  )
  const requests = stage?.intent.operations.map((operation) => {
    if (operation.kind === 'insert-clip') {
      return {
        kind: 'insert',
        mode: operation.mode,
        artifact_id: operation.placement.source.artifactId,
        track_id: operation.placement.trackId,
        timeline_start_frame: operation.placement.timelineStartFrame,
        duration_frames: operation.placement.durationFrames,
        ...(operation.placement.source.kind === 'timed'
          ? {
              source_start_tick: operation.placement.source.range.startTick,
              source_duration_ticks: operation.placement.source.range.durationTicks,
            }
          : {}),
      }
    }
    if (operation.kind === 'trim-clip') {
      return {
        kind: 'trim',
        clip_id: operation.clipId,
        timeline_start_frame: operation.timelineStartFrame,
        duration_frames: operation.durationFrames,
      }
    }
    if (operation.kind === 'set-clip-audio') {
      return {
        kind: 'volume',
        clip_id: operation.clipId,
        gain_db: operation.audio.gainDb,
        muted: operation.audio.muted,
        fade_in_frames: operation.audio.fadeInFrames,
        fade_out_frames: operation.audio.fadeOutFrames,
      }
    }
    if (operation.kind === 'move-clip') {
      return {
        kind: 'move',
        clip_id: operation.clipId,
        track_id: operation.trackId,
        timeline_start_frame: operation.timelineStartFrame,
      }
    }
    if (operation.kind === 'split-clip') {
      return {
        kind: 'split',
        clip_id: operation.clipId,
        split_frame: operation.splitFrame,
      }
    }
    if (operation.kind === 'set-clip-transform') {
      return {
        kind: 'transform',
        clip_id: operation.clipId,
        fit: operation.transform.fit,
        position_x: operation.transform.positionX,
        position_y: operation.transform.positionY,
        scale_x: operation.transform.scaleX,
        scale_y: operation.transform.scaleY,
        rotation_degrees: operation.transform.rotationDegrees,
        opacity: operation.transform.opacity,
        crop_top: operation.transform.cropTop,
        crop_right: operation.transform.cropRight,
        crop_bottom: operation.transform.cropBottom,
        crop_left: operation.transform.cropLeft,
      }
    }
    if (operation.kind === 'set-clip-speed') {
      return {
        kind: 'speed',
        clip_id: operation.clipId,
        numerator: operation.speed.numerator,
        denominator: operation.speed.denominator,
        reverse: operation.reverse,
        audio_policy: operation.audioPolicy,
      }
    }
    if (operation.kind === 'set-transition') {
      return {
        kind: 'transition',
        outgoing_clip_id: operation.outgoingClipId,
        incoming_clip_id: operation.incomingClipId,
        transition_kind: operation.transition?.kind ?? null,
        ...(operation.transition
          ? {
              duration_frames: operation.transition.durationFrames,
              alignment: operation.transition.alignment,
            }
          : {}),
      }
    }
    if (operation.kind === 'upsert-caption-cue') {
      return {
        kind: 'caption',
        cue_id: operation.cue.cueId,
        track_id: operation.cue.trackId,
        timeline_start_frame: operation.cue.timelineStartFrame,
        duration_frames: operation.cue.durationFrames,
        text: operation.cue.text,
        style_id: operation.cue.styleId,
        ...(operation.cue.speaker ? { speaker: operation.cue.speaker } : {}),
      }
    }
    throw new Error(`The edit cannot be replanned: ${operation.kind}`)
  }) ?? []
  if (requests.length === 0) throw new Error('The plan has no editable operation')
  return requests.length === 1 ? requests[0] : requests
}

function asJobs(value: unknown): JobRecord[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const item = record(entry)
    const id = item && asNumber(item.id)
    const type = item && asString(item.type)
    const state = item && asString(item.state)
    const operationId = item && asString(item.operationId ?? item.operation_id)
    if (!item || id === null || !type || !state || !operationId) return []
    const error = record(item.error)
    return [{
      id,
      operationId,
      type,
      state,
      artifactId: asString(item.artifactId ?? item.artifact_id),
      attempts: asNumber(item.attempts) ?? 0,
      maxAttempts: asNumber(item.maxAttempts ?? item.max_attempts) ?? 1,
      error: error && asString(error.message)
        ? {
            message: asString(error.message)!,
            code: asString(error.code),
          }
        : null,
      enqueuedAt: asNumber(item.enqueuedAt ?? item.enqueued_at) ?? 0,
      startedAt: asNumber(item.startedAt ?? item.started_at),
      finishedAt: asNumber(item.finishedAt ?? item.finished_at),
    }]
  })
}

function asGenerationPlans(value: unknown): GenerationPlanRecord[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const item = record(entry)
    const planId = asString(item?.planId)
    const cellId = asString(item?.cellId)
    const status = asString(item?.status)
    const createdAt = asString(item?.createdAt)
    const updatedAt = asString(item?.updatedAt)
    if (!item || !planId || !cellId || !status || !createdAt || !updatedAt) return []
    try {
      return [{
        planId,
        cellId,
        status,
        plan: asCommandPlan(item.plan),
        outputArtifactId: asString(item.outputArtifactId),
        error: asString(item.error),
        createdAt,
        updatedAt,
      }]
    } catch {
      return []
    }
  })
}

function asCommands(value: unknown): ServerCommand[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is ServerCommand => {
      const item = record(entry)
      const uiAction = item && asString(item.uiAction)
      return item !== null
        && typeof item.command === 'string'
        && typeof item.description === 'string'
        && (!uiAction || supportedUiActions.has(uiAction))
    })
    : []
}

function asProviders(value: unknown): ProviderRecord[] {
  const item = record(value)
  if (!Array.isArray(item?.providers)) return []
  return item.providers.flatMap((entry) => {
    const provider = record(entry)
    const envKey = provider && asString(provider.envKey)
    const label = provider && asString(provider.label)
    const group = provider && asString(provider.provider)
    if (!provider || !envKey || !label || !group) return []
    return [{
      envKey,
      provider: group,
      label,
      keyStatus: asString(provider.keyStatus) ?? 'missing',
      maskedKey: asString(provider.maskedKey),
    }]
  })
}

function savedValue(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

function saveValue(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    return
  }
}

function asInitialWorkspace(
  payload: InitialWorkspacePayload | null,
): InitialWorkspace | null {
  if (!payload) return null
  const books = asBooks(payload.bookValue)
  const notebooks = asNotebooks(payload.notebookValue)
  return {
    books,
    bookId: payload.bookId,
    notebook: notebooks.find((entry) => entry.id === payload.notebookId) ?? null,
    assets: asAssets(payload.assetValue),
    ingestStatuses: asIngestStatuses(payload.ingestStatusValue),
    audioNotebook: asAudioNotebook(payload.audioValue),
    sequence: asSequence(payload.sequenceValue),
    jobs: asJobs(payload.jobValue),
    commands: asCommands(payload.commandValue),
  }
}

async function fileObjectHash(file: File): Promise<string> {
  const digest = await window.crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
}

function artifactForCell(
  assets: ReadonlyMap<string, AssetRecord>,
  outputArtifactId: string | undefined,
): AssetRecord | undefined {
  return outputArtifactId ? assets.get(outputArtifactId) : undefined
}

function cellExecutionStatus(
  document: NotebookDocument,
  cellId: string,
): string {
  const execution = record(document.properties?.execution)
  const item = execution && record(execution[cellId])
  if (!item) return 'ready'
  if (asString(item.error)) return 'error'
  return asString(item.status) ?? 'ready'
}

function canvasNodes(
  document: NotebookDocument,
  assets: AssetRecord[],
  onRun: (cellId: string) => void,
): CanvasNode[] {
  const byArtifactId = new Map(assets.map((asset) => [asset.artifactId, asset]))
  return notebookNodes(document).map((node) => ({
    ...node,
    data: {
      ...node.data,
      status: cellExecutionStatus(document, node.id),
      asset: artifactForCell(byArtifactId, node.data.outputArtifactId),
      onRun: () => onRun(node.id),
    },
  }))
}

function CellIcon({ kind }: { kind: NotebookCellType }) {
  if (kind === 'source' || kind === 'asset' || kind === 'video') {
    return <Video size={14} />
  }
  if (kind === 'audio' || kind === 'transcript') {
    return <AudioWaveform size={14} />
  }
  if (kind === 'scene' || kind === 'sequence' || kind === 'selects') {
    return <Film size={14} />
  }
  if (kind === 'image') return <Image size={14} />
  if (kind === 'prompt') return <CircleDot size={14} />
  return <BookOpen size={14} />
}

function notebookStageLabels(document: NotebookDocument | null): string[] {
  const labels = document?.properties?.stageLabels
  return Array.isArray(labels)
    ? labels.map((label) => typeof label === 'string' ? label : '')
    : []
}

function CellNode({ data, selected }: NodeProps<CanvasNode>) {
  const mediaUrl = data.asset?.mediaUrl
  const thumbnailUrl = data.asset?.thumbnailUrl
  const targetInputs = data.targetInputs?.length ? data.targetInputs : ['input']
  const playableVideo = data.asset?.type === 'video' || data.asset?.type === 'final'
  const canRun = data.kind === 'image' || data.kind === 'video'

  return (
    <article className={`cell-node cell-kind-${data.kind} ${selected ? 'cell-node-selected' : ''}`}>
      {targetInputs.map((input, index) => (
        <Handle
          key={input}
          type="target"
          position={Position.Top}
          id={input}
          className="cell-target-handle"
          style={{ left: `${((index + 1) / (targetInputs.length + 1)) * 100}%` }}
        />
      ))}
      <section className="cell-node-shell">
        <header className="cell-node-header">
          <span><CellIcon kind={data.kind} />{data.kind.toUpperCase()}</span>
          {canRun && (
            <button
              type="button"
              className="cell-run-button nodrag"
              onClick={(event) => {
                event.stopPropagation()
                data.onRun?.()
              }}
            >
              Run
            </button>
          )}
        </header>
        {data.kind === 'audio' ? (
          <div className="cell-copy cell-copy-audio">
            <AudioWaveform size={38} />
            <span>Original soundtrack<br />48 kHz · stereo</span>
          </div>
        ) : mediaUrl || thumbnailUrl ? (
          <div className="cell-media">
            {playableVideo && mediaUrl ? (
              <video src={mediaUrl} poster={thumbnailUrl ?? undefined} muted playsInline preload="metadata" />
            ) : (
              <img src={thumbnailUrl ?? mediaUrl ?? ''} alt={data.title} />
            )}
          </div>
        ) : (
          <div className={`cell-copy ${data.kind === 'prompt' ? 'cell-copy-prompt' : ''}`}>
            {data.kind === 'prompt' ? <p>{data.prompt || data.title}</p> : <Sparkles size={28} />}
            {data.kind !== 'prompt' && <span>{data.prompt || data.title}</span>}
          </div>
        )}
        <footer className="cell-node-footer">
          <strong>{data.title}</strong>
          <strong>{data.status}</strong>
        </footer>
      </section>
      <Handle type="source" position={Position.Bottom} id="output" />
    </article>
  )
}

const nodeTypes = { cell: CellNode }
const flowProOptions = { hideAttribution: true }
const flowFitViewOptions: FitViewOptions<CanvasNode> = {
  padding: {
    top: '7%',
    right: '6%',
    bottom: '17%',
    left: '6%',
  },
  minZoom: 0.35,
  maxZoom: 0.86,
  duration: 220,
}
const compactFlowFitViewOptions: FitViewOptions<CanvasNode> = {
  padding: {
    top: '96px',
    right: '18px',
    bottom: '108px',
    left: '18px',
  },
  minZoom: 0.35,
  maxZoom: 0.86,
  duration: 220,
}

type AppProps = {
  initialWorkspace: InitialWorkspacePayload | null
}

function App({ initialWorkspace: initialPayload }: AppProps) {
  const initialWorkspace = useMemo(
    () => asInitialWorkspace(initialPayload),
    [initialPayload],
  )
  const mcp = useMcp({
    url: mcpUrl,
    clientName: 'videobook',
    transportType: 'http',
    autoReconnect: 3000,
  })
  const [screen, setScreen] = useState<Screen>('notebook')
  const [books, setBooks] = useState<BookSummary[]>(() => initialWorkspace?.books ?? [])
  const [bookId, setBookId] = useState(() =>
    initialWorkspace?.bookId ?? savedValue('videobook.active-book'))
  const [notebook, setNotebook] = useState<NotebookDocument | null>(
    () => initialWorkspace?.notebook ?? null,
  )
  const [assets, setAssets] = useState<AssetRecord[]>(() => initialWorkspace?.assets ?? [])
  const [ingestStatuses, setIngestStatuses] = useState<IngestStatus[]>(
    () => initialWorkspace?.ingestStatuses ?? [],
  )
  const [audioNotebook, setAudioNotebook] = useState<AudioNotebookState>(
    () => initialWorkspace?.audioNotebook ?? asAudioNotebook(null),
  )
  const [sequence, setSequence] = useState<Sequence | null>(
    () => initialWorkspace?.sequence ?? null,
  )
  const [jobs, setJobs] = useState<JobRecord[]>(() => initialWorkspace?.jobs ?? [])
  const [jobSnapshotAt, setJobSnapshotAt] = useState(() => Date.now())
  const [commands, setCommands] = useState<ServerCommand[]>(
    () => initialWorkspace?.commands ?? [],
  )
  const [providers, setProviders] = useState<ProviderRecord[]>([])
  const [storage, setStorage] = useState<unknown>(null)
  const [selectedCellId, setSelectedCellId] = useState<string | null>(null)
  const [previewSlot, setPreviewSlot] = useState<NotebookGridSlot | null>(null)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [bookMenuOpen, setBookMenuOpen] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [recording, setRecording] = useState(false)
  const [timelineSelectionStart, setTimelineSelectionStart] = useState('0')
  const [timelineSelectionDuration, setTimelineSelectionDuration] = useState('30')
  const [selectedSequenceClipId, setSelectedSequenceClipId] = useState('')
  const [timelineTargetTrackId, setTimelineTargetTrackId] = useState('')
  const [timelineInsertAssetId, setTimelineInsertAssetId] = useState('')
  const [timelineTrackKind, setTimelineTrackKind] = useState<'video' | 'audio' | 'caption'>('video')
  const [timelineTrackName, setTimelineTrackName] = useState('')
  const [timelineGainDb, setTimelineGainDb] = useState('0')
  const [timelineFadeIn, setTimelineFadeIn] = useState('0')
  const [timelineFadeOut, setTimelineFadeOut] = useState('0')
  const [timelineMuted, setTimelineMuted] = useState(false)
  const [selectedCaptionCueId, setSelectedCaptionCueId] = useState('')
  const [captionText, setCaptionText] = useState('')
  const [captionStyle, setCaptionStyle] = useState<'clean' | 'bold' | 'high-contrast'>('clean')
  const [timelinePlayheadFrame, setTimelinePlayheadFrame] = useState(0)
  const [timelineZoom, setTimelineZoom] = useState(1)
  const [exportOrientation, setExportOrientation] = useState<'landscape' | 'portrait' | 'square'>('landscape')
  const [exportCaptions, setExportCaptions] = useState<'burn-in' | 'sidecar' | 'omit'>('burn-in')
  const [audioSpineAssetId, setAudioSpineAssetId] = useState(
    () => initialWorkspace?.audioNotebook.spine?.artifactId ?? '',
  )
  const [importUrl, setImportUrl] = useState('')
  const [selectedTranscriptWordId, setSelectedTranscriptWordId] = useState('')
  const [transcriptCorrection, setTranscriptCorrection] = useState('')
  const [selectionStartWordId, setSelectionStartWordId] = useState('')
  const [moveDestinationWordId, setMoveDestinationWordId] = useState('')
  const [pendingCommandPlan, setPendingCommandPlan] = useState<PendingCommandPlan | null>(null)
  const [lastEditActionId, setLastEditActionId] = useState('')
  const [secretKey, setSecretKey] = useState('KIE_API_KEY')
  const [secretValue, setSecretValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [online, setOnline] = useState(() => window.navigator.onLine)
  const [, setNotice] = useState('Connect to the server, then load your books.')
  const flowRef = useRef<ReactFlowInstance<CanvasNode, Edge> | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const recorderStreamRef = useRef<MediaStream | null>(null)
  const recorderChunksRef = useRef<Blob[]>([])
  const audioSpinePlayerRef = useRef<HTMLAudioElement | null>(null)

  const fitNotebook = useCallback(() => {
    window.requestAnimationFrame(() => {
      const options = window.innerWidth <= 560
        ? compactFlowFitViewOptions
        : flowFitViewOptions
      void flowRef.current?.fitView(options)
    })
  }, [])

  const activeBook = useMemo(
    () => books.find((book) => book.bookId === bookId) ?? null,
    [bookId, books],
  )
  const assetById = useMemo(
    () => new Map(assets.map((asset) => [asset.artifactId, asset])),
    [assets],
  )
  const ingestStatusById = useMemo(
    () => new Map(ingestStatuses.map((status) => [status.artifactId, status])),
    [ingestStatuses],
  )
  const sourceAssets = useMemo(
    () => assets.filter((asset) => asset.type !== 'notebook'),
    [assets],
  )
  const playbackAssets = useMemo(
    () => assets.flatMap((asset) =>
      asset.mediaUrl
        ? [{ artifactId: asset.artifactId, mediaUrl: asset.mediaUrl }]
        : []),
    [assets],
  )
  const audioSpineAsset = audioNotebook.spine
    ? assetById.get(audioNotebook.spine.artifactId)
    : undefined
  const restorableTranscriptEdit = useMemo(
    () => latestTranscriptEdit(notebook),
    [notebook],
  )
  const generationPlans = useMemo(
    () => asGenerationPlans(notebook?.properties?.generationPlans),
    [notebook],
  )
  const canAttachToTranscript = useMemo(() => {
    const selection = record(notebook?.properties?.currentSelection)
    return record(selection?.sequence)?.range !== undefined
  }, [notebook])
  const activeSequenceRange = useMemo(() => {
    const selection = record(notebook?.properties?.currentSelection)
    const sequenceSelection = record(selection?.sequence)
    const range = record(sequenceSelection?.range)
    const startFrame = asNumber(range?.startFrame)
    const durationFrames = asNumber(range?.durationFrames)
    return startFrame !== null && durationFrames !== null
      ? { startFrame, durationFrames }
      : null
  }, [notebook])
  const playheadTranscriptWordIds = useMemo(() => {
    const cue = sequence?.captions.find((candidate) =>
      timelinePlayheadFrame >= candidate.timelineStartFrame
      && timelinePlayheadFrame
        < candidate.timelineStartFrame + candidate.durationFrames)
    const selection = cue?.transcriptSelection
    if (!selection || !audioNotebook.transcript) return new Set<string>()
    const wordIds = audioNotebook.transcript.segments.flatMap((segment) =>
      segment.words.map((word) => word.wordId))
    const start = wordIds.indexOf(selection.startWordId)
    const end = wordIds.indexOf(selection.endWordId)
    if (start < 0 || end < start) return new Set<string>()
    return new Set(wordIds.slice(start, end + 1))
  }, [audioNotebook.transcript, sequence, timelinePlayheadFrame])
  const selectedSequenceClip = useMemo(() => {
    if (selectedSequenceClipId) {
      return sequence?.clips.find((clip) =>
        clip.clipId === selectedSequenceClipId) ?? null
    }
    const startFrame = Number(timelineSelectionStart)
    const durationFrames = Number(timelineSelectionDuration)
    return sequence?.clips.find((clip) =>
      clip.timelineStartFrame === startFrame
      && clip.durationFrames === durationFrames) ?? null
  }, [
    selectedSequenceClipId,
    sequence,
    timelineSelectionDuration,
    timelineSelectionStart,
  ])

  const call = useCallback(async (tool: string, args: Record<string, unknown>) => {
    if (mcp.state !== 'ready') throw new Error('MCP server is not ready')
    return parseResult(await mcp.callTool(tool, args))
  }, [mcp])

  useEffect(() => {
    const updateOnlineState = () => setOnline(window.navigator.onLine)
    window.addEventListener('online', updateOnlineState)
    window.addEventListener('offline', updateOnlineState)
    return () => {
      window.removeEventListener('online', updateOnlineState)
      window.removeEventListener('offline', updateOnlineState)
    }
  }, [])

  const prepareGenerationPlan = useCallback(async (
    cellId: string,
    sourceSurface: 'ui' | 'slash' | 'chat',
  ): Promise<ComposerOutcome> => {
    if (!bookId || !notebook) {
      return { ok: false, message: 'Load a notebook first.' }
    }
    const startFrame = Number(timelineSelectionStart)
    const durationFrames = Number(timelineSelectionDuration)
    const plan = asCommandPlan(await call('plan_notebook_generation', {
      book_id: bookId,
      notebook_id: notebook.id,
      cell_id: cellId,
      source_surface: sourceSurface,
      actor: 'videobook-user',
      timeline_start_frame: Number.isSafeInteger(startFrame) && startFrame >= 0
        ? startFrame
        : 0,
      ...(Number.isSafeInteger(durationFrames) && durationFrames > 0
        ? { duration_frames: durationFrames }
        : {}),
    }))
    setPendingCommandPlan({ plan, previews: {} })
    return { ok: true, message: 'Generation plan ready for review' }
  }, [
    bookId,
    call,
    notebook,
    timelineSelectionDuration,
    timelineSelectionStart,
  ])

  const runCell = useCallback(async (cellId: string) => {
    if (!bookId || !notebook) return
    const cell = notebook.cells.find((candidate) => candidate.id === cellId)
    if (!cell || (cell.type !== 'image' && cell.type !== 'video')) return
    if (!online) {
      setNotice('Offline: cloud generation is unavailable. Local search, editing, playback, and export remain available.')
      return
    }
    const consentKey = 'videobook.cloud-generation-consent'
    if (window.localStorage.getItem(consentKey) !== 'accepted') {
      const model = typeof cell.model === 'string'
        ? cell.model
        : 'configured cloud provider'
      const accepted = window.confirm(
        `Cloud generation disclosure\n\nProvider/model: ${model}\n`
        + 'Payload class: prompt text and connected media references.\n'
        + 'Your local source files are sent only when required by the selected model.\n\n'
        + 'Continue and remember this choice on this device?',
      )
      if (!accepted) {
        setNotice('Cloud generation cancelled before sending data')
        return
      }
      window.localStorage.setItem(consentKey, 'accepted')
    }
    setBusy(true)
    try {
      const result = await prepareGenerationPlan(cellId, 'ui')
      setNotice(result.message)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [bookId, notebook, online, prepareGenerationPlan])

  const [nodes, setNodes] = useState<CanvasNode[]>(() =>
    initialWorkspace?.notebook
      ? canvasNodes(
          initialWorkspace.notebook,
          initialWorkspace.assets,
          (cellId) => void runCell(cellId),
        )
      : [])
  const [edges, setEdges] = useState<Edge[]>(() =>
    initialWorkspace?.notebook ? notebookEdges(initialWorkspace.notebook) : [])
  const selectedCell = useMemo(
    () => nodes.find((node) => node.id === selectedCellId) ?? null,
    [nodes, selectedCellId],
  )

  const applyNotebook = useCallback((next: NotebookDocument, nextAssets: AssetRecord[]) => {
    setNotebook(next)
    setNodes(canvasNodes(next, nextAssets, (cellId) => void runCell(cellId)))
    setEdges(notebookEdges(next))
    setSelectedCellId(null)
  }, [runCell])

  const refreshNotebook = useCallback(async (targetBookId: string, notebookId: string) => {
    const [value, audioValue] = await Promise.all([
      call('get_notebook', {
        book_id: targetBookId,
        notebook_id: notebookId,
      }),
      call('get_notebook_audio_spine', {
        book_id: targetBookId,
        notebook_id: notebookId,
      }),
    ])
    const next = asNotebook(value)
    if (!next) throw new Error('The server returned an invalid notebook')
    applyNotebook(next, assets)
    const nextAudio = asAudioNotebook(audioValue)
    setAudioNotebook(nextAudio)
    setAudioSpineAssetId(nextAudio.spine?.artifactId ?? '')
    return next
  }, [applyNotebook, assets, call])

  const refreshBookData = useCallback(async (targetBookId: string, preferredNotebookId?: string) => {
    const [
      notebookValue,
      assetValue,
      sequenceValue,
      jobValue,
      ingestStatusValue,
    ] = await Promise.all([
      call('list_notebooks', { book_id: targetBookId }),
      call('list_assets', {
        book_id: targetBookId,
        sort: 'newest',
        limit: 200,
      }),
      call('get_primary_sequence', { book_id: targetBookId }),
      call('list_jobs', { book_id: targetBookId, limit: 200 }),
      call('list_ingest_status', { book_id: targetBookId, limit: 200 }),
    ])
    const nextNotebooks = asNotebooks(notebookValue)
    const nextAssets = asAssets(assetValue)
    const remembered = savedValue(`videobook.active-notebook:${targetBookId}`)
    const nextNotebook = nextNotebooks.find((entry) => entry.id === preferredNotebookId)
      ?? nextNotebooks.find((entry) => entry.id === remembered)
      ?? nextNotebooks[0]
      ?? null
    setBookId(targetBookId)
    saveValue('videobook.active-book', targetBookId)
    setAssets(nextAssets)
    setIngestStatuses(asIngestStatuses(ingestStatusValue))
    setSequence(asSequence(sequenceValue))
    setJobs(asJobs(jobValue))
    setJobSnapshotAt(Date.now())
    if (!nextNotebook) {
      setNotebook(null)
      setAudioNotebook(asAudioNotebook(null))
      setAudioSpineAssetId('')
      setNodes([])
      setEdges([])
      return
    }
    const audioValue = await call('get_notebook_audio_spine', {
      book_id: targetBookId,
      notebook_id: nextNotebook.id,
    })
    const nextAudio = asAudioNotebook(audioValue)
    setAudioNotebook(nextAudio)
    setAudioSpineAssetId(nextAudio.spine?.artifactId ?? '')
    saveValue(`videobook.active-notebook:${targetBookId}`, nextNotebook.id)
    applyNotebook(nextNotebook, nextAssets)
  }, [applyNotebook, call])

  const loadBooks = useCallback(async (preferredBookId?: string) => {
    setBusy(true)
    try {
      const [bookValue, commandValue] = await Promise.all([
        call('list_books', { sort: 'newest' }),
        call('slash_commands', {}),
      ])
      const nextBooks = asBooks(bookValue)
      setBooks(nextBooks)
      setCommands(asCommands(commandValue))
      const target = nextBooks.find((book) => book.bookId === preferredBookId)
        ?? nextBooks.find((book) => book.slug === 'multyculty')
        ?? nextBooks.find((book) => book.bookId === bookId)
        ?? nextBooks[0]
      if (target) {
        await refreshBookData(target.bookId)
        fitNotebook()
        setNotice(`Loaded ${target.slug}`)
      } else {
        setBookId('')
        setNotebook(null)
        setAssets([])
        setSequence(null)
        setNodes([])
        setEdges([])
        setNotice('No videobook projects are available.')
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [bookId, call, fitNotebook, refreshBookData])

  const chooseBook = useCallback(async (nextBookId: string) => {
    setBusy(true)
    try {
      await refreshBookData(nextBookId)
      fitNotebook()
      const next = books.find((book) => book.bookId === nextBookId)
      setNotice(next ? `Opened ${next.slug}` : 'Book opened')
      setScreen('notebook')
      setBookMenuOpen(false)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [books, fitNotebook, refreshBookData])

  const createCell = async (type: NotebookCellType, position?: { x: number; y: number }) => {
    if (!bookId || !notebook) return
    const slot = position ? notebookGridSlot(position) : nextNotebookGridSlot(nodes)
    const cellPosition = notebookGridPosition(slot)
    const labels: Record<NotebookCellType, string> = {
      source: 'Source',
      audio: 'Audio',
      transcript: 'Transcript',
      note: 'Note',
      search: 'Search',
      selects: 'Selects',
      prompt: 'Prompt',
      character: 'Character',
      scene: 'Scene',
      asset: 'Asset',
      image: 'Image generation',
      video: 'Video generation',
      sequence: 'Sequence',
    }
    const defaults: Partial<Record<NotebookCellType, string>> = {
      image: 'generate_kie_gpt_image_2_text_to_image',
      video: 'generate_kie_wan_2_7_text_to_video',
    }
    setBusy(true)
    try {
      await call('create_notebook_cell', {
        book_id: bookId,
        notebook_id: notebook.id,
        cell: {
          type,
          title: labels[type],
          position: cellPosition,
          ...(type === 'prompt' || type === 'image' || type === 'video'
            ? { prompt: '' }
            : {}),
          ...(defaults[type] ? { model: defaults[type] } : {}),
        },
      })
      await refreshBookData(bookId, notebook.id)
      if (!position) fitNotebook()
      setNotice(`Added ${labels[type].toLowerCase()} cell`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const updateCell = async (patch: Record<string, unknown>) => {
    if (!bookId || !notebook || !selectedCell) return
    setBusy(true)
    try {
      await call('update_notebook_cell', {
        book_id: bookId,
        notebook_id: notebook.id,
        cell_id: selectedCell.id,
        cell: patch,
      })
      await refreshNotebook(bookId, notebook.id)
      setNotice('Cell saved')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const deleteSelectedCell = async () => {
    if (!bookId || !notebook || !selectedCell) return
    setBusy(true)
    try {
      await call('delete_notebook_cell', {
        book_id: bookId,
        notebook_id: notebook.id,
        cell_id: selectedCell.id,
      })
      await refreshBookData(bookId, notebook.id)
      fitNotebook()
      setNotice('Cell deleted')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const persistPositions = async (nextNodes: CanvasNode[]) => {
    if (!bookId || !notebook) return
    try {
      await call('move_notebook_cells', {
        book_id: bookId,
        notebook_id: notebook.id,
        positions: nextNodes.map((node) => ({ id: node.id, x: node.position.x, y: node.position.y })),
      })
      await refreshNotebook(bookId, notebook.id)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    }
  }

  const connectCells = async (connection: Connection) => {
    if (!bookId || !notebook || !connection.source || !connection.target) return
    setBusy(true)
    try {
      await call('connect_notebook_cells', {
        book_id: bookId,
        notebook_id: notebook.id,
        source_cell_id: connection.source,
        target_cell_id: connection.target,
        target_input: connection.targetHandle ?? 'input',
      })
      await refreshNotebook(bookId, notebook.id)
      setNotice('Cells connected')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const removeEdges = async (edgeIds: string[]) => {
    if (!bookId || !notebook || edgeIds.length === 0) return
    try {
      await Promise.all(edgeIds.map((edgeId) => call('disconnect_notebook_cells', {
        book_id: bookId,
        notebook_id: notebook.id,
        edge_id: edgeId,
      })))
      await refreshNotebook(bookId, notebook.id)
      setNotice('Connection removed')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    }
  }

  const uploadFiles = async (files: File[]) => {
    if (files.length === 0 || !bookId) return
    if (uploading) {
      setNotice('Wait for the current import to finish')
      return
    }
    setUploading(true)
    try {
      let imported = 0
      let reused = 0
      for (const file of files) {
        const objectHash = await fileObjectHash(file)
        const duplicateValue = record(await call('check_duplicate_bytes', {
          book_id: bookId,
          object_hash: objectHash,
        }))
        const matches = Array.isArray(duplicateValue?.matches)
          ? duplicateValue.matches
          : []
        if (matches.length > 0) {
          const first = record(matches[0])
          const slug = asString(first?.slug) ?? 'existing source'
          const importAgain = window.confirm(
            `${file.name} has the same bytes as ${slug}.\n\n`
            + 'Choose OK to import another copy, or Cancel to reuse the existing source.',
          )
          if (!importAgain) {
            reused += 1
            continue
          }
        }
        const response = await fetch(
          `/api/books/${encodeURIComponent(bookId)}/upload?filename=${encodeURIComponent(file.name)}`,
          { method: 'POST', body: file },
        )
        const payload = await response.json() as { error?: string }
        if (!response.ok) throw new Error(payload.error ?? `Upload failed: ${file.name}`)
        imported += 1
      }
      await refreshBookData(bookId, notebook?.id)
      setNotice([
        imported > 0 ? `Imported ${imported}` : '',
        reused > 0 ? `reused ${reused} existing` : '',
      ].filter(Boolean).join(' · ') || 'No files imported')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setUploading(false)
    }
  }

  const importFromUrl = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!bookId || !importUrl.trim()) return
    setUploading(true)
    try {
      const result = await call('download_video', {
        book_id: bookId,
        url: importUrl.trim(),
        export_videos: false,
      })
      setImportUrl('')
      await refreshBookData(bookId, notebook?.id)
      setNotice(messageFor(result, 'URL import queued'))
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setUploading(false)
    }
  }

  const upload = (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])]
    event.target.value = ''
    void uploadFiles(files)
  }

  const startRecording = async () => {
    if (!bookId || recording) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = [
        'audio/webm;codecs=opus',
        'audio/ogg;codecs=opus',
        'audio/mp4',
      ].find((type) => MediaRecorder.isTypeSupported(type))
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream)
      recorderRef.current = recorder
      recorderStreamRef.current = stream
      recorderChunksRef.current = []
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) recorderChunksRef.current.push(event.data)
      }
      recorder.onstop = () => {
        const blob = new Blob(recorderChunksRef.current, {
          type: recorder.mimeType || mimeType || 'audio/webm',
        })
        recorderChunksRef.current = []
        recorderStreamRef.current?.getTracks().forEach((track) => track.stop())
        recorderStreamRef.current = null
        recorderRef.current = null
        const extension = blob.type.includes('ogg')
          ? 'ogg'
          : blob.type.includes('mp4') ? 'm4a' : 'weba'
        const file = new File(
          [blob],
          `recording-${new Date().toISOString().replaceAll(':', '-')}.${extension}`,
          { type: blob.type },
        )
        void uploadFiles([file])
      }
      recorder.start(500)
      setRecording(true)
      setNotice('Microphone recording started')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    }
  }

  const stopRecording = () => {
    const recorder = recorderRef.current
    if (!recorder || recorder.state === 'inactive') return
    recorder.stop()
    setRecording(false)
    setNotice('Saving microphone recording…')
  }

  const retryIngest = async (artifactId: string) => {
    if (!bookId) return
    setBusy(true)
    try {
      await call('retry_ingest', {
        book_id: bookId,
        artifact_id: artifactId,
      })
      await refreshBookData(bookId, notebook?.id)
      setNotice('Ingest retry queued')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const cancelJob = async (jobId: number) => {
    if (!bookId) return
    setBusy(true)
    try {
      await call('cancel_job', {
        book_id: bookId,
        job_id: jobId,
      })
      await refreshBookData(bookId, notebook?.id)
      setNotice(`Job ${jobId} cancelled`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const retryJob = async (jobId: number) => {
    if (!bookId) return
    setBusy(true)
    try {
      await call('retry_job', {
        book_id: bookId,
        job_id: jobId,
      })
      await refreshBookData(bookId, notebook?.id)
      setNotice(`Job ${jobId} retry queued`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const reviseGenerationPlan = async (
    plan: GenerationPlanRecord,
    action: 'retry' | 'switch' | 'omit',
  ) => {
    if (!bookId || !notebook) return
    const currentStage = plan.plan.stages.find((stage) =>
      stage.kind === 'queued' && stage.jobType === 'generation')
    const model = action === 'switch'
      ? window.prompt(
        'Generation model',
        currentStage?.kind === 'queued' ? currentStage.tool : '',
      )?.trim()
      : undefined
    if (action === 'switch' && !model) return
    setBusy(true)
    try {
      const value = await call('revise_notebook_generation_plan', {
        book_id: bookId,
        notebook_id: notebook.id,
        plan_id: plan.planId,
        action,
        ...(model ? { model } : {}),
        source_surface: 'ui',
        actor: 'videobook-user',
      })
      if (action === 'omit') {
        await refreshBookData(bookId, notebook.id)
        setNotice('Generation output omitted; the preserved failure remains available')
      } else {
        setPendingCommandPlan({ plan: asCommandPlan(value), previews: {} })
        setNotice(action === 'retry'
          ? 'Retry plan ready for review'
          : 'Provider/model switch ready for review')
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const continueGenerationPlan = async (plan: GenerationPlanRecord) => {
    if (!bookId || !notebook) return
    setBusy(true)
    try {
      const value = await call('continue_notebook_generation', {
        book_id: bookId,
        notebook_id: notebook.id,
        plan_id: plan.planId,
        actor: 'videobook-user',
      })
      const result = record(value)
      if (result?.kind === 'stale-continuation') {
        setNotice(asString(result.message) ?? 'The sequence changed; review a new destination')
        await refreshBookData(bookId, notebook.id)
        return
      }
      const outcome = await previewCommandPlan(asCommandPlan(value))
      setNotice(outcome.message)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const setAudioSpine = async () => {
    if (!bookId || !notebook || !audioSpineAssetId) return
    setBusy(true)
    try {
      await call('set_notebook_audio_spine', {
        book_id: bookId,
        notebook_id: notebook.id,
        artifact_id: audioSpineAssetId,
      })
      await refreshBookData(bookId, notebook.id)
      setSelectedTranscriptWordId('')
      setTranscriptCorrection('')
      setSelectionStartWordId('')
      setMoveDestinationWordId('')
      fitNotebook()
      setNotice('Audio notebook spine set')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const seekTranscriptWord = (
    word: AudioTranscriptWord,
    segment: AudioTranscriptSegment,
  ) => {
    const player = audioSpinePlayerRef.current
    if (!player) return
    player.currentTime = word.startTick
      * segment.range.timeBase.numerator
      / segment.range.timeBase.denominator
    void player.play()
  }

  const correctTranscriptWord = async () => {
    if (
      !bookId
      || !notebook
      || !audioNotebook.transcript
      || !selectedTranscriptWordId
      || !transcriptCorrection.trim()
    ) return
    setBusy(true)
    try {
      await call('correct_notebook_transcript_word', {
        book_id: bookId,
        notebook_id: notebook.id,
        transcript_id: audioNotebook.transcript.transcriptId,
        word_id: selectedTranscriptWordId,
        text: transcriptCorrection.trim(),
      })
      await refreshNotebook(bookId, notebook.id)
      setSelectedTranscriptWordId('')
      setTranscriptCorrection('')
      setSelectionStartWordId('')
      setMoveDestinationWordId('')
      setNotice('Transcript correction saved without changing source timing')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const selectTranscriptRange = async () => {
    if (
      !bookId
      || !notebook
      || !audioNotebook.transcript
      || !selectionStartWordId
      || !selectedTranscriptWordId
    ) return
    setBusy(true)
    try {
      await call('select_notebook_transcript_words', {
        book_id: bookId,
        notebook_id: notebook.id,
        transcript_id: audioNotebook.transcript.transcriptId,
        start_word_id: selectionStartWordId,
        end_word_id: selectedTranscriptWordId,
      })
      await refreshNotebook(bookId, notebook.id)
      setSelectionStartWordId('')
      setNotice('Exact transcript range pinned to selects')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const removeTranscriptRange = async () => {
    if (
      !bookId
      || !notebook
      || !audioNotebook.transcript
      || !selectionStartWordId
      || !selectedTranscriptWordId
    ) return
    setBusy(true)
    try {
      const args = {
        book_id: bookId,
        notebook_id: notebook.id,
        transcript_id: audioNotebook.transcript.transcriptId,
        start_word_id: selectionStartWordId,
        end_word_id: selectedTranscriptWordId,
      }
      const pending = record(await call('remove_notebook_transcript_words', args))
      const preview = record(pending?.preview)
      const diff = record(preview?.diff)
      const commandId = asString(pending?.commandId)
      const baseRevision = asString(pending?.baseRevision)
      const previewHash = asString(preview?.previewHash)
      if (!commandId || !baseRevision || !previewHash) {
        throw new Error('The server returned an invalid transcript edit preview')
      }
      const beforeFrames = asNumber(diff?.beforeDurationFrames) ?? 0
      const afterFrames = asNumber(diff?.afterDurationFrames) ?? 0
      const confirmed = window.confirm(
        `Remove the selected words from the sequence?\n\n`
        + `Duration: ${beforeFrames} → ${afterFrames} frames.\n`
        + 'Source media and transcript timing remain unchanged.',
      )
      if (!confirmed) {
        setNotice('Transcript removal cancelled')
        return
      }
      await call('remove_notebook_transcript_words', {
        ...args,
        command_id: commandId,
        base_revision: baseRevision,
        preview_hash: previewHash,
      })
      await refreshNotebook(bookId, notebook.id)
      setSelectionStartWordId('')
      setSelectedTranscriptWordId('')
      setTranscriptCorrection('')
      setNotice('Transcript range removed from the sequence; source media is unchanged')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const restoreTranscriptEdit = async () => {
    if (!bookId || !notebook || !restorableTranscriptEdit) return
    setBusy(true)
    try {
      const pending = record(await call('restore_notebook_transcript_edit', {
        book_id: bookId,
        notebook_id: notebook.id,
        action_id: restorableTranscriptEdit.actionId,
      }))
      const targetRevision = asString(pending?.targetRevision)
      const confirmed = window.confirm(
        `Restore the sequence state before the last ${restorableTranscriptEdit.kind} edit?\n\n`
        + `This creates a new forward revision${targetRevision ? ` from ${targetRevision.slice(0, 10)}` : ''}.`,
      )
      if (!confirmed) {
        setNotice('Transcript restore cancelled')
        return
      }
      await call('restore_notebook_transcript_edit', {
        book_id: bookId,
        notebook_id: notebook.id,
        action_id: restorableTranscriptEdit.actionId,
        confirm: true,
      })
      await refreshNotebook(bookId, notebook.id)
      setNotice('Transcript sequence edit restored as a new revision')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const moveTranscriptRange = async () => {
    if (
      !bookId
      || !notebook
      || !audioNotebook.transcript
      || !selectionStartWordId
      || !selectedTranscriptWordId
      || !moveDestinationWordId
    ) return
    setBusy(true)
    try {
      const args = {
        book_id: bookId,
        notebook_id: notebook.id,
        transcript_id: audioNotebook.transcript.transcriptId,
        start_word_id: selectionStartWordId,
        end_word_id: selectedTranscriptWordId,
        before_word_id: moveDestinationWordId,
      }
      const pending = record(await call('move_notebook_transcript_words', args))
      const preview = record(pending?.preview)
      const commandId = asString(pending?.commandId)
      const baseRevision = asString(pending?.baseRevision)
      const previewHash = asString(preview?.previewHash)
      if (!commandId || !baseRevision || !previewHash) {
        throw new Error('The server returned an invalid transcript reorder preview')
      }
      const confirmed = window.confirm(
        'Move the marked transcript range before the destination word?\n\n'
        + 'The sequence and captions will be reordered. Source media remains unchanged.',
      )
      if (!confirmed) {
        setNotice('Transcript move cancelled')
        return
      }
      await call('move_notebook_transcript_words', {
        ...args,
        command_id: commandId,
        base_revision: baseRevision,
        preview_hash: previewHash,
      })
      await refreshNotebook(bookId, notebook.id)
      setSelectionStartWordId('')
      setMoveDestinationWordId('')
      setSelectedTranscriptWordId('')
      setTranscriptCorrection('')
      setNotice('Transcript range moved on the sequence and caption track')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const selectTimelineRange = async (
    startOverride?: number,
    durationOverride?: number,
  ) => {
    if (!bookId || !notebook) return
    const startFrame = startOverride ?? Number(timelineSelectionStart)
    const durationFrames = durationOverride ?? Number(timelineSelectionDuration)
    if (
      !Number.isSafeInteger(startFrame)
      || startFrame < 0
      || !Number.isSafeInteger(durationFrames)
      || durationFrames < 1
    ) {
      setNotice('Timeline selection requires whole, non-negative frame values')
      return
    }
    setBusy(true)
    try {
      await call('select_notebook_timeline_range', {
        book_id: bookId,
        notebook_id: notebook.id,
        start_frame: startFrame,
        duration_frames: durationFrames,
      })
      await refreshNotebook(bookId, notebook.id)
      setSequence(asSequence(await call('get_primary_sequence', {
        book_id: bookId,
      })))
      setNotice('Timeline range synchronized to the notebook transcript')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const refreshSettings = async () => {
    setBusy(true)
    try {
      const status = await call('provider_key_status', {})
      setProviders(asProviders(status))
      if (bookId) setStorage(await call('storage_status', { book_id: bookId }))
      setNotice('Settings refreshed')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const storeSecret = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!secretValue) return
    setBusy(true)
    try {
      await call('set_env_secret', { key: secretKey, value: secretValue })
      setSecretValue('')
      await refreshSettings()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const previewCommandPlan = async (
    plan: CommandPlan,
  ): Promise<ComposerOutcome> => {
    try {
      const editStages = plan.stages.filter(
        (stage): stage is EditCommandStage => stage.kind === 'edit',
      )
      const previewEntries = await Promise.all(editStages.map(async (stage) => [
        stage.stageId,
        await call('preview_edit_intent', {
          book_id: bookId,
          intent: stage.intent,
        }) as EditPreview,
      ] as const))
      const previews = Object.fromEntries(previewEntries)
      setPendingCommandPlan({ plan, previews })
      const conflictCount = Object.values(previews)
        .reduce((count, preview) => count + preview.conflicts.length, 0)
      return conflictCount > 0
        ? { ok: false, message: `Plan requires review: ${conflictCount} conflicts` }
        : { ok: true, message: 'Plan preview ready' }
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  const toggleCommandSuggestion = async (suggestionId: string) => {
    if (!pendingCommandPlan?.plan.suggestions) return
    const suggestions = pendingCommandPlan.plan.suggestions.map((suggestion) =>
      suggestion.suggestionId === suggestionId
        ? { ...suggestion, included: !suggestion.included }
        : suggestion)
    const operations = suggestions
      .filter((suggestion) => suggestion.included)
      .map((suggestion) => suggestion.operation)
    const plan: CommandPlan = {
      ...pendingCommandPlan.plan,
      suggestions,
      stages: pendingCommandPlan.plan.stages.map((stage) =>
        stage.kind === 'edit'
          ? { ...stage, intent: { ...stage.intent, operations } }
          : stage),
    }
    if (operations.length === 0) {
      setPendingCommandPlan({ plan, previews: {} })
      return
    }
    const outcome = await previewCommandPlan(plan)
    setNotice(outcome.message)
  }

  const prepareSequenceEdit = async (
    request: Record<string, unknown> | Record<string, unknown>[],
    sourceSurface: 'ui' | 'slash' | 'chat',
  ): Promise<ComposerOutcome> => {
    if (!bookId) return { ok: false, message: 'Load or create a book first.' }
    try {
      const plan = asCommandPlan(await call('plan_sequence_edit', {
        book_id: bookId,
        source_surface: sourceSurface,
        actor: 'videobook-user',
        request,
      }))
      return await previewCommandPlan(plan)
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  const applyPendingCommandPlan = async () => {
    if (!bookId || !pendingCommandPlan) return
    setBusy(true)
    try {
      let latestActionId = ''
      let queuedCount = 0
      for (const stage of pendingCommandPlan.plan.stages) {
        if (stage.kind === 'edit') {
          const preview = pendingCommandPlan.previews[stage.stageId]
          if (!preview?.valid) {
            throw new Error('The plan has conflicts and cannot be applied')
          }
          const committed = record(await call('commit_edit_intent', {
            book_id: bookId,
            intent: stage.intent,
            preview_hash: preview.previewHash,
          }))
          latestActionId = asString(committed?.actionId) ?? latestActionId
          continue
        }
        if (
          stage.kind === 'queued'
          && stage.jobType === 'export'
          && stage.tool === 'export_sequence'
        ) {
          await call('enqueue_sequence_export', {
            book_id: bookId,
            confirm: true,
            sequence_revision: stage.input.sequence_revision,
            orientation: stage.input.orientation,
            captions: stage.input.captions,
          })
          queuedCount += 1
          continue
        }
        if (
          stage.kind === 'queued'
          && stage.jobType === 'generation'
          && stage.tool === 'run_notebook_cell'
        ) {
          if (!online) {
            throw new Error('Offline: cloud generation is unavailable. The plan remains preserved.')
          }
          const consentKey = 'videobook.cloud-generation-consent'
          if (window.localStorage.getItem(consentKey) !== 'accepted') {
            const accepted = window.confirm(
              `Cloud generation disclosure\n\nProvider/model: ${stage.provider ?? 'unknown'} · ${stage.model ?? stage.tool}\n`
              + 'Payload class: prompt text and connected media references.\n'
              + 'Your local source files are sent only when required by the selected model.\n\n'
              + 'Continue and remember this choice on this device?',
            )
            if (!accepted) throw new Error('Cloud generation cancelled before sending data')
            window.localStorage.setItem(consentKey, 'accepted')
          }
          const notebookId = asString(stage.input.notebook_id)
          const cellId = asString(stage.input.cell_id)
          if (!notebookId || !cellId) {
            throw new Error('The generation plan is missing its notebook cell')
          }
          await call('run_notebook_cell', {
            book_id: bookId,
            notebook_id: notebookId,
            cell_id: cellId,
            plan: pendingCommandPlan.plan,
            actor: 'videobook-user',
          })
          queuedCount += 1
          continue
        }
        if (stage.kind === 'queued') {
          throw new Error(`Queued ${stage.jobType} execution is not available from this plan yet`)
        }
      }
      setPendingCommandPlan(null)
      setLastEditActionId(latestActionId)
      await refreshBookData(bookId, notebook?.id)
      setNotice(queuedCount > 0
        ? `CommandPlan accepted · ${queuedCount} queued job`
        : 'CommandPlan committed to a new sequence revision')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
      const hasGeneration = pendingCommandPlan.plan.stages.some((stage) =>
        stage.kind === 'queued' && stage.jobType === 'generation')
      if (pendingCommandPlan && !hasGeneration) {
        try {
          const refreshed = await prepareSequenceEdit(
            requestFromEditStage(pendingCommandPlan.plan.stages),
            pendingCommandPlan.plan.sourceSurface === 'system'
              ? 'ui'
              : pendingCommandPlan.plan.sourceSurface,
          )
          if (!refreshed.ok) setNotice(refreshed.message)
        } catch {
          setPendingCommandPlan(null)
          setNotice('The sequence changed. Recreate this plan against the current cut.')
        }
      }
    } finally {
      setBusy(false)
    }
  }

  const restoreLastCommandPlan = async () => {
    if (!bookId || !lastEditActionId) return
    const confirmed = window.confirm(
      'Restore the sequence state before the last applied plan?\n\n'
      + 'This creates a new forward revision.',
    )
    if (!confirmed) return
    setBusy(true)
    try {
      const action = record(await call('get_edit_action', {
        book_id: bookId,
        action_id: lastEditActionId,
      }))
      const targetRevision = asString(action?.baseRevision)
      if (!targetRevision) throw new Error('The edit audit has no base revision')
      const restored = record(await call('restore_edit_action', {
        book_id: bookId,
        target_revision: targetRevision,
        base_revision: sequence?.revision ?? asString(action?.committedRevision) ?? '',
        actor: 'videobook-user',
        source_surface: 'ui',
      }))
      setLastEditActionId(asString(restored?.actionId) ?? '')
      await refreshBookData(bookId, notebook?.id)
      setNotice('Restored the previous sequence state as a forward revision')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const prepareRoughCut = async (
    sourceSurface: 'ui' | 'slash' | 'chat',
  ): Promise<ComposerOutcome> => {
    if (!bookId || !notebook || !sequence) {
      return { ok: false, message: 'Open a notebook sequence first.' }
    }
    const beats = sequence.captions.slice(0, 20).map((cue) => ({
      beat_id: cue.cueId,
      text: cue.text,
      timeline_start_frame: cue.timelineStartFrame,
      duration_frames: cue.durationFrames,
    }))
    if (beats.length === 0) {
      return {
        ok: false,
        message: 'Generate transcript captions first so narration beats have exact timing.',
      }
    }
    try {
      const value = await call('plan_notebook_rough_cut', {
        book_id: bookId,
        notebook_id: notebook.id,
        source_surface: sourceSurface,
        actor: 'videobook-user',
        beats,
        min_shot_frames: 30,
        max_shot_frames: 120,
        max_repeats_per_artifact: 1,
      })
      const result = record(value)
      if (result?.kind === 'rough-cut-uncovered') {
        const uncovered = Array.isArray(result.uncoveredBeats)
          ? result.uncoveredBeats.length
          : beats.length
        return {
          ok: false,
          message: `No existing indexed coverage for ${uncovered} narration beats.`,
        }
      }
      return await previewCommandPlan(asCommandPlan(value))
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  const prepareNotebookCleanup = async (
    sourceSurface: 'ui' | 'slash' | 'chat',
  ): Promise<ComposerOutcome> => {
    if (!bookId || !notebook) {
      return { ok: false, message: 'Open an audio notebook first.' }
    }
    try {
      const value = await call('plan_notebook_cleanup', {
        book_id: bookId,
        notebook_id: notebook.id,
        source_surface: sourceSurface,
        actor: 'videobook-user',
      })
      const result = record(value)
      if (result?.kind === 'no-cleanup-suggestions') {
        return { ok: true, message: 'No filler, long silence, or weak sections found.' }
      }
      return await previewCommandPlan(asCommandPlan(value))
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  const prepareSoundEffects = async (
    sourceSurface: 'ui' | 'slash' | 'chat',
  ): Promise<ComposerOutcome> => {
    if (!bookId || !sequence) {
      return { ok: false, message: 'Open a sequence first.' }
    }
    const moments = sequence.captions.slice(0, 20).map((cue) => ({
      beat_id: cue.cueId,
      text: cue.text,
      timeline_start_frame: cue.timelineStartFrame,
      duration_frames: cue.durationFrames,
    }))
    if (moments.length === 0) {
      return {
        ok: false,
        message: 'Generate transcript captions first so sound suggestions have exact timing.',
      }
    }
    try {
      const value = await call('plan_sequence_sound_effects', {
        book_id: bookId,
        source_surface: sourceSurface,
        actor: 'videobook-user',
        moments,
        max_repeats_per_artifact: 1,
      })
      const result = record(value)
      if (result?.kind === 'sound-effects-uncovered') {
        return {
          ok: false,
          message: 'No existing indexed sound effects cover these beats. Generation is available as a fallback.',
        }
      }
      return await previewCommandPlan(asCommandPlan(value))
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  const addSequenceTrack = async (
    kind: 'video' | 'audio' | 'caption',
    name?: string,
  ): Promise<ComposerOutcome> => {
    if (!bookId) return { ok: false, message: 'Load or create a book first.' }
    try {
      const nextSequence = asSequence(await call('add_sequence_track', {
        book_id: bookId,
        kind,
        ...(name?.trim() ? { name: name.trim() } : {}),
      }))
      if (!nextSequence) throw new Error('The server returned an invalid sequence')
      setSequence(nextSequence)
      setTimelineTrackName('')
      return { ok: true, message: `Added ${kind} track` }
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  const removeSequenceTrack = async (trackId: string): Promise<ComposerOutcome> => {
    if (!bookId) return { ok: false, message: 'Load or create a book first.' }
    try {
      const nextSequence = asSequence(await call('remove_sequence_track', {
        book_id: bookId,
        track_id: trackId,
      }))
      if (!nextSequence) throw new Error('The server returned an invalid sequence')
      setSequence(nextSequence)
      return { ok: true, message: 'Removed empty track' }
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  const handleTimelineKeyboard = (
    action: TimelineKeyboardAction,
    frame: number,
  ) => {
    if (action === 'mark-in') {
      setTimelineSelectionStart(String(frame))
      setNotice(`Marked in at frame ${frame}`)
      return
    }
    if (action === 'mark-out') {
      const start = Number(timelineSelectionStart)
      const duration = Math.max(1, frame - start)
      setTimelineSelectionDuration(String(duration))
      void selectTimelineRange(start, duration)
      return
    }
    if (action === 'search') {
      document.querySelector<HTMLInputElement>('.command-composer input')?.focus()
      return
    }
    if (action === 'zoom-in' || action === 'zoom-out') {
      setTimelineZoom((current) => Math.min(
        3,
        Math.max(0.5, current + (action === 'zoom-in' ? 0.25 : -0.25)),
      ))
      return
    }
    if (action === 'undo' || action === 'redo') {
      void restoreLastCommandPlan()
      return
    }
    const clip = selectedSequenceClip
      ?? sequence?.clips.find((candidate) =>
        frame >= candidate.timelineStartFrame
        && frame < candidate.timelineStartFrame + candidate.durationFrames)
    if (!clip) {
      setNotice('No clip is selected at the playhead')
      return
    }
    if (action === 'split') {
      void prepareSequenceEdit({
        kind: 'split',
        clip_id: clip.clipId,
        split_frame: frame,
      }, 'ui').then((outcome) => setNotice(outcome.message))
      return
    }
    if (action === 'delete') {
      void prepareSequenceEdit({
        kind: 'delete',
        clip_id: clip.clipId,
        ripple: true,
      }, 'ui').then((outcome) => setNotice(outcome.message))
    }
  }

  const executeCommand = async (input: string): Promise<ComposerOutcome> => {
    try {
      if (!bookId) return { ok: false, message: 'Load or create a book first.' }
      if (!input.startsWith('/')) {
        const generationMatch = input.match(
          /\b(?:generate|run)\s+(?:the\s+)?(?:cell\s+)?@?([a-z0-9-]+)/iu,
        )
        if (generationMatch && notebook) {
          const token = generationMatch[1].toLowerCase()
          const cell = notebook.cells.find((candidate) =>
            candidate.id.toLowerCase().startsWith(token)
            || candidate.title.toLowerCase() === token.replaceAll('-', ' '))
          if (!cell || (cell.type !== 'image' && cell.type !== 'video')) {
            return {
              ok: false,
              message: 'Name an image or video cell, for example: generate cell @cell-id',
            }
          }
          return await prepareGenerationPlan(cell.id, 'chat')
        }
        if (/\brough[\s-]?cut\b/iu.test(input)) {
          return await prepareRoughCut('chat')
        }
        if (/\bsound[\s-]?effects?\b|\bsfx\b/iu.test(input)) {
          return await prepareSoundEffects('chat')
        }
        if (/\b(?:clean(?:up)?|filler|long silence|weak section)\b/iu.test(input)) {
          return await prepareNotebookCleanup('chat')
        }
        const value = await call('plan_chat_command', {
          book_id: bookId,
          actor: 'videobook-user',
          prompt: input,
        })
        const result = record(value)
        if (result?.kind === 'clarification') {
          return {
            ok: false,
            message: asString(result.message) ?? 'Clarify the edit you want to make.',
          }
        }
        return await previewCommandPlan(asCommandPlan(value))
      }
      const [commandToken, ...restParts] = input.trim().split(/\s+/)
      const rest = restParts.join(' ')
      if (commandToken === '/rough-cut') {
        return await prepareRoughCut('slash')
      }
      if (commandToken === '/cleanup') {
        return await prepareNotebookCleanup('slash')
      }
      if (commandToken === '/sound-effects') {
        return await prepareSoundEffects('slash')
      }
      if (commandToken === '/generate-cell') {
        if (!notebook || restParts.length !== 1) {
          return { ok: false, message: 'Usage: /generate-cell @cell-id' }
        }
        const token = restParts[0].replace(/^@/u, '').toLowerCase()
        const cell = notebook.cells.find((candidate) =>
          candidate.id.toLowerCase().startsWith(token))
        if (!cell || (cell.type !== 'image' && cell.type !== 'video')) {
          return { ok: false, message: 'Choose an image or video generation cell' }
        }
        return await prepareGenerationPlan(cell.id, 'slash')
      }
      if (commandToken === '/track-add') {
        const [kindValue, ...nameParts] = restParts
        if (
          kindValue !== 'video'
          && kindValue !== 'audio'
          && kindValue !== 'caption'
        ) {
          return {
            ok: false,
            message: 'Usage: /track-add video|audio|caption [name]',
          }
        }
        return await addSequenceTrack(kindValue, nameParts.join(' '))
      }
      if (commandToken === '/track-remove') {
        const track = sequenceTrackReference(sequence, restParts[0])
        if (!track || restParts.length !== 1) {
          return { ok: false, message: 'Usage: /track-remove @track-id' }
        }
        return await removeSequenceTrack(track.trackId)
      }
      if (commandToken === '/export') {
        if (!sequence) return { ok: false, message: 'Load the primary sequence first.' }
        const aspectIndex = restParts.indexOf('--aspect')
        const captionsIndex = restParts.indexOf('--captions')
        const aspect = aspectIndex >= 0 ? restParts[aspectIndex + 1] : '16:9'
        const captionValue = captionsIndex >= 0 ? restParts[captionsIndex + 1] : 'burned'
        const orientation = aspect === '9:16'
          ? 'portrait'
          : aspect === '1:1'
            ? 'square'
            : aspect === '16:9'
              ? 'landscape'
              : null
        const captions = captionValue === 'burned'
          ? 'burn-in'
          : captionValue === 'sidecar' || captionValue === 'omit'
            ? captionValue
            : null
        const positional = restParts.filter((value, index) =>
          value !== '--aspect'
          && value !== '--captions'
          && restParts[index - 1] !== '--aspect'
          && restParts[index - 1] !== '--captions')
        if (
          !orientation
          || !captions
          || positional.some((value) =>
            value !== '@sequence-main' && value !== `@${sequence.sequenceId}`)
        ) {
          return {
            ok: false,
            message: 'Usage: /export @sequence-main --aspect 16:9|9:16|1:1 --captions burned|sidecar|omit',
          }
        }
        const value = await call('plan_sequence_export', {
          book_id: bookId,
          source_surface: 'slash',
          actor: 'videobook-user',
          sequence_revision: sequence.revision,
          orientation,
          captions,
        })
        const invalid = record(value)
        if (invalid?.kind === 'invalid-export') {
          const validation = record(invalid.validation)
          const errors = Array.isArray(validation?.errors)
            ? validation.errors.map((entry) =>
                asString(record(entry)?.message)).filter(Boolean)
            : []
          return { ok: false, message: errors.join(' · ') || 'Export validation failed' }
        }
        return await previewCommandPlan(asCommandPlan(value))
      }
      if (commandToken === '/caption') {
        const [startValue, durationValue, styleValue, ...textParts] = restParts
        const startFrame = Number(startValue)
        const durationFrames = Number(durationValue)
        const style = styleValue === 'clean'
          || styleValue === 'bold'
          || styleValue === 'high-contrast'
          ? styleValue
          : null
        const text = textParts.join(' ').trim()
        if (
          !Number.isSafeInteger(startFrame)
          || startFrame < 0
          || !Number.isSafeInteger(durationFrames)
          || durationFrames < 1
          || !style
          || !text
        ) {
          return {
            ok: false,
            message: 'Usage: /caption <start-frame> <duration-frames> clean|bold|high-contrast <text>',
          }
        }
        return await prepareSequenceEdit({
          kind: 'caption',
          timeline_start_frame: startFrame,
          duration_frames: durationFrames,
          text,
          style_id: style,
        }, 'slash')
      }
      if (commandToken === '/move') {
        const [clipValue, trackValue, startValue] = restParts
        const clip = sequenceClipReference(sequence, clipValue)
        const track = sequenceTrackReference(sequence, trackValue)
        const startFrame = Number(startValue)
        if (!clip || !track || !Number.isSafeInteger(startFrame) || startFrame < 0) {
          return {
            ok: false,
            message: 'Usage: /move @clip-id @track-id <start-frame>',
          }
        }
        return await prepareSequenceEdit({
          kind: 'move',
          clip_id: clip.clipId,
          track_id: track.trackId,
          timeline_start_frame: startFrame,
        }, 'slash')
      }
      if (commandToken === '/split') {
        const [clipValue, frameValue] = restParts
        const clip = sequenceClipReference(sequence, clipValue)
        const splitFrame = Number(frameValue)
        if (!clip || !Number.isSafeInteger(splitFrame)) {
          return { ok: false, message: 'Usage: /split @clip-id <sequence-frame>' }
        }
        return await prepareSequenceEdit({
          kind: 'split',
          clip_id: clip.clipId,
          split_frame: splitFrame,
        }, 'slash')
      }
      if (commandToken === '/delete') {
        const clip = sequenceClipReference(sequence, restParts[0])
        const unknown = restParts.slice(1).filter((value) => value !== '--ripple')
        if (!clip || unknown.length > 0) {
          return { ok: false, message: 'Usage: /delete @clip-id [--ripple]' }
        }
        return await prepareSequenceEdit({
          kind: 'delete',
          clip_id: clip.clipId,
          ripple: restParts.includes('--ripple'),
        }, 'slash')
      }
      if (commandToken === '/gap') {
        const startFrame = Number(restParts[0])
        const durationFrames = Number(restParts[1])
        const track = sequenceTrackReference(sequence, restParts[2])
        if (
          !Number.isSafeInteger(startFrame)
          || startFrame < 0
          || !Number.isSafeInteger(durationFrames)
          || durationFrames < 1
          || (restParts[2] !== undefined && !track)
        ) {
          return {
            ok: false,
            message: 'Usage: /gap <start-frame> <duration-frames> [@track-id]',
          }
        }
        return await prepareSequenceEdit({
          kind: 'gap',
          timeline_start_frame: startFrame,
          duration_frames: durationFrames,
          ...(track ? { track_ids: [track.trackId] } : {}),
        }, 'slash')
      }
      if (commandToken === '/fit') {
        const clip = sequenceClipReference(sequence, restParts[0])
        const fit = restParts[1]
        if (!clip || (fit !== 'fit' && fit !== 'fill' && fit !== 'crop')) {
          return { ok: false, message: 'Usage: /fit @clip-id fit|fill|crop' }
        }
        return await prepareSequenceEdit({
          kind: 'transform',
          clip_id: clip.clipId,
          fit,
        }, 'slash')
      }
      if (commandToken === '/reframe') {
        const clip = sequenceClipReference(sequence, restParts[0])
        if (!clip) {
          return { ok: false, message: 'Usage: /reframe @visual-clip-id' }
        }
        return await prepareSequenceEdit({
          kind: 'reframe',
          clip_id: clip.clipId,
        }, 'slash')
      }
      if (commandToken === '/reverse') {
        const clip = sequenceClipReference(sequence, restParts[0])
        if (!clip || clip.source.kind !== 'timed') {
          return { ok: false, message: 'Usage: /reverse @timed-clip-id' }
        }
        const timedClip = clip as TimedSequenceClip
        return await prepareSequenceEdit({
          kind: 'speed',
          clip_id: timedClip.clipId,
          numerator: timedClip.speed.numerator,
          denominator: timedClip.speed.denominator,
          reverse: !timedClip.reverse,
          audio_policy: timedClip.audioPolicy,
        }, 'slash')
      }
      if (commandToken === '/duck') {
        const clip = sequenceClipReference(sequence, restParts[0])
        const reductionDb = restParts[1] === undefined
          ? -12
          : Number(restParts[1])
        if (
          !clip
          || !Number.isFinite(reductionDb)
          || reductionDb < -36
          || reductionDb > -1
        ) {
          return {
            ok: false,
            message: 'Usage: /duck @narration-clip-id [reduction-db from -36 to -1]',
          }
        }
        return await prepareSequenceEdit({
          kind: 'duck',
          narration_clip_id: clip.clipId,
          reduction_db: reductionDb,
        }, 'slash')
      }
      if (
        commandToken === '/insert'
        || commandToken === '/overwrite'
        || commandToken === '/trim'
        || commandToken === '/volume'
      ) {
        const values = restParts.map((value) =>
          value.startsWith('@') ? value.slice(1) : value)
        if (commandToken === '/insert' || commandToken === '/overwrite') {
          const [source, startValue, durationValue] = values
          const asset = assets.find((candidate) =>
            candidate.id === source || candidate.artifactId === source)
          const startFrame = Number(startValue)
          const durationFrames = durationValue === undefined
            ? undefined
            : Number(durationValue)
          if (
            !asset
            || !Number.isSafeInteger(startFrame)
            || startFrame < 0
            || (
              durationFrames !== undefined
              && (!Number.isSafeInteger(durationFrames) || durationFrames < 1)
            )
          ) {
            return {
              ok: false,
              message: `Usage: ${commandToken} @asset <start-frame> [duration-frames]`,
            }
          }
          return await prepareSequenceEdit({
            kind: 'insert',
            mode: commandToken === '/overwrite' ? 'overwrite' : 'insert',
            artifact_id: asset.artifactId,
            timeline_start_frame: startFrame,
            ...(durationFrames === undefined ? {} : { duration_frames: durationFrames }),
          }, 'slash')
        }
        if (commandToken === '/trim') {
          const [clipValue, startValue, durationValue] = values
          const clip = sequenceClipReference(sequence, clipValue)
          const startFrame = Number(startValue)
          const durationFrames = Number(durationValue)
          if (
            !clip
            || !Number.isSafeInteger(startFrame)
            || startFrame < 0
            || !Number.isSafeInteger(durationFrames)
            || durationFrames < 1
          ) {
            return {
              ok: false,
              message: 'Usage: /trim @clip-id <start-frame> <duration-frames>',
            }
          }
          return await prepareSequenceEdit({
            kind: 'trim',
            clip_id: clip.clipId,
            timeline_start_frame: startFrame,
            duration_frames: durationFrames,
          }, 'slash')
        }
        const [clipValue, gainValue] = values
        const clip = sequenceClipReference(sequence, clipValue)
        const gainDb = Number(gainValue)
        if (!clip || !Number.isFinite(gainDb) || gainDb < -96 || gainDb > 24) {
          return {
            ok: false,
            message: 'Usage: /volume @clip-id <gain-db from -96 to 24>',
          }
        }
        return await prepareSequenceEdit({
          kind: 'volume',
          clip_id: clip.clipId,
          gain_db: gainDb,
        }, 'slash')
      }
      const command = selectCommandForInput(commands, commandToken, rest)
      if (!command) return { ok: false, message: `Unknown command: ${commandToken}` }
      if (command.uiAction === 'switch_book') {
        const slug = command.command.slice(1)
        const target = books.find((book) => book.slug === slug)
        if (!target) return { ok: false, message: `Book not found: ${slug}` }
        await chooseBook(target.bookId)
        return { ok: true, message: `Opened ${slug}` }
      }
      if (command.uiAction === 'open_projects') {
        setBookMenuOpen(true)
        return { ok: true, message: 'Book switcher opened' }
      }
      if (command.uiAction === 'open_notebook') {
        setScreen('notebook')
        return { ok: true, message: 'Notebook opened' }
      }
      if (command.uiAction === 'open_provider_keys') {
        setScreen('settings')
        await refreshSettings()
        return { ok: true, message: 'Settings opened' }
      }
      if (!command.mcpTool) return { ok: false, message: `${command.command} is available from its workspace.` }
      const parsed = parseCommandArgs(rest, command.params)
      const adapted = adaptCommandArgs(command.mcpTool.adapter, command.mcpTool.tool, parsed)
      const args: CommandToolArgs = {
        ...adapted,
        ...(command.mcpTool.injectParams ?? {}),
      }
      if (command.mcpTool.autoInject?.includes('book_id')) args.book_id = bookId
      const result = await call(command.mcpTool.tool, args)
      await refreshBookData(bookId, notebook?.id)
      return { ok: true, message: messageFor(result, `${command.command} complete`) }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  const navigate = (next: Screen) => {
    setScreen(next)
    if (next === 'settings') void refreshSettings()
    if ((next === 'library' || next === 'timeline' || next === 'jobs') && bookId) {
      void refreshBookData(bookId, notebook?.id).catch((error: unknown) => {
        setNotice(error instanceof Error ? error.message : String(error))
      })
    }
  }

  return (
    <main className={`app-shell app-screen-${screen} ${inspectorOpen ? 'inspector-visible' : 'inspector-hidden'}`}>
      <header className="topbar">
        <div className="topbar-book-controls">
          <div className="brand-project">
            <div className="brand-project-trigger">
              <button
                type="button"
                className="brand-project-home"
                title="Open notebook"
                onClick={() => navigate('notebook')}
              >
                <BookOpen size={18} />
                <span>/videobook</span>
              </button>
              <button
                type="button"
                className="brand-project-menu-toggle"
                aria-expanded={bookMenuOpen}
                aria-haspopup="menu"
                onClick={() => setBookMenuOpen((open) => !open)}
              >
                <strong>{activeBook?.slug ?? 'select-book'}</strong>
                <ChevronDown size={14} />
              </button>
            </div>
            {bookMenuOpen && (
              <div className="project-menu book-menu" role="menu" aria-label="Videobook projects">
                {books.map((book) => (
                  <button
                    key={book.bookId}
                    type="button"
                    role="menuitem"
                    disabled={busy}
                    className={book.bookId === bookId ? 'active' : ''}
                    onClick={() => void chooseBook(book.bookId)}
                  >
                    <span>{book.slug}</span>
                    <small>{book.notebookCount} notebooks</small>
                    {book.bookId === bookId && <Check size={13} />}
                  </button>
                ))}
                {books.length === 0 && <span>No projects available</span>}
              </div>
            )}
          </div>
        </div>
        <nav className="header-navigation" aria-label="Workspace navigation">
          <button type="button" title="Refresh books" aria-label="Refresh books" disabled={busy || mcp.state !== 'ready'} onClick={() => void loadBooks(bookId)}>
            {busy ? <LoaderCircle className="spin" size={17} /> : <RefreshCw size={17} />}
          </button>
          {screenNavigation.map((item) => {
            const Icon = item.icon
            return (
              <button key={item.id} type="button" className={screen === item.id ? 'active' : ''} title={item.label} aria-label={`Open ${item.label}`} onClick={() => navigate(item.id)}>
                <Icon size={17} />
              </button>
            )
          })}
        </nav>
      </header>
      {!online && (
        <div className="offline-banner" role="status">
          Offline · local import, search, editing, playback, history, and export remain available
        </div>
      )}

      <>
          {screen === 'notebook' && (
            <>
              <section className="canvas">
                {!notebook ? (
                  <div className="canvas-empty-state">
                    <strong>No notebook available</strong>
                    <button type="button" onClick={() => void loadBooks(bookId)}>Reload book</button>
                  </div>
                ) : (
                  <ReactFlow<CanvasNode, Edge>
                    nodes={nodes}
                    edges={edges}
                    nodeTypes={nodeTypes}
                    onInit={(instance) => { flowRef.current = instance }}
                    onNodesChange={(changes) => setNodes((current) => applyNodeChanges(changes, current))}
                    onEdgesChange={(changes) => {
                      setEdges((current) => applyEdgeChanges(changes, current))
                      const removed = changes.filter((change) => change.type === 'remove').map((change) => change.id)
                      if (removed.length > 0) void removeEdges(removed)
                    }}
                    onNodeClick={(_event, node) => {
                      setSelectedCellId(node.id)
                      setInspectorOpen(true)
                    }}
                    onPaneClick={() => setSelectedCellId(null)}
                    onNodeDrag={(_event, node) => {
                      setPreviewSlot(notebookGridSlot(node.position))
                    }}
                    onNodeDragStop={(_event, node) => {
                      const nextNodes = resolveNotebookGridMove(
                        nodes,
                        node.id,
                        notebookGridSlot(node.position),
                      )
                      setNodes(nextNodes)
                      setPreviewSlot(null)
                      void persistPositions(nextNodes)
                    }}
                    onConnect={(connection) => void connectCells(connection)}
                    onDrop={(event) => {
                      event.preventDefault()
                      const raw = event.dataTransfer.getData('application/x-videobook-cell')
                      if (!cellPalette.some((item) => item.type === raw)) return
                      const point = flowRef.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY })
                      setPreviewSlot(null)
                      void createCell(raw as NotebookCellType, point)
                    }}
                    onDragOver={(event) => {
                      event.preventDefault()
                      const point = flowRef.current?.screenToFlowPosition({
                        x: event.clientX,
                        y: event.clientY,
                      })
                      if (point) setPreviewSlot(notebookGridSlot(point))
                    }}
                    fitView={nodes.length > 0}
                    fitViewOptions={window.innerWidth <= 560
                      ? compactFlowFitViewOptions
                      : flowFitViewOptions}
                    minZoom={0.35}
                    maxZoom={1.5}
                    deleteKeyCode={null}
                    proOptions={flowProOptions}
                  >
                    <NotebookStageBoard
                      nodes={nodes}
                      previewSlot={previewSlot}
                      labels={notebookStageLabels(notebook)}
                    />
                    <Background gap={36} size={1} color="rgba(96, 196, 141, 0.14)" />
                    <Panel position="top-left" className="canvas-add-panel">
                      <details className="canvas-add-menu">
                        <summary><Plus size={15} />Add cell</summary>
                        <div>
                          {cellPalette.map((item) => {
                            const Icon = item.icon
                            return (
                              <button
                                key={item.type}
                                type="button"
                                draggable
                                disabled={busy}
                                onDragStart={(event) => event.dataTransfer.setData('application/x-videobook-cell', item.type)}
                                onDragEnd={() => setPreviewSlot(null)}
                                onClick={() => void createCell(item.type)}
                              >
                                <Icon size={15} /><span>{item.label}</span>
                              </button>
                            )
                          })}
                        </div>
                      </details>
                    </Panel>
                  </ReactFlow>
                )}
                {notebook && nodes.length === 0 && (
                  <div className="canvas-welcome">
                    <div className="canvas-welcome-mark"><Sparkles size={22} /></div>
                    <span>EMPTY NOTEBOOK</span>
                    <strong>Build your first generation path.</strong>
                    <p>Start with a prompt, then connect image and video cells as the story takes shape.</p>
                    <button type="button" disabled={busy} onClick={() => void createCell('prompt')}>
                      <Plus size={15} />Add first prompt
                    </button>
                  </div>
                )}
                {!inspectorOpen && (
                  <button
                    type="button"
                    className="inspector-reopen"
                    title="Open inspector"
                    aria-label="Open inspector"
                    onClick={() => setInspectorOpen(true)}
                  >
                    <PanelRightOpen size={16} />
                  </button>
                )}
              </section>
              <aside className={`inspector ${inspectorOpen ? '' : 'inspector-closed'}`}>
                <header>
                  <span>{selectedCell ? `${selectedCell.data.kind.toUpperCase()} CELL` : 'INSPECTOR'}</span>
                  <button type="button" aria-label="Close inspector" onClick={() => setInspectorOpen(false)}>
                    <PanelRightClose size={16} />
                  </button>
                </header>
                {!selectedCell ? (
                  <div className="inspector-body audio-notebook-inspector">
                    <span className="section-label">AUDIO NOTEBOOK</span>
                    <h2 className="inspector-slug">
                      {audioNotebook.spine?.slug ?? 'Choose an audio spine'}
                    </h2>
                    <label>
                      Audio or video source
                      <select
                        value={audioSpineAssetId}
                        onChange={(event) => setAudioSpineAssetId(event.target.value)}
                      >
                        <option value="">Select source</option>
                        {sourceAssets
                          .filter((asset) => asset.type === 'audio' || asset.type === 'video')
                          .map((asset) => (
                            <option key={asset.artifactId} value={asset.artifactId}>
                              {asset.id} · {asset.type}
                            </option>
                          ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      disabled={busy || !audioSpineAssetId}
                      onClick={() => void setAudioSpine()}
                    >
                      <AudioWaveform size={14} />Set notebook spine
                    </button>
                    {audioSpineAsset?.mediaUrl && (
                      <audio
                        ref={audioSpinePlayerRef}
                        className="audio-spine-player"
                        src={audioSpineAsset.mediaUrl}
                        controls
                        preload="metadata"
                      />
                    )}
                    {audioNotebook.waveform && audioNotebook.waveform.length > 0 && (
                      <div className="audio-spine-waveform" aria-label="Audio waveform">
                        {audioNotebook.waveform
                          .filter((_peak, index) =>
                            index % Math.max(1, Math.ceil(audioNotebook.waveform!.length / 72)) === 0)
                          .map((peak, index) => (
                            <i
                              key={index}
                              style={{ height: `${Math.max(4, Math.min(100, Math.abs(peak) * 100))}%` }}
                            />
                          ))}
                      </div>
                    )}
                    <div className="audio-transcript">
                      <div className="workspace-section-heading">
                        <span className="section-label">
                          {audioNotebook.transcript
                            ? `${audioNotebook.transcript.language} · TIMED TRANSCRIPT`
                            : 'TRANSCRIPT'}
                        </span>
                        <h3>
                          {audioNotebook.transcript
                            ? `${audioNotebook.transcript.segments.length} segments`
                            : 'Processing or not yet transcribed'}
                        </h3>
                      </div>
                      {selectedTranscriptWordId && (
                        <div className="transcript-correction">
                          <label>
                            Correct selected word
                            <input
                              value={transcriptCorrection}
                              onChange={(event) => setTranscriptCorrection(event.target.value)}
                            />
                          </label>
                          <button
                            type="button"
                            disabled={busy || !transcriptCorrection.trim()}
                            onClick={() => void correctTranscriptWord()}
                          >
                            Save text only
                          </button>
                          <div className="transcript-selection-actions">
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => {
                                setSelectionStartWordId(selectedTranscriptWordId)
                                setNotice('Transcript selection start marked')
                              }}
                            >
                              {selectionStartWordId === selectedTranscriptWordId
                                ? 'Range starts here'
                                : 'Mark range start'}
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => {
                                setMoveDestinationWordId(selectedTranscriptWordId)
                                setNotice('Transcript move destination marked')
                              }}
                            >
                              {moveDestinationWordId === selectedTranscriptWordId
                                ? 'Move destination'
                                : 'Mark move destination'}
                            </button>
                            <button
                              type="button"
                              disabled={busy || !selectionStartWordId}
                              onClick={() => void selectTranscriptRange()}
                            >
                              Pin exact range
                            </button>
                            <button
                              type="button"
                              className="danger-button"
                              disabled={busy || !selectionStartWordId}
                              onClick={() => void removeTranscriptRange()}
                            >
                              Remove from sequence
                            </button>
                            <button
                              type="button"
                              disabled={
                                busy
                                || !selectionStartWordId
                                || !moveDestinationWordId
                              }
                              onClick={() => void moveTranscriptRange()}
                            >
                              Move range before destination
                            </button>
                          </div>
                        </div>
                      )}
                      {restorableTranscriptEdit && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void restoreTranscriptEdit()}
                        >
                          <Undo2 size={14} />Restore last transcript edit
                        </button>
                      )}
                      {audioNotebook.transcript?.segments.map((segment) => (
                        <section className={`transcript-segment transcript-${segment.kind}`} key={segment.segmentId}>
                          <span>{segment.speaker ?? segment.kind}</span>
                          <p>
                            {segment.words.length > 0
                              ? segment.words.map((word) => (
                                <button
                                  key={word.wordId}
                                  type="button"
                                  className={[
                                    word.wordId === selectedTranscriptWordId ? 'selected' : '',
                                    playheadTranscriptWordIds.has(word.wordId) ? 'playhead' : '',
                                    word.confidence !== undefined && word.confidence < 0.7 ? 'uncertain' : '',
                                    word.corrected ? 'corrected' : '',
                                  ].filter(Boolean).join(' ')}
                                  title="Click to play and select"
                                  onClick={() => {
                                    seekTranscriptWord(word, segment)
                                    setSelectedTranscriptWordId(word.wordId)
                                    setTranscriptCorrection(word.text)
                                  }}
                                  onDoubleClick={() => {
                                    setSelectedTranscriptWordId(word.wordId)
                                    setTranscriptCorrection(word.text)
                                  }}
                                >
                                  {word.text}
                                </button>
                              ))
                              : segment.text}
                          </p>
                        </section>
                      ))}
                    </div>
                    <div className="empty-inspector compact">
                      <CircleDot size={18} />
                      <strong>Select a notebook cell</strong>
                      <p>Cell editing appears here. Audio words remain bound to exact source ticks.</p>
                    </div>
                  </div>
                ) : (
                  <div className="inspector-body">
                    <h2 className="inspector-slug">{selectedCell.data.title}</h2>
                    <span className="workspace-notice">{selectedCell.data.kind.toUpperCase()} · {selectedCell.data.status}</span>
                    <label>
                      Title
                      <input defaultValue={selectedCell.data.title} onBlur={(event) => {
                        const title = event.target.value.trim()
                        if (title && title !== selectedCell.data.title) void updateCell({ title })
                      }} />
                    </label>
                    {(selectedCell.data.kind === 'prompt' || selectedCell.data.kind === 'image' || selectedCell.data.kind === 'video') && (
                      <label>
                        Prompt
                        <textarea defaultValue={selectedCell.data.prompt ?? ''} rows={8} onBlur={(event) => {
                          if (event.target.value !== (selectedCell.data.prompt ?? '')) void updateCell({ prompt: event.target.value })
                        }} />
                      </label>
                    )}
                    {(selectedCell.data.kind === 'image' || selectedCell.data.kind === 'video') && (
                      <label>
                        Tool model
                        <input defaultValue={selectedCell.data.model ?? ''} placeholder="Generation tool name" onBlur={(event) => {
                          if (event.target.value !== (selectedCell.data.model ?? '')) void updateCell({ model: event.target.value })
                        }} />
                      </label>
                    )}
                    {selectedCell.data.asset?.mediaUrl && (
                      <a className="inspector-media-link" href={selectedCell.data.asset.mediaUrl} target="_blank" rel="noreferrer">Open output</a>
                    )}
                    <div className="record-card-actions">
                      {(selectedCell.data.kind === 'image' || selectedCell.data.kind === 'video') && <button type="button" onClick={() => void runCell(selectedCell.id)} disabled={busy}>Run cell</button>}
                      <button type="button" className="danger-button" onClick={() => void deleteSelectedCell()} disabled={busy}><Trash2 size={13} />Delete</button>
                    </div>
                  </div>
                )}
              </aside>
            </>
          )}

          {screen === 'library' && (
            <section
              className="workspace-screen library-drop-zone"
              onDragOver={(event) => {
                if (event.dataTransfer.types.includes('Files')) event.preventDefault()
              }}
              onDrop={(event) => {
                if (!event.dataTransfer.files.length) return
                event.preventDefault()
                void uploadFiles([...event.dataTransfer.files])
              }}
              onPaste={(event) => {
                const files = [...event.clipboardData.files]
                if (files.length === 0) return
                event.preventDefault()
                void uploadFiles(files)
              }}
            >
              <header>
                <div><span className="section-label">SEARCHABLE SOURCE LIBRARY</span><h1>Find the exact moment.</h1><p>Search language, speech, OCR, imagery, video motion, and audio across {activeBook?.slug ?? 'the active project'}.</p></div>
                <div className="library-ingest-actions">
                  <button
                    type="button"
                    className={recording ? 'recording-button active' : 'recording-button'}
                    disabled={uploading}
                    onClick={recording ? stopRecording : () => void startRecording()}
                  >
                    {recording ? <Square size={14} /> : <Mic size={15} />}
                    {recording ? 'Stop recording' : 'Record audio'}
                  </button>
                  <label className="upload-button">{uploading ? 'Importing…' : 'Import files'}<input type="file" multiple disabled={uploading} onChange={upload} /></label>
                </div>
              </header>
              <form className="library-url-import" onSubmit={importFromUrl}>
                <label>
                  Import supported URL
                  <input
                    type="url"
                    value={importUrl}
                    onChange={(event) => setImportUrl(event.target.value)}
                    placeholder="https://youtube.com/…"
                  />
                </label>
                <button type="submit" disabled={uploading || !importUrl.trim()}>
                  Import URL
                </button>
              </form>
              <MomentSearch
                bookId={bookId}
                notebookId={notebook?.id}
                canAttachToTranscript={canAttachToTranscript}
                activeSequenceRange={activeSequenceRange}
                assets={sourceAssets}
                disabled={busy || mcp.state !== 'ready'}
                call={call}
                onNotice={setNotice}
                onNotebookChanged={async () => {
                  if (notebook) await refreshNotebook(bookId, notebook.id)
                }}
              />
              <div className="workspace-section-heading">
                <span className="section-label">SOURCE ARTIFACTS</span>
                <h2>{sourceAssets.length} local artifacts</h2>
              </div>
              <div className="record-grid">
                {sourceAssets.map((asset) => (
                  <article className="record-card asset-card" key={asset.artifactId}>
                    <span>{asset.type.toUpperCase()} · {asset.status}</span>
                    {asset.mediaUrl
                      ? asset.type === 'video' || asset.type === 'final'
                        ? <video src={asset.mediaUrl} controls playsInline preload="metadata" />
                        : asset.type === 'audio'
                          ? <audio src={asset.mediaUrl} controls preload="metadata" />
                          : <img src={asset.thumbnailUrl ?? asset.mediaUrl} alt={asset.id} />
                      : <div className="asset-placeholder"><Library size={28} /></div>}
                    <strong>{asset.id}</strong><small>{asset.prompt ?? asset.createdAt}</small>
                    {ingestStatusById.get(asset.artifactId) && (
                      <>
                        <span className={`ingest-phase ingest-phase-${ingestStatusById.get(asset.artifactId)!.state}`}>
                          ingest · {ingestStatusById.get(asset.artifactId)!.state}
                        </span>
                        <div className="ingest-phase-grid">
                          {Object.entries(ingestStatusById.get(asset.artifactId)!.phases)
                            .map(([phase, state]) => (
                              <span className={`ingest-phase ingest-phase-${state}`} key={phase}>
                                {phase} · {state}
                              </span>
                            ))}
                        </div>
                      </>
                    )}
                    <button
                      type="button"
                      className="retry-ingest-button"
                      disabled={busy}
                      onClick={() => void retryIngest(asset.artifactId)}
                    >
                      <RefreshCw size={13} />Retry processing
                    </button>
                  </article>
                ))}
                {sourceAssets.length === 0 && <div className="empty-record"><Library size={25} /><strong>No assets yet</strong><p>Upload media or generate an image/video from the notebook.</p></div>}
              </div>
            </section>
          )}

          {screen === 'timeline' && (
            <section className="workspace-screen">
              <header>
                <div>
                  <span className="section-label">CANONICAL V5 SEQUENCE</span>
                  <h1>{sequence?.name ?? 'Primary sequence'}</h1>
                  <p>
                    {sequence
                      ? `${sequence.tracks.length} tracks · ${sequence.clips.length} clips · revision ${sequence.revision.slice(0, 10)}`
                      : 'Load the primary engine sequence.'}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={busy || !bookId}
                  onClick={() => bookId && void refreshBookData(bookId, notebook?.id)}
                >
                  <RefreshCw size={15} />Refresh sequence
                </button>
              </header>
              {sequence && sequence.clips.length > 0 && (
                <CanonicalSequencePlayer
                  sequence={sequence}
                  assets={playbackAssets}
                  onFrameUpdate={setTimelinePlayheadFrame}
                  onKeyboardAction={handleTimelineKeyboard}
                />
              )}
              <form className="project-create entity-create" onSubmit={(event) => {
                event.preventDefault()
                void selectTimelineRange()
              }}>
                <label>
                  Selection start frame
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={timelineSelectionStart}
                    onChange={(event) => setTimelineSelectionStart(event.target.value)}
                  />
                </label>
                <label>
                  Selection duration
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={timelineSelectionDuration}
                    onChange={(event) => setTimelineSelectionDuration(event.target.value)}
                  />
                </label>
                <button type="submit" disabled={busy || !notebook || !sequence}>
                  Sync to transcript
                </button>
              </form>
              <form className="timeline-track-controls" onSubmit={(event) => {
                event.preventDefault()
                void addSequenceTrack(timelineTrackKind, timelineTrackName)
                  .then((outcome) => setNotice(outcome.message))
              }}>
                <select
                  aria-label="New track kind"
                  value={timelineTrackKind}
                  onChange={(event) => setTimelineTrackKind(
                    event.target.value as typeof timelineTrackKind,
                  )}
                >
                  <option value="video">Video track</option>
                  <option value="audio">Audio track</option>
                  <option value="caption">Caption track</option>
                </select>
                <input
                  aria-label="New track name"
                  value={timelineTrackName}
                  onChange={(event) => setTimelineTrackName(event.target.value)}
                  placeholder="Optional name"
                />
                <button type="submit" disabled={busy || !sequence}>
                  <Plus size={14} />Add track
                </button>
              </form>
              <div className="timeline-edit-controls">
                <form onSubmit={(event) => {
                  event.preventDefault()
                  const startFrame = Number(timelineSelectionStart)
                  const durationFrames = Number(timelineSelectionDuration)
                  if (!timelineInsertAssetId || !Number.isSafeInteger(startFrame) || startFrame < 0) {
                    setNotice('Choose a source and a valid insertion frame')
                    return
                  }
                  void prepareSequenceEdit({
                    kind: 'insert',
                    artifact_id: timelineInsertAssetId,
                    timeline_start_frame: startFrame,
                    ...(Number.isSafeInteger(durationFrames) && durationFrames > 0
                      ? { duration_frames: durationFrames }
                      : {}),
                  }, 'ui').then((outcome) => setNotice(outcome.message))
                }}>
                  <label>
                    Source
                    <select
                      value={timelineInsertAssetId}
                      onChange={(event) => setTimelineInsertAssetId(event.target.value)}
                    >
                      <option value="">Choose asset</option>
                      {sourceAssets.map((asset) => (
                        <option value={asset.artifactId} key={asset.artifactId}>
                          {asset.id}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button type="submit" disabled={busy || !timelineInsertAssetId}>
                    Preview insert
                  </button>
                </form>
                <form onSubmit={(event) => {
                  event.preventDefault()
                  if (!selectedSequenceClip) {
                    setNotice('Select a sequence clip first')
                    return
                  }
                  void prepareSequenceEdit({
                    kind: 'trim',
                    clip_id: selectedSequenceClip.clipId,
                    timeline_start_frame: Number(timelineSelectionStart),
                    duration_frames: Number(timelineSelectionDuration),
                  }, 'ui').then((outcome) => setNotice(outcome.message))
                }}>
                  <span>Selected clip</span>
                  <strong>{selectedSequenceClip?.clipId.slice(0, 10) ?? 'None'}</strong>
                  <button type="submit" disabled={busy || !selectedSequenceClip}>
                    Preview trim
                  </button>
                </form>
                <form onSubmit={(event) => {
                  event.preventDefault()
                  const gainDb = Number(timelineGainDb)
                  if (!selectedSequenceClip || !Number.isFinite(gainDb)) {
                    setNotice('Select an audio clip and enter a valid gain')
                    return
                  }
                  void prepareSequenceEdit({
                    kind: 'volume',
                    clip_id: selectedSequenceClip.clipId,
                    gain_db: gainDb,
                    muted: timelineMuted,
                    fade_in_frames: Number(timelineFadeIn),
                    fade_out_frames: Number(timelineFadeOut),
                  }, 'ui').then((outcome) => setNotice(outcome.message))
                }}>
                  <label>
                    Gain dB
                    <input
                      type="number"
                      min="-96"
                      max="24"
                      step="0.5"
                      value={timelineGainDb}
                      onChange={(event) => setTimelineGainDb(event.target.value)}
                    />
                  </label>
                  <div className="timeline-inline-fields">
                    <label>
                      Fade in
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={timelineFadeIn}
                        onChange={(event) => setTimelineFadeIn(event.target.value)}
                      />
                    </label>
                    <label>
                      Fade out
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={timelineFadeOut}
                        onChange={(event) => setTimelineFadeOut(event.target.value)}
                      />
                    </label>
                  </div>
                  <label className="timeline-checkbox">
                    <input
                      type="checkbox"
                      checked={timelineMuted}
                      onChange={(event) => setTimelineMuted(event.target.checked)}
                    />
                    Mute
                  </label>
                  <button type="submit" disabled={busy || !selectedSequenceClip}>
                    Preview volume
                  </button>
                  <button
                    type="button"
                    disabled={busy || !selectedSequenceClip}
                    onClick={() => {
                      if (!selectedSequenceClip) return
                      void prepareSequenceEdit({
                        kind: 'duck',
                        narration_clip_id: selectedSequenceClip.clipId,
                        reduction_db: -12,
                      }, 'ui').then((outcome) => setNotice(outcome.message))
                    }}
                  >
                    Duck overlaps −12 dB
                  </button>
                </form>
                <form onSubmit={(event) => {
                  event.preventDefault()
                  if (!selectedSequenceClip || !timelineTargetTrackId) return
                  void prepareSequenceEdit({
                    kind: 'move',
                    clip_id: selectedSequenceClip.clipId,
                    track_id: timelineTargetTrackId,
                    timeline_start_frame: Number(timelineSelectionStart),
                  }, 'ui').then((outcome) => setNotice(outcome.message))
                }}>
                  <label>
                    Move to track
                    <select
                      value={timelineTargetTrackId}
                      onChange={(event) => setTimelineTargetTrackId(event.target.value)}
                    >
                      <option value="">Choose track</option>
                      {sequence?.tracks.filter((track) => {
                        const selectedTrack = sequence.tracks.find((candidate) =>
                          candidate.trackId === selectedSequenceClip?.trackId)
                        return selectedTrack?.kind === track.kind && track.kind !== 'caption'
                      }).map((track) => (
                        <option value={track.trackId} key={track.trackId}>
                          {track.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button type="submit" disabled={busy || !selectedSequenceClip || !timelineTargetTrackId}>
                    Preview move
                  </button>
                </form>
                <div className="timeline-quick-actions">
                  <span>Selected clip actions</span>
                  <div>
                    <button
                      type="button"
                      disabled={busy || !selectedSequenceClip}
                      onClick={() => {
                        if (!selectedSequenceClip) return
                        void prepareSequenceEdit({
                          kind: 'split',
                          clip_id: selectedSequenceClip.clipId,
                          split_frame: selectedSequenceClip.timelineStartFrame
                            + Math.floor(selectedSequenceClip.durationFrames / 2),
                        }, 'ui').then((outcome) => setNotice(outcome.message))
                      }}
                    >
                      Split midpoint
                    </button>
                    <button
                      type="button"
                      disabled={busy || !selectedSequenceClip}
                      onClick={() => {
                        if (!selectedSequenceClip) return
                        void prepareSequenceEdit({
                          kind: 'delete',
                          clip_id: selectedSequenceClip.clipId,
                          ripple: true,
                        }, 'ui').then((outcome) => setNotice(outcome.message))
                      }}
                    >
                      Ripple delete
                    </button>
                    <button
                      type="button"
                      disabled={busy || !selectedSequenceClip}
                      onClick={() => {
                        if (!selectedSequenceClip) return
                        void prepareSequenceEdit({
                          kind: 'gap',
                          timeline_start_frame: selectedSequenceClip.timelineStartFrame,
                          duration_frames: Number(timelineSelectionDuration),
                          track_ids: [selectedSequenceClip.trackId],
                        }, 'ui').then((outcome) => setNotice(outcome.message))
                      }}
                    >
                      Insert gap
                    </button>
                    <button
                      type="button"
                      disabled={busy || !selectedSequenceClip}
                      onClick={() => {
                        if (!selectedSequenceClip) return
                        void prepareSequenceEdit({
                          kind: 'transform',
                          clip_id: selectedSequenceClip.clipId,
                          fit: 'fit',
                        }, 'ui').then((outcome) => setNotice(outcome.message))
                      }}
                    >
                      Fit
                    </button>
                    <button
                      type="button"
                      disabled={busy || !selectedSequenceClip}
                      onClick={() => {
                        if (!selectedSequenceClip) return
                        void prepareSequenceEdit({
                          kind: 'reframe',
                          clip_id: selectedSequenceClip.clipId,
                        }, 'ui').then((outcome) => setNotice(outcome.message))
                      }}
                    >
                      Auto reframe
                    </button>
                    <button
                      type="button"
                      disabled={busy || selectedSequenceClip?.source.kind !== 'timed'}
                      onClick={() => {
                        if (!selectedSequenceClip || selectedSequenceClip.source.kind !== 'timed') return
                        const timedClip = selectedSequenceClip as TimedSequenceClip
                        void prepareSequenceEdit({
                          kind: 'speed',
                          clip_id: timedClip.clipId,
                          numerator: timedClip.speed.numerator,
                          denominator: timedClip.speed.denominator,
                          reverse: !timedClip.reverse,
                          audio_policy: timedClip.audioPolicy,
                        }, 'ui').then((outcome) => setNotice(outcome.message))
                      }}
                    >
                      Reverse
                    </button>
                  </div>
                </div>
                <form onSubmit={(event) => {
                  event.preventDefault()
                  if (!captionText.trim()) return
                  void prepareSequenceEdit({
                    kind: 'caption',
                    ...(selectedCaptionCueId ? { cue_id: selectedCaptionCueId } : {}),
                    timeline_start_frame: Number(timelineSelectionStart),
                    duration_frames: Number(timelineSelectionDuration),
                    text: captionText.trim(),
                    style_id: captionStyle,
                  }, 'ui').then((outcome) => setNotice(outcome.message))
                }}>
                  <label>
                    Caption text
                    <input
                      value={captionText}
                      onChange={(event) => setCaptionText(event.target.value)}
                      placeholder="Caption at selection"
                    />
                  </label>
                  <select
                    aria-label="Caption style"
                    value={captionStyle}
                    onChange={(event) => setCaptionStyle(
                      event.target.value as typeof captionStyle,
                    )}
                  >
                    <option value="clean">Clean</option>
                    <option value="bold">Bold</option>
                    <option value="high-contrast">High contrast</option>
                  </select>
                  <button type="submit" disabled={busy || !captionText.trim()}>
                    Preview caption
                  </button>
                  <button
                    type="button"
                    disabled={busy || !notebook || !audioNotebook.transcript}
                    onClick={() => {
                      if (!notebook) return
                      void call('plan_notebook_captions', {
                        book_id: bookId,
                        notebook_id: notebook.id,
                        source_surface: 'ui',
                        actor: 'videobook-user',
                        style_id: captionStyle,
                      }).then((value) =>
                        previewCommandPlan(asCommandPlan(value)))
                        .then((outcome) => setNotice(outcome.message))
                        .catch((error: unknown) => setNotice(
                          error instanceof Error ? error.message : String(error),
                        ))
                    }}
                  >
                    Generate from transcript
                  </button>
                  <button
                    type="button"
                    disabled={busy || !sequence || sequence.captions.length === 0}
                    onClick={() => void prepareRoughCut('ui')
                      .then((outcome) => setNotice(outcome.message))}
                  >
                    Suggest rough cut
                  </button>
                  <button
                    type="button"
                    disabled={busy || !audioNotebook.transcript}
                    onClick={() => void prepareNotebookCleanup('ui')
                      .then((outcome) => setNotice(outcome.message))}
                  >
                    Suggest cleanup
                  </button>
                  <button
                    type="button"
                    disabled={busy || !sequence || sequence.captions.length === 0}
                    onClick={() => void prepareSoundEffects('ui')
                      .then((outcome) => setNotice(outcome.message))}
                  >
                    Suggest sound effects
                  </button>
                </form>
                <form onSubmit={(event) => {
                  event.preventDefault()
                  if (!sequence) return
                  void call('plan_sequence_export', {
                    book_id: bookId,
                    source_surface: 'ui',
                    actor: 'videobook-user',
                    sequence_revision: sequence.revision,
                    orientation: exportOrientation,
                    captions: exportCaptions,
                  }).then((value) => {
                    const result = record(value)
                    if (result?.kind === 'invalid-export') {
                      const validation = record(result.validation)
                      const errors = Array.isArray(validation?.errors)
                        ? validation.errors.map((entry) =>
                            asString(record(entry)?.message)).filter(Boolean)
                        : []
                      setNotice(errors.join(' · ') || 'Export validation failed')
                      return
                    }
                    return previewCommandPlan(asCommandPlan(value))
                      .then((outcome) => setNotice(outcome.message))
                  }).catch((error: unknown) => {
                    setNotice(error instanceof Error ? error.message : String(error))
                  })
                }}>
                  <label>
                    Export
                    <select
                      value={exportOrientation}
                      onChange={(event) => setExportOrientation(
                        event.target.value as typeof exportOrientation,
                      )}
                    >
                      <option value="landscape">16:9 · 1080p</option>
                      <option value="portrait">9:16 · 1080p</option>
                      <option value="square">1:1 · 1080p</option>
                    </select>
                  </label>
                  <select
                    aria-label="Export captions"
                    value={exportCaptions}
                    onChange={(event) => setExportCaptions(
                      event.target.value as typeof exportCaptions,
                    )}
                  >
                    <option value="burn-in">Burn captions</option>
                    <option value="sidecar">WebVTT sidecar</option>
                    <option value="omit">No captions</option>
                  </select>
                  <button type="submit" disabled={busy || !sequence}>
                    Preview export
                  </button>
                </form>
              </div>
              <div className="sequence-track-list">
                <div className="timeline-scale-readout">
                  <span>PLAYHEAD F{timelinePlayheadFrame}</span>
                  <span>ZOOM {timelineZoom.toFixed(2)}×</span>
                </div>
                <div
                  className="timeline-zoom-surface"
                  style={{ width: `${timelineZoom * 100}%` }}
                >
                {sequence?.tracks.map((track) => {
                  const clips = sequence.clips
                    .filter((clip) => clip.trackId === track.trackId)
                    .sort((left, right) =>
                      left.timelineStartFrame - right.timelineStartFrame)
                  const cues = track.kind === 'caption'
                    ? sequence.captions
                      .filter((cue) => cue.trackId === track.trackId)
                      .sort((left, right) =>
                        left.timelineStartFrame - right.timelineStartFrame)
                    : []
                  const kindTrackCount = sequence.tracks
                    .filter((candidate) => candidate.kind === track.kind)
                    .length
                  const canRemoveTrack = clips.length === 0
                    && cues.length === 0
                    && kindTrackCount > 1
                  return (
                    <section className="sequence-track" key={track.trackId}>
                      <header>
                        <span>{track.kind.toUpperCase()} {track.ordinal + 1}</span>
                        <strong>{track.name}</strong>
                        <small>{track.kind === 'caption' ? `${cues.length} cues` : `${clips.length} clips`}</small>
                        {canRemoveTrack && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void removeSequenceTrack(track.trackId)
                              .then((outcome) => setNotice(outcome.message))}
                          >
                            <Trash2 size={13} />Remove
                          </button>
                        )}
                      </header>
                      <div className="record-grid">
                        {clips.map((clip) => {
                          const asset = assetById.get(clip.source.artifactId)
                          const selected = selectedSequenceClip?.clipId === clip.clipId
                            || (
                              activeSequenceRange?.startFrame === clip.timelineStartFrame
                              && activeSequenceRange.durationFrames === clip.durationFrames
                            )
                          return (
                            <button
                              type="button"
                              className={`record-card sequence-clip ${selected ? 'selected' : ''}`}
                              key={clip.clipId}
                              onClick={() => {
                                setSelectedSequenceClipId(clip.clipId)
                                setTimelineSelectionStart(String(clip.timelineStartFrame))
                                setTimelineSelectionDuration(String(clip.durationFrames))
                                setTimelineTargetTrackId(clip.trackId)
                                setTimelineGainDb(String(clip.audio?.gainDb ?? 0))
                                setTimelineFadeIn(String(clip.audio?.fadeInFrames ?? 0))
                                setTimelineFadeOut(String(clip.audio?.fadeOutFrames ?? 0))
                                setTimelineMuted(clip.audio?.muted ?? false)
                              }}
                            >
                              <span>
                                F{clip.timelineStartFrame}–{clip.timelineStartFrame + clip.durationFrames}
                              </span>
                              <strong>{asset?.id ?? clip.source.artifactId}</strong>
                              <small>
                                {clip.source.kind === 'timed'
                                  ? `${clip.source.range.startTick}+${clip.source.range.durationTicks} ticks`
                                  : clip.source.sourcePath}
                              </small>
                            </button>
                          )
                        })}
                        {cues.map((cue) => (
                          <button
                            type="button"
                            className={`record-card sequence-clip ${selectedCaptionCueId === cue.cueId ? 'selected' : ''}`}
                            key={cue.cueId}
                            onClick={() => {
                              setSelectedCaptionCueId(cue.cueId)
                              setCaptionText(cue.text)
                              setCaptionStyle(
                                cue.styleId === 'bold' || cue.styleId === 'high-contrast'
                                  ? cue.styleId
                                  : 'clean',
                              )
                              setTimelineSelectionStart(String(cue.timelineStartFrame))
                              setTimelineSelectionDuration(String(cue.durationFrames))
                            }}
                          >
                            <span>
                              F{cue.timelineStartFrame}–{cue.timelineStartFrame + cue.durationFrames}
                            </span>
                            <strong>{cue.text}</strong>
                            <small>{cue.styleId}{cue.speaker ? ` · ${cue.speaker}` : ''}</small>
                          </button>
                        ))}
                        {clips.length === 0 && cues.length === 0 && (
                          <div className="empty-record compact">
                            <strong>Empty track</strong>
                          </div>
                        )}
                      </div>
                    </section>
                  )
                })}
                </div>
                {!sequence && (
                  <div className="empty-record">
                    <Film size={25} />
                    <strong>Primary sequence unavailable</strong>
                    <p>Refresh the selected book to load its engine sequence.</p>
                  </div>
                )}
              </div>
            </section>
          )}

          {screen === 'jobs' && (
            <section className="workspace-screen">
              <header><div><span className="section-label">PERSISTENT JOBS</span><h1>Book job queue</h1><p>Generation, processing, and notebook runs are recorded in the selected book’s durable queue.</p></div><button type="button" disabled={busy} onClick={() => bookId && void refreshBookData(bookId, notebook?.id)}><RefreshCw size={15} />Refresh</button></header>
              {generationPlans.length > 0 && (
                <div className="workspace-section-heading">
                  <h2>Generation plans</h2>
                  <p>Review output, retry unchanged, switch model, omit, or continue into the canonical sequence.</p>
                </div>
              )}
              <div className="record-grid">
                {generationPlans.map((plan) => {
                  const stage = plan.plan.stages.find((candidate) =>
                    candidate.kind === 'queued' && candidate.jobType === 'generation')
                  return (
                    <article className="record-card" key={plan.planId}>
                      <span>{plan.status.toUpperCase()}</span>
                      <strong>{plan.plan.summary}</strong>
                      <small>
                        {stage?.kind === 'queued'
                          ? `${stage.provider ?? 'provider unavailable'} · ${stage.model ?? stage.tool}`
                          : 'Generation details unavailable'}
                      </small>
                      <small>
                        {stage?.kind === 'queued' && stage.estimatedCostUsd !== undefined
                          ? `estimated $${stage.estimatedCostUsd.toFixed(4)}`
                          : 'cost estimate unavailable'}
                        {plan.outputArtifactId ? ` · output ${plan.outputArtifactId}` : ''}
                      </small>
                      {plan.error && <pre>{plan.error}</pre>}
                      <div className="command-plan-actions">
                        {plan.outputArtifactId && plan.status !== 'continued' && plan.status !== 'omitted' && (
                          <button type="button" disabled={busy} onClick={() => void continueGenerationPlan(plan)}>
                            Continue
                          </button>
                        )}
                        {(plan.status === 'failed' || plan.status === 'awaiting-output') && (
                          <>
                            <button type="button" disabled={busy} onClick={() => void reviseGenerationPlan(plan, 'retry')}>
                              Retry
                            </button>
                            <button type="button" disabled={busy} onClick={() => void reviseGenerationPlan(plan, 'switch')}>
                              Switch model
                            </button>
                            <button type="button" disabled={busy} onClick={() => void reviseGenerationPlan(plan, 'omit')}>
                              Omit
                            </button>
                          </>
                        )}
                      </div>
                    </article>
                  )
                })}
                {jobs.map((job) => (
                  <article className="record-card" key={job.id}>
                    <span>{job.state.toUpperCase()}</span>
                    <strong>{job.type}</strong>
                    <small>{job.artifactId ?? 'book-level job'}</small>
                    <small>operation {job.operationId} · attempt {job.attempts}/{job.maxAttempts}</small>
                    <pre>
                      {job.error
                        ? `${job.error.code ? `${job.error.code} · ` : ''}${job.error.message}`
                        : `${new Date(job.enqueuedAt).toLocaleString()}${job.startedAt ? ` · ${Math.max(0, Math.round(((job.finishedAt ?? jobSnapshotAt) - job.startedAt) / 1000))}s elapsed` : ''}`}
                    </pre>
                    {['queued', 'running', 'completing'].includes(job.state) && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void cancelJob(job.id)}
                      >
                        Cancel
                      </button>
                    )}
                    {['failed', 'aborted'].includes(job.state) && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void retryJob(job.id)}
                      >
                        Retry
                      </button>
                    )}
                  </article>
                ))}
                {jobs.length === 0 && <div className="empty-record"><Activity size={25} /><strong>No jobs recorded</strong><p>Run a cell or a notebook to queue work.</p></div>}
              </div>
            </section>
          )}

          {screen === 'settings' && (
            <section className="workspace-screen">
              <header><div><span className="section-label">APPLICATION SETTINGS</span><h1>Provider and storage state</h1><p>Provider keys and X OAuth are application-level; object publication state is scoped to the selected book.</p></div><button type="button" disabled={busy} onClick={() => void refreshSettings()}><RefreshCw size={15} />Refresh</button></header>
              <form className="project-create" onSubmit={storeSecret}>
                <label>Provider key<select value={secretKey} onChange={(event) => setSecretKey(event.target.value)}>{['KIE_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY', 'ELEVENLABS_API_KEY', 'FAL_API_KEY', 'GOOGLE_FLOW_API_KEY', 'X_CLIENT_ID', 'X_CLIENT_SECRET'].map((key) => <option key={key} value={key}>{key}</option>)}</select></label>
                <label>Value<input type="password" value={secretValue} onChange={(event) => setSecretValue(event.target.value)} placeholder="Stored locally in .env" /></label>
                <button type="submit" disabled={busy || !secretValue}>Save key</button>
              </form>
              <div className="settings-sections"><div className="settings-grid">{providers.map((provider) => <article className="provider-card" key={provider.envKey}><span className={`provider-dot provider-${provider.keyStatus}`} /><div><strong>{provider.label}</strong><p>{provider.keyStatus}{provider.maskedKey ? ` · ${provider.maskedKey}` : ''}</p></div></article>)}</div><div className="settings-diagnostics"><div className="workspace-section-heading"><h2>Selected book storage</h2><p>Catalog and object publication status from videobook-engine 3.0.0 schema v5.</p></div><div className="settings-diagnostics-grid"><article className="record-card"><pre>{storage ? JSON.stringify(storage, null, 2) : 'Refresh settings to inspect storage.'}</pre></article></div></div></div>
            </section>
          )}
      </>

      {pendingCommandPlan && (
        <aside className="command-plan-drawer" aria-label="Command plan review">
          <header>
            <div>
              <span className="section-label">COMMANDPLAN · {pendingCommandPlan.plan.sourceSurface.toUpperCase()}</span>
              <h2>{pendingCommandPlan.plan.summary}</h2>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => setPendingCommandPlan(null)}
            >
              Cancel
            </button>
          </header>
          <p>{pendingCommandPlan.plan.confirmation.reason}</p>
          {pendingCommandPlan.plan.suggestions && (
            <fieldset className="command-plan-suggestions">
              <legend>Include suggestions</legend>
              {pendingCommandPlan.plan.suggestions.map((suggestion) => (
                <label key={suggestion.suggestionId}>
                  <input
                    type="checkbox"
                    checked={suggestion.included}
                    disabled={busy}
                    onChange={() => void toggleCommandSuggestion(suggestion.suggestionId)}
                  />
                  <span>
                    <strong>{suggestion.label}</strong>
                    {suggestion.detail && <small>{suggestion.detail}</small>}
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          <ol className="command-plan-stages">
            {pendingCommandPlan.plan.stages.map((stage) => {
              const preview = stage.kind === 'edit'
                ? pendingCommandPlan.previews[stage.stageId]
                : undefined
              return (
                <li key={stage.stageId}>
                  <span>{stage.kind.toUpperCase()}</span>
                  <strong>{stage.summary}</strong>
                  {preview && (
                    <>
                      <small>
                        {preview.diff.changedClipIds.length} clips · duration {preview.diff.beforeDurationFrames} → {preview.diff.afterDurationFrames} frames
                      </small>
                      {preview.warnings.map((warning, index) => (
                        <p className="plan-warning" key={`${stage.stageId}:warning:${index}`}>
                          {warning.message}
                        </p>
                      ))}
                      {preview.conflicts.map((conflict, index) => (
                        <p className="plan-conflict" key={`${stage.stageId}:conflict:${index}`}>
                          {conflict.message}
                        </p>
                      ))}
                    </>
                  )}
                  {stage.kind === 'queued' && (
                    <small>
                      {stage.provider && stage.model
                        ? `${stage.provider} · ${stage.model}`
                        : stage.tool}
                      {stage.estimatedCostUsd !== undefined
                        ? ` · estimated $${stage.estimatedCostUsd.toFixed(4)}`
                        : stage.estimateUnavailable
                          ? ' · cost estimate unavailable'
                          : ''}
                    </small>
                  )}
                </li>
              )
            })}
          </ol>
          <div className="command-plan-actions">
            {lastEditActionId && (
              <button type="button" disabled={busy} onClick={() => void restoreLastCommandPlan()}>
                <Undo2 size={14} />Restore last edit
              </button>
            )}
            <button
              type="button"
              disabled={
                busy
                || (
                  pendingCommandPlan.plan.suggestions?.every(
                    (suggestion) => !suggestion.included,
                  ) ?? false
                )
                || Object.values(pendingCommandPlan.previews).some((preview) => !preview.valid)
              }
              onClick={() => void applyPendingCommandPlan()}
            >
              <Check size={14} />Apply plan
            </button>
          </div>
        </aside>
      )}

      <CommandComposer
        commands={commands}
        assetSlugs={assets.map((asset) => asset.id)}
        bookId={bookId}
        callTool={mcp.callTool}
        disabled={busy || !bookId || mcp.state !== 'ready'}
        connectionLabel={mcp.state === 'ready' ? 'Load a book to begin' : 'Connecting to MCP…'}
        promptSession={null}
        onEnsureCatalog={() => loadBooks(bookId)}
        onExecute={executeCommand}
      />
    </main>
  )
}

export default App
