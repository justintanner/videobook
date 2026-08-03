import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import {
  Handle,
  Position,
  ReactFlow,
  SelectionMode,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
  type Viewport,
} from '@xyflow/react'
import {
  Activity,
  AudioWaveform,
  BookOpen,
  Braces,
  Check,
  CircleDot,
  Film,
  Image,
  Layers2,
  Library,
  LoaderCircle,
  Mic,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Square,
  Trash2,
  Undo2,
  Upload,
  Video,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { v7 as uuidv7 } from 'uuid'
import type {
  EditPreview,
  NotebookCellReference,
  NotebookCellType,
  NotebookDocument,
  PinnedSearchResult,
  Sequence,
  TimedSequenceClip,
} from 'videobook-engine'
import { SCHEMA_VERSION } from 'videobook-engine/catalog-metadata'
import enginePackage from 'videobook-engine/package.json'
import {
  adaptCommandArgs,
  parseCommandArgs,
  selectCommandForInput,
  type CommandToolArgs,
  type ServerCommand,
} from '@/lib/command-registry'
import {
  COMMAND_COMPOSER_FORM_ID,
  CommandComposer,
  type ComposerOutcome,
} from '@/components/videobook/CommandComposer'
import {
  BusRiverEdge,
} from '@/components/videobook/BusRiverEdge'
import { CellStateOverlay } from '@/components/videobook/cell-overlays/CellStateOverlay'
import { AnalysisCellSummary } from '@/components/videobook/AnalysisCellSummary'
import { NotebookMediaMetadata } from '@/components/videobook/NotebookMediaMetadata'
import {
  NotebookGridBoard,
} from '@/components/videobook/NotebookGridBoard'
import {
  MomentSearch,
  type MomentSearchHandle,
} from '@/components/videobook/MomentSearch'
import { NotebookCellInspector } from '@/components/videobook/NotebookCellInspector'
import { MediaLibraryAssetPreview } from '@/components/videobook/MediaLibraryAssetPreview'
import {
  GenerationChatReview,
  type GenerationReviewSource,
} from '@/components/videobook/GenerationChatReview'
import { ReverseSearchReference } from '@/components/videobook/ReverseSearchReference'
import { NotebookMediaFullscreen } from '@/components/videobook/NotebookMediaFullscreen'
import { BookProjectSelector } from '@/components/videobook/BookProjectSelector'
import {
  CanonicalSequencePlayer,
  type TimelineKeyboardAction,
} from '@/components/videobook/CanonicalSequencePlayer'
import {
  notebookEdges,
  notebookEdgesWithCellFocus,
  notebookConnectionTargetInput,
  notebookNodes,
  notebookNodesWithCellStatus,
  type NotebookCellData,
  type NotebookFlowEdge,
} from '@/videobook/notebook-draft'
import {
  asNotebookGenerationActions,
  compatibleGenerationActions,
  compatibleGenerationModes,
  type GenerationControlValue,
  type GenerationPreviewDraft,
  type NotebookGenerationAction,
} from '@/videobook/notebook-generation-actions'
import {
  startNotebookCellRun,
} from '@/videobook/notebook-cell-actions'
import {
  asSearchReferenceDescriptor,
  referenceKind,
  releaseSearchReference,
  searchReferenceRange,
  uploadSearchReference,
  type ReverseSearchMode,
  type SearchReferenceDescriptor,
} from '@/videobook/search-reference'
import {
  validateCommandPlan,
  type CommandPlan,
  type EditCommandStage,
} from '@/videobook/command-plan'
import {
  changedNotebookGridNodes,
  nextNotebookGridSlot,
  normalizeNotebookGridZoom,
  notebookGrid,
  notebookGridAddress,
  notebookGridDropSlot,
  notebookGridFrameSize,
  notebookGridMetrics,
  notebookGridSlot,
  notebookGridTag,
  notebookGridViewport,
  resolveNotebookGridGroupMove,
  snapNotebookGridMove,
  type NotebookGridSlot,
} from '@/videobook/notebook-grid'
import {
  notebookSourcePortId,
  notebookSourcePortOffsets,
  type NotebookSourceSide,
} from '@/videobook/notebook-routing'
import {
  formatMediaTime,
  notebookAudioPresentation,
  notebookCellActionPresentation,
  notebookCellExecutionObservation,
  notebookCellIsActiveStatus,
  notebookCellRunObservation,
  notebookCellStatusLabel,
  notebookCellSupportsExecution,
  notebookOutputVersionArtifactIds,
  notebookSplitFrameIds,
  notebookSplitRange,
  type NotebookAnalysisInfo,
  type NotebookAudioInfo,
} from '@/videobook/notebook-cell-presentation'
import {
  notebookRunJobViewFromRecord,
  notebookRunWatchStep,
  selectEffectiveNotebookRunJob,
  type NotebookRunWatchOutcomeKind,
} from '@/videobook/notebook-run-watch'
import {
  downloadWatchStep,
  downloadVideoCellInput,
  nextNotebookCellSlug,
} from '@/videobook/notebook-download'
import {
  enqueueNotebookFrameCommand,
  parseNotebookFrameCommand,
  resolveNotebookFrameSource,
  type NotebookFrameCommand,
} from '@/videobook/notebook-frame-command'
import {
  enqueueNotebookSplitCommand,
  parseNotebookSplitCommand,
  planNotebookSplitCommand,
  resolveNotebookSplitSource,
  type NotebookSplitCommand,
  type NotebookSplitRun,
} from '@/videobook/notebook-split-command'
import {
  generationCellTypeForRoutedTool,
  materializeNotebookChatGeneration,
  notebookChatGenerationConnectedInputs,
  notebookChatGenerationReferences,
  parseNotebookChatGenerationCommand,
  planNotebookChatGeneration,
  reviseNotebookChatGenerationAction,
  reviseNotebookChatGenerationMode,
  reviseNotebookChatGenerationPrompt,
  reviseNotebookChatGenerationSetting,
  type NotebookChatGenerationCommand,
  type NotebookChatGenerationDraft,
} from '@/videobook/notebook-chat-generation'
import { parseNotebookGenerationCellCommand } from '@/videobook/notebook-generation-command'
import { notebookMediaWorkState } from '@/videobook/notebook-media-work'
import type { InitialWorkspacePayload } from '@/videobook/initial-workspace'
import {
  asChatModelCatalog,
  fallbackChatModelCatalog,
  resolveChatModelSelection,
  type ChatModelCatalog,
} from '@/videobook/chat-models'
import { routedActionReview } from '@/videobook/chat-action-review'
import {
  idleMcpActivity,
  shouldNotifyMcpActivity,
  type McpActivity,
} from '@/videobook/mcp-activity'
import { useMcpConnection } from '@/videobook/useMcpConnection'
import type {
  BookProjectMutationResult,
  BookProjectSummary,
} from '@/videobook/book-project-selector'
import {
  notebookCellRenamePlan,
  notebookMentionAssets,
  resolveNotebookMentionAliases,
} from '@/videobook/mention-suggestions'
import { restoreCommandComposerFocus } from '@/videobook/command-composer-focus'
import { parsePendingApplyCommand } from '@/videobook/command-composer-outcome'
import { revealNotebookResult } from '@/videobook/notebook-result-reveal'
import {
  notebookAddressExpectationsAreStale,
  parseNotebookCoordinateAction,
  planNotebookCoordinateAction,
  type NotebookAddressExpectation,
  type NotebookCoordinateAction,
  type NotebookCoordinateActionPlan,
} from '@/videobook/notebook-coordinate-actions'
import { notebookCellAtSlot } from '@/videobook/notebook-addressing'

type Screen = 'notebook' | 'library' | 'timeline' | 'jobs' | 'settings'

type ToolResponse = {
  content?: Array<{ type: string; text?: string }>
  isError?: boolean
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
  duration: number | null
  audioInfo: NotebookAudioInfo | null
  analysisInfo: NotebookAnalysisInfo | null
}

type PassiveMediaKind = 'audio' | 'image' | 'video'
type MediaSearchMode = 'text' | ReverseSearchMode

type MediaSlotOperation = 'attach' | 'clear' | 'upload'

type MediaSlotState = {
  operation: MediaSlotOperation | null
  error: string | null
}

type LibraryAssetRecord = AssetRecord & {
  owningBookId: string
  owningBookSlug: string
}

type LibrarySearchPage = {
  offset: number
  limit: number
  total: number
  hasMore: boolean
}

type LibrarySearchResult = {
  assets: LibraryAssetRecord[]
  page: LibrarySearchPage
  booksWithErrors: Array<{ bookId: string; message: string }>
}

type MediaLibraryPickerState = {
  cellId: string
  mode: MediaSearchMode
  query: string
  draftQuery: string
  reference: SearchReferenceDescriptor | null
  referenceStartSeconds: string
  referenceDurationSeconds: string
  preparingReference: boolean
  assets: LibraryAssetRecord[]
  page: LibrarySearchPage
  booksWithErrors: Array<{ bookId: string; message: string }>
  loading: boolean
  loadingMore: boolean
  error: string | null
  activeArtifactId: string | null
}

type MediaLibrarySearchCriteria = Pick<
  MediaLibraryPickerState,
  | 'mode'
  | 'reference'
  | 'referenceStartSeconds'
  | 'referenceDurationSeconds'
>

type MediaSlotContextValue = {
  states: Record<string, MediaSlotState>
  onFile: (cellId: string, file: File) => void
  onFileError: (cellId: string, message: string) => void
  onOpenLibrary: (cellId: string) => void
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

type ChatActionPlan = {
  kind: 'chat-action-plan'
  planId: string
  bookId: string
  prompt: string
  routedTool: string
  tool: string
  params: Record<string, unknown>
  message: string
  summary: string
  effect: 'mutation' | 'generation'
  confirmation: {
    required: true
    reason: string
  }
}

type PendingChatAction =
  | {
      kind: 'generation'
      draft: NotebookChatGenerationDraft
      notebookId: string
      preview: unknown | null
      previewError: string | null
      previewLoading: boolean
      previewStale: boolean
      expectations: NotebookAddressExpectation[]
      reason: string
      summary: string
    }
  | {
      kind: 'frame'
      command: NotebookFrameCommand
      expectations: NotebookAddressExpectation[]
      notebookId: string
      reason: string
      summary: string
    }
  | {
      kind: 'split'
      command: NotebookSplitCommand
      expectations: NotebookAddressExpectation[]
      notebookId: string
      reason: string
      summary: string
    }
  | {
      kind: 'notebook'
      notebookId: string
      plan: NotebookCoordinateActionPlan
    }
  | {
      kind: 'routed'
      plan: ChatActionPlan
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
  payload: Record<string, unknown> | null
  enqueuedAt: number
  startedAt: number | null
  finishedAt: number | null
}

type WorkspaceNoticeTone = 'info' | 'error'
type WorkspaceNotice = { text: string; tone: WorkspaceNoticeTone }

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
  books: BookProjectSummary[]
  bookId: string
  notebook: NotebookDocument | null
  assets: AssetRecord[]
  ingestStatuses: IngestStatus[]
  audioNotebook: AudioNotebookState
  sequence: Sequence | null
  jobs: JobRecord[]
  commands: ServerCommand[]
  chatModelCatalog: ChatModelCatalog
  generationActions: NotebookGenerationAction[]
}

const supportedUiActions = new Set([
  'switch_book',
  'open_notebook',
  'open_projects',
  'open_provider_keys',
])

interface CanvasCellData extends NotebookCellData {
  asset?: AssetRecord
  deleting?: boolean
  revealing?: boolean
  splitFrames?: {
    first: { artifactId: string | null; asset?: AssetRecord }
    last: { artifactId: string | null; asset?: AssetRecord }
  }
}

type CanvasNode = Node<CanvasCellData>

const MediaSlotContext = createContext<MediaSlotContextValue>({
  states: {},
  onFile: () => undefined,
  onFileError: () => undefined,
  onOpenLibrary: () => undefined,
})
const CellRunContext = createContext<(
  cellId: string,
) => Promise<ComposerOutcome | undefined>>(
  async () => undefined,
)

const mcpUrl = typeof window === 'undefined'
  ? 'http://localhost/mcp'
  : new URL('/mcp', window.location.origin).toString()
const ingestPollIntervalMs = 750
const ingestPollTimeoutMs = 5 * 60_000
const notebookRunPollIntervalMs = 500
const notebookRunPollTimeoutMs = 5 * 60_000
const notebookGenerationWatchIntervalMs = 2_000
const notebookGenerationWatchTimeoutMs = 45 * 60_000
const downloadWatchIntervalMs = 5_000
const downloadWatchTimeoutMs = 45 * 60_000
const activeJobStates = new Set(['queued', 'running', 'completing'])

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

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
  group: 'Media' | 'Text & analysis' | 'Generation' | 'Edit'
  icon: typeof BookOpen
}> = [
  { type: 'audio', label: 'Audio', group: 'Media', icon: AudioWaveform },
  { type: 'image', label: 'Image', group: 'Media', icon: Image },
  { type: 'video', label: 'Video', group: 'Media', icon: Video },
  { type: 'character', label: 'Character', group: 'Media', icon: CircleDot },
  { type: 'prompt', label: 'Prompt', group: 'Text & analysis', icon: BookOpen },
  { type: 'analyze', label: 'Analyze', group: 'Text & analysis', icon: Activity },
  { type: 'generate_video', label: 'Generate video', group: 'Generation', icon: Video },
  { type: 'generate_image', label: 'Generate image', group: 'Generation', icon: Image },
  { type: 'generate_audio', label: 'Generate audio', group: 'Generation', icon: AudioWaveform },
  { type: 'extract_audio', label: 'Extract audio', group: 'Edit', icon: AudioWaveform },
  { type: 'extract_frame', label: 'Extract frame', group: 'Edit', icon: Image },
  { type: 'split_video', label: 'Split video', group: 'Edit', icon: Film },
  { type: 'concat', label: 'Concat', group: 'Edit', icon: Film },
  { type: 'splice', label: 'Splice', group: 'Edit', icon: Film },
]

const cellPaletteGroups = [
  'Media',
  'Text & analysis',
  'Generation',
  'Edit',
] as const

const notebookCellTypes = new Set<string>([
  'audio',
  'image',
  'video',
  'extract_audio',
  'extract_frame',
  'split_video',
  'prompt',
  'character',
  'analyze',
  'analysis',
  'generate_video',
  'generate_image',
  'generate_audio',
  'concat',
  'splice',
] satisfies NotebookCellType[])

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

function isGenerationCell(
  cell: NotebookDocument['cells'][number],
): boolean {
  if (cell.operation === 'rewrite_prompt') return true
  return cell.type === 'generate_video'
    || cell.type === 'generate_image'
    || cell.type === 'generate_audio'
}

function isRunnableCell(
  cell: NotebookDocument['cells'][number],
): boolean {
  return notebookCellSupportsExecution(cell)
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

function isDownloadVideoResult(value: unknown): boolean {
  const item = record(value)
  return asString(item?.artifact_id) !== null
    && asString(item?.assetId) !== null
    && asString(item?.job_id)?.startsWith('download-') === true
}

function asChatActionPlan(value: unknown): ChatActionPlan {
  const item = record(value)
  const params = record(item?.params)
  const confirmation = record(item?.confirmation)
  const kind = asString(item?.kind)
  const planId = asString(item?.planId)
  const planBookId = asString(item?.bookId)
  const prompt = asString(item?.prompt)
  const routedTool = asString(item?.routedTool)
  const tool = asString(item?.tool)
  const message = asString(item?.message) ?? ''
  const summary = asString(item?.summary)
  const effect = asString(item?.effect)
  const reason = asString(confirmation?.reason)
  if (
    kind !== 'chat-action-plan'
    || !planId
    || !planBookId
    || !prompt
    || !routedTool
    || !tool
    || !params
    || !summary
    || (effect !== 'mutation' && effect !== 'generation')
    || confirmation?.required !== true
    || !reason
  ) throw new Error('The server returned an invalid chat action plan')
  return {
    kind,
    planId,
    bookId: planBookId,
    prompt,
    routedTool,
    tool,
    params,
    message,
    summary,
    effect,
    confirmation: { required: true, reason },
  }
}

function generationMediaKind(
  cellType: NotebookChatGenerationCommand['cellType'],
): NotebookChatGenerationCommand['mediaKind'] {
  if (cellType === 'generate_audio') return 'audio'
  if (cellType === 'generate_image') return 'image'
  return 'video'
}

function applyReadyOutcome(message: string): ComposerOutcome {
  return {
    ok: true,
    message,
    nextInput: '/apply',
    selectInput: true,
  }
}

function generationApplyReadyOutcome(message: string): ComposerOutcome {
  return {
    ok: true,
    message,
    nextInput: '/apply ',
    selectInput: false,
  }
}

function urlFromText(value: string): string {
  return value.match(/https?:\/\/[^\s]+/u)?.[0] ?? value
}

function asBooks(value: unknown): BookProjectSummary[] {
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

function asBook(value: unknown): BookProjectSummary | null {
  return asBooks([value])[0] ?? null
}

function bookProjectFailure(error: unknown): { ok: false; error: string } {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }
}

function asNotebookCell(value: unknown): NotebookDocument['cells'][number] | null {
  const item = record(value)
  const id = item && asString(item.id)
  const type = item && asString(item.type)
  const slug = item && asString(item.slug)
  const slot = item && record(item.slot)
  const row = slot && asNumber(slot.row)
  const column = slot && asNumber(slot.column)
  if (
    !item
    || !id
    || !slug
    || row === null
    || column === null
    || !Number.isInteger(row)
    || !Number.isInteger(column)
    || row < 0
    || row > 25
    || column < 0
    || column > 12
  ) return null
  if (!notebookCellTypes.has(type ?? '')) return null
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
    slug,
    slot: { row, column },
    ...(asString(item.output_entity_id)
      ? { outputEntityId: asString(item.output_entity_id)! }
      : {}),
    ...(asString(item.prompt) !== null ? { prompt: asString(item.prompt)! } : {}),
    ...(asString(item.provider) !== null ? { provider: asString(item.provider)! } : {}),
    ...(asString(item.model) !== null ? { model: asString(item.model)! } : {}),
    ...(asString(item.operation) !== null ? { operation: asString(item.operation)! } : {}),
    ...(asString(item.tool) !== null ? { tool: asString(item.tool)! } : {}),
    ...(inputs ? { inputs } : {}),
    ...(references ? { references } : {}),
    ...(pinnedResults ? { pinnedResults } : {}),
    ...(asString(item.output_artifact_id ?? item.outputArtifactId)
      ? { outputArtifactId: asString(item.output_artifact_id ?? item.outputArtifactId)! }
      : {}),
  }
}

type NotebookSnapshot = NotebookDocument & { revision?: string }

function asNotebook(value: unknown): NotebookSnapshot | null {
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
    ...(asString(item.revision) ? { revision: asString(item.revision)! } : {}),
    ...(asString(item.description) ? { description: asString(item.description)! } : {}),
    ...(asString(item.lifecycleState ?? item.lifecycle_state)
      ? { lifecycleState: asString(item.lifecycleState ?? item.lifecycle_state)! }
      : {}),
    ...(asNumber(item.workflowVersion ?? item.workflow_version) !== null
      ? { workflowVersion: asNumber(item.workflowVersion ?? item.workflow_version)! }
      : {}),
    ...(asString(item.analysisRevision ?? item.analysis_revision)
      ? { analysisRevision: asString(item.analysisRevision ?? item.analysis_revision)! }
      : {}),
    ...(record(item.audioSpine ?? item.audio_spine)
      ? {
          audioSpine: record(
            item.audioSpine ?? item.audio_spine,
          )! as unknown as NotebookDocument['audioSpine'],
        }
      : {}),
    ...(record(item.currentSelection ?? item.current_selection)
      ? {
          currentSelection: record(
            item.currentSelection ?? item.current_selection,
          )! as NotebookDocument['currentSelection'],
        }
      : {}),
    ...(record(item.fixture)
      ? { fixture: record(item.fixture)! as NotebookDocument['fixture'] }
      : {}),
    ...(record(item.execution)
      ? { execution: record(item.execution)! as NonNullable<NotebookDocument['execution']> }
      : {}),
    ...(Array.isArray(item.generationPlans ?? item.generation_plans)
      ? {
          generationPlans: (
            item.generationPlans ?? item.generation_plans
          ) as NonNullable<NotebookDocument['generationPlans']>,
        }
      : {}),
    ...(Array.isArray(item.notebookRunPlans ?? item.notebook_run_plans)
      ? {
          notebookRunPlans: (
            item.notebookRunPlans ?? item.notebook_run_plans
          ) as NonNullable<NotebookDocument['notebookRunPlans']>,
        }
      : {}),
    ...(Array.isArray(item.transcriptEdits ?? item.transcript_edits)
      ? {
          transcriptEdits: (
            item.transcriptEdits ?? item.transcript_edits
          ) as NonNullable<NotebookDocument['transcriptEdits']>,
        }
      : {}),
    ...(Array.isArray(
      item.transcriptAttachments ?? item.transcript_attachments,
    )
      ? {
          transcriptAttachments: (
            item.transcriptAttachments ?? item.transcript_attachments
          ) as NonNullable<NotebookDocument['transcriptAttachments']>,
        }
      : {}),
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

function asAsset(value: unknown): AssetRecord | null {
  const item = record(value)
  const id = item && asString(item.id)
  const artifactId = item && asString(item.artifact_id ?? item.artifactId)
  const type = item && asString(item.type)
  if (!item || !id || !artifactId || !type) return null
  const audio = record(item.audio_info)
  const codec = audio && asString(audio.codec)
  const sampleRateHz = audio && asNumber(audio.sample_rate_hz)
  const channels = audio && asNumber(audio.channels)
  const channelLayout = audio && asString(audio.channel_layout)
  const durationSeconds = audio && asNumber(audio.duration_seconds)
  const audioInfo = codec
    && sampleRateHz !== null
    && channels !== null
    && channelLayout
    && durationSeconds !== null
    ? {
        codec,
        sampleRateHz,
        channels,
        channelLayout,
        durationSeconds,
      }
    : null
  const analysis = record(item.analysis_info ?? item.analysisInfo)
  const sourceDurationSeconds = analysis
    && asNumber(analysis.source_duration_seconds ?? analysis.sourceDurationSeconds)
  const analysisShots = Array.isArray(analysis?.shots)
    ? analysis.shots.flatMap((value) => {
        const shot = record(value)
        const ordinal = shot && asNumber(shot.ordinal)
        const label = shot && asString(shot.label)
        const startSeconds = shot
          && asNumber(shot.start_seconds ?? shot.startSeconds)
        const endSeconds = shot
          && asNumber(shot.end_seconds ?? shot.endSeconds)
        const durationSeconds = shot
          && asNumber(shot.duration_seconds ?? shot.durationSeconds)
        return ordinal !== null
          && label !== null
          && startSeconds !== null
          && endSeconds !== null
          && durationSeconds !== null
          ? [{
              ordinal,
              label,
              startSeconds,
              endSeconds,
              durationSeconds,
            }]
          : []
      })
    : []
  const analysisLlmExchangeValues =
    analysis?.llm_exchanges ?? analysis?.llmExchanges
  const analysisLlmExchanges = Array.isArray(analysisLlmExchangeValues)
    ? analysisLlmExchangeValues.flatMap((value) => {
        const exchange = record(value)
        const provider = exchange && asString(exchange.provider)
        const model = exchange && asString(exchange.model)
        const stage = exchange && asString(exchange.stage)
        const responseFormatValue = exchange
          && record(exchange.response_format ?? exchange.responseFormat)
        const responseFormatType = responseFormatValue
          && asString(responseFormatValue.type)
        return provider && model && stage
          ? [{
              provider,
              model,
              responseFormat: responseFormatType
                ? {
                    name: asString(responseFormatValue?.name),
                    strict: responseFormatValue?.strict === true,
                    type: responseFormatType,
                  }
                : null,
              stage,
            }]
          : []
      })
    : []
  const analysisInfo = sourceDurationSeconds !== null
    ? {
        sourceDurationSeconds,
        llmExchanges: analysisLlmExchanges,
        outputJson: analysis?.output_json ?? analysis?.outputJson ?? null,
        outputUrl: asString(analysis?.output_url ?? analysis?.outputUrl),
        shots: analysisShots,
      }
    : null
  return {
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
    duration: asNumber(item.duration),
    audioInfo,
    analysisInfo,
  }
}

function asAssets(value: unknown): AssetRecord[] {
  const container = record(value)
  const source = Array.isArray(value)
    ? value
    : Array.isArray(container?.assets)
      ? container.assets
      : []
  return source.flatMap((entry) => {
    const asset = asAsset(entry)
    return asset ? [asset] : []
  })
}

function asLibrarySearchResult(value: unknown): LibrarySearchResult {
  const container = record(value)
  const source = Array.isArray(container?.assets) ? container.assets : []
  const pageValue = record(container?.page)
  const offset = asNumber(pageValue?.offset) ?? 0
  const limit = asNumber(pageValue?.limit) ?? 24
  const total = asNumber(pageValue?.total) ?? 0
  const errors = Array.isArray(container?.books_with_errors)
    ? container.books_with_errors
    : []
  return {
    assets: source.flatMap((entry) => {
      const item = record(entry)
      const asset = asAsset(item)
      const owningBookId = item && asString(item.owning_book_id)
      const owningBookSlug = item && asString(item.owning_book_slug)
      return asset && owningBookId && owningBookSlug
        ? [{ ...asset, owningBookId, owningBookSlug }]
        : []
    }),
    page: {
      offset,
      limit,
      total,
      hasMore: pageValue?.hasMore === true,
    },
    booksWithErrors: errors.flatMap((entry) => {
      const item = record(entry)
      const errorBookId = item && asString(item.book_id)
      const message = item && asString(item.message)
      return errorBookId && message ? [{ bookId: errorBookId, message }] : []
    }),
  }
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
  const edits = notebook?.transcriptEdits
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
    const payloadValue = item.payload
    const payload = payloadValue && typeof payloadValue === 'object'
      && !Array.isArray(payloadValue)
      ? payloadValue as Record<string, unknown>
      : null
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
      payload,
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

const mediaFileExtensions: Record<PassiveMediaKind, ReadonlySet<string>> = {
  audio: new Set(['aac', 'flac', 'm4a', 'mp3', 'ogg', 'wav', 'weba']),
  image: new Set(['gif', 'jpeg', 'jpg', 'png', 'svg', 'webp']),
  video: new Set(['avi', 'mkv', 'mov', 'mp4', 'webm']),
}

const mediaFileAccept: Record<PassiveMediaKind, string> = {
  audio: 'audio/*,.aac,.flac,.m4a,.mp3,.ogg,.wav,.weba',
  image: 'image/*,.gif,.jpeg,.jpg,.png,.svg,.webp',
  video: 'video/*,.avi,.mkv,.mov,.mp4,.webm',
}

const emptyLibraryPage: LibrarySearchPage = {
  offset: 0,
  limit: 24,
  total: 0,
  hasMore: false,
}

function passiveMediaKind(kind: NotebookCellType): PassiveMediaKind | null {
  return kind === 'audio' || kind === 'image' || kind === 'video' ? kind : null
}

function mediaKindForFile(
  file: Pick<File, 'name' | 'type'>,
): PassiveMediaKind | null {
  const mimeKind = file.type.split('/', 1)[0]
  if (mimeKind === 'audio' || mimeKind === 'image' || mimeKind === 'video') {
    return mimeKind
  }
  const extension = file.name.toLowerCase().split('.').pop() ?? ''
  for (const kind of ['audio', 'image', 'video'] as const) {
    if (mediaFileExtensions[kind].has(extension)) return kind
  }
  return null
}

function mediaLibraryKinds(kind: PassiveMediaKind): string[] {
  return kind === 'video' ? ['video', 'final'] : [kind]
}

function isEmptyPassiveMediaSlot(
  kind: NotebookCellType,
  outputArtifactId: string | undefined,
  targetConnectionCount: number,
): boolean {
  return passiveMediaKind(kind) !== null
    && outputArtifactId === undefined
    && targetConnectionCount === 0
}

function isCompatibleLibraryAsset(
  kind: PassiveMediaKind,
  assetType: string,
): boolean {
  return mediaLibraryKinds(kind).includes(assetType)
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
    chatModelCatalog: asChatModelCatalog(payload.chatModelValue),
    generationActions: asNotebookGenerationActions(payload.actionValue),
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
  const execution = record(document.execution)
  const item = execution && record(execution[cellId])
  const cell = document.cells.find((candidate) => candidate.id === cellId)
  if (!item) {
    return asString(cell?.inputs?.state)
      ?? (cell?.outputArtifactId ? 'completed' : 'ready')
  }
  if (asString(item.error)) return 'error'
  return asString(item.status)
    ?? asString(cell?.inputs?.state)
    ?? 'ready'
}

function cellExecutionStartedAt(
  document: NotebookDocument,
  cellId: string,
): string | undefined {
  const execution = record(document.execution)
  const item = execution && record(execution[cellId])
  return asString(item?.startedAt) ?? asString(item?.updatedAt) ?? undefined
}

function cellExecutionError(
  document: NotebookDocument,
  cellId: string,
): string | undefined {
  const execution = record(document.execution)
  const item = execution && record(execution[cellId])
  return asString(item?.error) ?? undefined
}

function canvasNodes(
  document: NotebookDocument,
  assets: AssetRecord[],
  jobs: JobRecord[],
): CanvasNode[] {
  const byArtifactId = new Map(assets.map((asset) => [asset.artifactId, asset]))
  return notebookNodes(document).map((node) => {
    const frameIds = notebookSplitFrameIds(node.data.inputs)
    const asset = artifactForCell(byArtifactId, node.data.outputArtifactId)
    const fallbackStartedAt = cellExecutionStartedAt(document, node.id)
    const fallbackError = cellExecutionError(document, node.id)
    const work = notebookMediaWorkState(
      node.data.kind,
      asset,
      jobs,
      {
        status: cellExecutionStatus(document, node.id),
        ...(fallbackStartedAt ? { startedAt: fallbackStartedAt } : {}),
        ...(fallbackError ? { error: fallbackError } : {}),
      },
    )
    return {
      ...node,
      data: {
        ...node.data,
        status: work.status,
        ...(work.startedAt ? { statusStartedAt: work.startedAt } : {}),
        ...(work.error ? { statusError: work.error } : {}),
        asset,
        ...(node.data.kind === 'split_video'
          ? {
              splitFrames: {
                first: {
                  artifactId: frameIds.first,
                  ...(frameIds.first && byArtifactId.has(frameIds.first)
                    ? { asset: byArtifactId.get(frameIds.first)! }
                    : {}),
                },
                last: {
                  artifactId: frameIds.last,
                  ...(frameIds.last && byArtifactId.has(frameIds.last)
                    ? { asset: byArtifactId.get(frameIds.last)! }
                    : {}),
                },
              },
            }
          : {}),
      },
    }
  })
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  return JSON.stringify(left) === JSON.stringify(right)
}

// Rebuilt nodes/edges carry fresh object identities on every poll tick. Reuse
// the previous object whenever content is unchanged so React Flow skips
// re-rendering (and re-measuring) untouched cells, and carry over the runtime
// state React Flow manages outside our data pipeline (selection, measurement,
// in-flight drags).
function reconcileCanvasNodes(
  current: CanvasNode[],
  next: CanvasNode[],
): CanvasNode[] {
  const previousById = new Map(current.map((node) => [node.id, node]))
  const merged = next.map((node) => {
    const previous = previousById.get(node.id)
    if (!previous) return node
    const candidate: CanvasNode = {
      ...node,
      ...(previous.selected !== undefined ? { selected: previous.selected } : {}),
      ...(previous.measured !== undefined ? { measured: previous.measured } : {}),
      ...(previous.dragging !== undefined ? { dragging: previous.dragging } : {}),
      ...(previous.dragging ? { position: previous.position } : {}),
    }
    return jsonEqual(candidate, previous) ? previous : candidate
  })
  const unchanged = merged.length === current.length
    && merged.every((node, index) => node === current[index])
  return unchanged ? current : merged
}

function reconcileFlowEdges(
  current: NotebookFlowEdge[],
  next: NotebookFlowEdge[],
): NotebookFlowEdge[] {
  const previousById = new Map(current.map((edge) => [edge.id, edge]))
  const merged = next.map((edge) => {
    const previous = previousById.get(edge.id)
    if (!previous) return edge
    const candidate: NotebookFlowEdge = {
      ...edge,
      ...(previous.selected !== undefined ? { selected: previous.selected } : {}),
    }
    return jsonEqual(candidate, previous) ? previous : candidate
  })
  const unchanged = merged.length === current.length
    && merged.every((edge, index) => edge === current[index])
  return unchanged ? current : merged
}

function CellIcon({ kind }: { kind: NotebookCellType }) {
  if (kind === 'video' || kind === 'generate_video' || kind === 'split_video') {
    return <Video size={14} />
  }
  if (
    kind === 'image'
    || kind === 'extract_frame'
    || kind === 'generate_image'
  ) return <Image size={14} />
  if (kind === 'audio' || kind === 'extract_audio' || kind === 'generate_audio') {
    return <AudioWaveform size={14} />
  }
  if (kind === 'prompt') return <BookOpen size={14} />
  if (kind === 'analyze') return <Activity size={14} />
  if (kind === 'analysis') return <Braces size={14} />
  if (kind === 'character') return <CircleDot size={14} />
  return <Film size={14} />
}

function cellTypeLabel(kind: NotebookCellType): string {
  return kind.replaceAll('_', ' ').toUpperCase()
}

function emptyCellLabel(data: CanvasCellData): string {
  if (
    data.kind === 'generate_video'
    || data.kind === 'generate_image'
    || data.kind === 'generate_audio'
  ) {
    return data.tool ?? data.model ?? data.operation ?? 'Choose a generation action'
  }
  if (data.kind === 'video' || data.kind === 'image' || data.kind === 'audio') {
    return `Select ${data.kind} media`
  }
  if (data.kind === 'character') return 'Select a character'
  if (data.kind === 'extract_audio') return 'Connect a video to extract audio'
  if (data.kind === 'extract_frame') {
    const mode = asString(data.inputs?.frameMode) ?? 'first'
    if (mode === 'time') {
      return `Extract frame at ${formatMediaTime(
        asNumber(data.inputs?.timestampSeconds) ?? 0,
      )}`
    }
    return mode === 'last' ? 'Extract last frame' : 'Extract first frame'
  }
  if (data.kind === 'analysis') return 'Run the connected Analyze cell'
  if (data.kind === 'split_video') return 'Configure a video range'
  if (data.kind === 'concat') return 'Connect clip:0 and clip:1'
  if (data.kind === 'splice') return 'Connect first and second'
  return data.prompt || notebookGridTag(data.slot)
}

function assetPreviewUrl(asset: AssetRecord | undefined): string | null {
  return asset?.thumbnailUrl ?? asset?.mediaUrl ?? null
}

function SplitFramePreview({
  asset,
  artifactId,
  label,
  time,
}: {
  asset: AssetRecord | undefined
  artifactId: string | null
  label: string
  time: number | null
}) {
  const previewUrl = assetPreviewUrl(asset)
  return (
    <figure title={artifactId ?? label}>
      {previewUrl
        ? <img src={previewUrl} alt={`${label} frame`} />
        : <Film size={24} aria-hidden />}
      <figcaption>
        <strong>{label}</strong>
        <span>{time === null ? 'Frame pending' : formatMediaTime(time)}</span>
      </figcaption>
    </figure>
  )
}

function SplitVideoPreview({ data }: { data: CanvasCellData }) {
  const range = notebookSplitRange(data.inputs)
  return (
    <div className="cell-split-frames">
      <SplitFramePreview
        asset={data.splitFrames?.first.asset}
        artifactId={data.splitFrames?.first.artifactId ?? null}
        label="First"
        time={range?.startSeconds ?? null}
      />
      <SplitFramePreview
        asset={data.splitFrames?.last.asset}
        artifactId={data.splitFrames?.last.artifactId ?? null}
        label="Last"
        time={range?.endSeconds ?? null}
      />
    </div>
  )
}

function AudioCellSummary({ data }: { data: CanvasCellData }) {
  const presentation = notebookAudioPresentation({
    audioInfo: data.asset?.audioInfo ?? null,
    durationSeconds: data.asset?.duration ?? null,
    hasOutput: Boolean(data.outputArtifactId),
    inputs: data.inputs,
  })
  return (
    <div className="cell-audio-summary">
      <span className="cell-audio-role">{presentation.role}</span>
      {presentation.duration && (
        <strong className="cell-audio-duration">{presentation.duration}</strong>
      )}
      {presentation.details.length > 0 && (
        <span className="cell-audio-details">{presentation.details.join(' · ')}</span>
      )}
    </div>
  )
}

function MediaSlotTile({
  cellId,
  kind,
  state,
  onFile,
  onFileError,
  onOpenLibrary,
}: {
  cellId: string
  kind: PassiveMediaKind
  state: MediaSlotState | undefined
  onFile: (cellId: string, file: File) => void
  onFileError: (cellId: string, message: string) => void
  onOpenLibrary: (cellId: string) => void
}) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [dragging, setDragging] = useState(false)
  const busy = state?.operation !== null && state?.operation !== undefined

  const acceptFiles = (files: FileList | null) => {
    const selected = files ? [...files] : []
    if (selected.length !== 1) {
      onFileError(cellId, 'Choose one file for this media slot.')
      return
    }
    onFile(cellId, selected[0]!)
  }

  const acceptsOsFiles = (event: DragEvent<HTMLElement>) =>
    event.dataTransfer.types.includes('Files')

  return (
    <section
      className={`cell-media-slot nodrag nowheel${dragging ? ' cell-media-slot-dragging' : ''}`}
      aria-label={`Empty ${kind} media slot`}
      onDragEnter={(event) => {
        if (!acceptsOsFiles(event)) return
        event.preventDefault()
        event.stopPropagation()
        setDragging(true)
      }}
      onDragLeave={(event) => {
        if (!acceptsOsFiles(event)) return
        event.preventDefault()
        event.stopPropagation()
        setDragging(false)
      }}
      onDragOver={(event) => {
        if (!acceptsOsFiles(event)) return
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = 'copy'
      }}
      onDrop={(event) => {
        if (!acceptsOsFiles(event)) return
        event.preventDefault()
        event.stopPropagation()
        setDragging(false)
        if (!busy) acceptFiles(event.dataTransfer.files)
      }}
    >
      <button
        type="button"
        className="cell-media-slot-upload"
        disabled={busy}
        onClick={(event) => {
          event.stopPropagation()
          inputRef.current?.click()
        }}
      >
        {busy ? <LoaderCircle size={24} className="spin" /> : <Upload size={24} />}
        <strong>{busy ? 'Attaching media…' : `Add ${kind}`}</strong>
        <span>Drop one file or choose from this device</span>
      </button>
      <button
        type="button"
        className="cell-media-slot-library"
        disabled={busy}
        onClick={(event) => {
          event.stopPropagation()
          onOpenLibrary(cellId)
        }}
      >
        <Search size={13} />Search library
      </button>
      <input
        ref={inputRef}
        className="cell-media-slot-input"
        type="file"
        accept={mediaFileAccept[kind]}
        disabled={busy}
        onChange={(event) => {
          acceptFiles(event.target.files)
          event.target.value = ''
        }}
      />
      {state?.error && <span className="cell-media-slot-error" role="alert">{state.error}</span>}
    </section>
  )
}

function focusableDialogElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(
    'button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
  )].filter((element) => !element.hidden)
}

function MediaLibraryDialog({
  state,
  kind,
  targetBookId,
  onClose,
  onMode,
  onDraftQuery,
  onSearch,
  onLoadMore,
  onAttach,
  onReferenceFile,
  onClearReference,
  onReferenceStart,
  onReferenceDuration,
  onSimilar,
}: {
  state: MediaLibraryPickerState
  kind: PassiveMediaKind
  targetBookId: string
  onClose: () => void
  onMode: (mode: MediaSearchMode) => void
  onDraftQuery: (query: string) => void
  onSearch: () => void
  onLoadMore: () => void
  onAttach: (asset: LibraryAssetRecord) => void
  onReferenceFile: (file: File) => void
  onClearReference: () => void
  onReferenceStart: (value: string) => void
  onReferenceDuration: (value: string) => void
  onSimilar: (asset: LibraryAssetRecord) => void
}) {
  const dialogRef = useRef<HTMLElement | null>(null)
  const busy = state.activeArtifactId !== null || state.preparingReference
  const searchModes: Array<{
    id: MediaSearchMode
    label: string
    icon: typeof Search
  }> = [
    { id: 'text', label: 'Text', icon: Search },
    { id: 'image-reverse', label: 'Image reverse', icon: Image },
    { id: 'video-reverse', label: 'Vid reverse', icon: Film },
  ]

  return (
    <div
      className="media-library-backdrop"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target && !busy) onClose()
      }}
    >
      <section
        ref={dialogRef}
        className="media-library-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="media-library-title"
        aria-describedby="media-library-description"
        onKeyDown={(event: KeyboardEvent<HTMLElement>) => {
          if (event.key === 'Escape' && !busy) {
            event.preventDefault()
            onClose()
            return
          }
          if (event.key !== 'Tab' || !dialogRef.current) return
          const focusable = focusableDialogElements(dialogRef.current)
          if (focusable.length === 0) return
          const first = focusable[0]!
          const last = focusable[focusable.length - 1]!
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }}
      >
        <header>
          <div>
            <span>ALL BOOKS</span>
            <h2 id="media-library-title">Choose {kind} media</h2>
            <p id="media-library-description">
              Recent compatible assets appear first. Assets from another book are copied safely.
            </p>
          </div>
          <button
            type="button"
            className="media-library-close"
            aria-label="Close media library"
            disabled={busy}
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </header>
        <div className="media-library-modes" role="tablist" aria-label="Search mode">
          {searchModes.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={state.mode === item.id}
                className={state.mode === item.id ? 'active' : ''}
                disabled={busy}
                onClick={() => onMode(item.id)}
              >
                <Icon size={14} />{item.label}
              </button>
            )
          })}
        </div>
        <div className="media-library-search-panel">
          {state.mode === 'text' ? (
            <form
              className="media-library-search"
              onSubmit={(event) => {
                event.preventDefault()
                if (!busy) onSearch()
              }}
            >
              <label htmlFor="media-library-query">Search library</label>
              <div>
                <input
                  id="media-library-query"
                  type="search"
                  value={state.draftQuery}
                  placeholder={`Search ${kind} assets`}
                  autoFocus
                  disabled={busy}
                  onChange={(event) => onDraftQuery(event.target.value)}
                />
                <button type="submit" disabled={busy || state.loading}>
                  <Search size={14} />Search
                </button>
              </div>
            </form>
          ) : (
            <ReverseSearchReference
              mode={state.mode}
              reference={state.reference}
              preparing={state.preparingReference}
              disabled={state.activeArtifactId !== null}
              startSeconds={state.referenceStartSeconds}
              durationSeconds={state.referenceDurationSeconds}
              onFile={onReferenceFile}
              onClear={onClearReference}
              onStartSeconds={onReferenceStart}
              onDurationSeconds={onReferenceDuration}
            >
              <p className="media-library-similar-hint">
                Or choose Similar on an existing visual asset below. Reverse search spans all books.
              </p>
            </ReverseSearchReference>
          )}
          {state.mode !== 'text' && state.reference && (
            <button
              type="button"
              className="media-library-reverse-submit"
              disabled={busy || state.loading}
              onClick={onSearch}
            >
              <Search size={14} />Search similar media
            </button>
          )}
        </div>
        <div className="media-library-results" aria-busy={state.loading || state.loadingMore}>
          {state.error && <p className="media-library-error" role="alert">{state.error}</p>}
          {state.booksWithErrors.length > 0 && (
            <p className="media-library-warning" role="status">
              {state.booksWithErrors.length} book
              {state.booksWithErrors.length === 1 ? '' : 's'} could not be searched.
            </p>
          )}
          {state.loading && state.assets.length === 0 ? (
            <div className="media-library-loading">
              <LoaderCircle size={24} className="spin" />Loading recent media…
            </div>
          ) : state.assets.length === 0 ? (
            <div className="media-library-empty">
              <Library size={24} />
              <strong>No compatible media found</strong>
              <span>Try another search or upload a file directly into the slot.</span>
            </div>
          ) : (
            <div className="media-library-grid">
              {state.assets.map((asset) => {
                const active = state.activeArtifactId === asset.artifactId
                return (
                  <article
                    key={`${asset.owningBookId}:${asset.artifactId}`}
                    className="media-library-asset"
                  >
                    <MediaLibraryAssetPreview asset={asset} />
                    <span className="media-library-asset-copy">
                      <strong>@{asset.id}</strong>
                      <small>
                        {asset.owningBookSlug}
                        {asset.owningBookId === targetBookId ? ' · this book' : ' · copy'}
                      </small>
                    </span>
                    {active && (
                      <span className="media-library-asset-busy">
                        <LoaderCircle size={16} className="spin" />Attaching…
                      </span>
                    )}
                    <span className="media-library-asset-actions">
                      {(asset.type === 'image'
                        || asset.type === 'video'
                        || asset.type === 'final') && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => onSimilar(asset)}
                        >
                          <Search size={13} />Similar
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={busy}
                        aria-label={`Use @${asset.id} from ${asset.owningBookSlug}`}
                        onClick={() => onAttach(asset)}
                      >
                        Use
                      </button>
                    </span>
                  </article>
                )
              })}
            </div>
          )}
        </div>
        <footer>
          <span>
            {state.assets.length} of {state.page.total} compatible assets
          </span>
          {state.page.hasMore && (
            <button
              type="button"
              disabled={busy || state.loadingMore}
              onClick={onLoadMore}
            >
              {state.loadingMore ? <LoaderCircle size={14} className="spin" /> : <Plus size={14} />}
              {state.loadingMore ? 'Loading…' : 'Load more'}
            </button>
          )}
        </footer>
      </section>
    </div>
  )
}

const cellSourcePortSides = [
  'left',
  'right',
  'bottom',
] as const satisfies readonly NotebookSourceSide[]

const cellSourceRoutePorts = cellSourcePortSides.flatMap((side) =>
  notebookSourcePortOffsets.map((offset, index) => ({
    id: notebookSourcePortId(side, index),
    position: side === 'left'
      ? Position.Left
      : side === 'right'
        ? Position.Right
        : Position.Bottom,
    style: side === 'bottom'
      ? { left: `${offset * 100}%` }
      : { top: `${offset * 100}%` },
  })))

function CellStatusBadge({ status }: { status: string | null }) {
  if (!status) return null
  const label = status.replaceAll('-', ' ').replaceAll('_', ' ')

  return (
    <span
      className={`cell-status cell-status-${status}`}
      aria-label={`Status: ${label}`}
      title={label}
    >
      {status === 'completed'
        ? <Check size={11} strokeWidth={2.4} aria-hidden="true" />
        : <span>{label}</span>}
    </span>
  )
}

function CellNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const slotContext = useContext(MediaSlotContext)
  const runCell = useContext(CellRunContext)
  const mediaUrl = data.asset?.mediaUrl
  const thumbnailUrl = data.asset?.thumbnailUrl
  const targetInputs = data.targetInputs?.length ? data.targetInputs : ['input']
  const targetConnectionCount = data.targetConnectionCount ?? 0
  const slotKind = passiveMediaKind(data.kind)
  const emptyMediaSlot = slotKind !== null && isEmptyPassiveMediaSlot(
    data.kind,
    data.outputArtifactId,
    targetConnectionCount,
  )
  const playableVideo = data.asset?.type === 'video' || data.asset?.type === 'final'
  const playableAudio = data.asset?.type === 'audio'
  const audioCell = data.kind === 'audio' || data.kind === 'generate_audio'
  const visualMediaCell = data.kind === 'video'
    || data.kind === 'image'
    || data.kind === 'generate_video'
    || data.kind === 'generate_image'
  const textCell = data.kind === 'prompt' || data.kind === 'analyze'
  const isTopRow = data.slot.row === 0
  const action = notebookCellActionPresentation({
    type: data.kind,
    model: data.model,
    operation: data.operation,
    outputArtifactId: data.outputArtifactId,
    tool: data.tool,
  }, data.status)
  const statusLabel = notebookCellStatusLabel(data.kind, data.status)
  const running = notebookCellIsActiveStatus(data.status)
  const failed = data.status === 'error'
  const outputVersions = notebookOutputVersionArtifactIds(
    data.inputs,
    data.outputArtifactId,
  )
  const versionedOutput = (
    data.kind === 'audio'
    || data.kind === 'image'
    || data.kind === 'analysis'
  ) && outputVersions.length > 1
  const activeOutputVersion = Math.max(
    1,
    outputVersions.indexOf(data.outputArtifactId ?? '') + 1,
  )

  return (
    <article
      className={[
        'cell-node',
        `cell-kind-${data.kind}`,
        selected ? 'cell-node-selected' : '',
        running ? 'cell-node-running' : '',
        data.status === 'queued' ? 'cell-node-queued' : '',
        failed ? 'cell-node-error' : '',
        versionedOutput ? 'cell-node-version-stack' : '',
        data.deleting ? 'cell-node-deleting' : '',
        data.revealing ? 'cell-node-created' : '',
      ].filter(Boolean).join(' ')}
      aria-busy={running}
      data-version-count={outputVersions.length}
      data-cell-status={data.status}
    >
      {targetInputs.map((input, index) => (
        <Handle
          key={input}
          type="target"
          position={Position.Top}
          id={input}
          className={`cell-target-handle${isTopRow ? ' cell-target-handle-top-row' : ''}`}
          style={{ left: `${((index + 1) / (targetInputs.length + 1)) * 100}%` }}
        />
      ))}
      {targetConnectionCount > 1 && (
        <span
          className="cell-target-connection-count"
          aria-label={`${targetConnectionCount} connections`}
          data-connection-count={targetConnectionCount}
        >
          {targetConnectionCount}
        </span>
      )}
      {cellSourceRoutePorts.map((port) => (
        <Handle
          key={port.id}
          type="source"
          position={port.position}
          id={port.id}
          isConnectable={false}
          className={`cell-route-handle${data.sourcePorts?.includes(port.id) ? ' cell-route-handle-active' : ''}`}
          style={port.style}
        />
      ))}
      <section className="cell-node-shell">
        <header className="cell-node-header">
          <span><CellIcon kind={data.kind} />{cellTypeLabel(data.kind)}</span>
          {action && (
            <button
              type="button"
              className="cell-run-button nodrag"
              disabled={action.disabled}
              onClick={(event) => {
                event.stopPropagation()
                void runCell(id)
              }}
            >
              {action.label}
            </button>
          )}
          {!action && versionedOutput && (
            <span
              className="cell-version-count"
              aria-label={`Current output version ${activeOutputVersion} of ${outputVersions.length}`}
              title={`Current output · version ${activeOutputVersion} of ${outputVersions.length}`}
            >
              <Layers2 size={12} aria-hidden="true" />
              v{activeOutputVersion}/{outputVersions.length}
            </span>
          )}
        </header>
        {emptyMediaSlot && slotKind ? (
          <MediaSlotTile
            cellId={id}
            kind={slotKind}
            state={slotContext.states[id]}
            onFile={slotContext.onFile}
            onFileError={slotContext.onFileError}
            onOpenLibrary={slotContext.onOpenLibrary}
          />
        ) : data.kind === 'split_video' ? (
          <SplitVideoPreview data={data} />
        ) : data.kind === 'analysis' ? (
          <AnalysisCellSummary
            analysisInfo={data.asset?.analysisInfo ?? null}
            fallbackShotCount={asNumber(data.inputs?.shotCount)}
            fallbackSourceDurationSeconds={asNumber(data.inputs?.sourceDurationSeconds)}
          />
        ) : audioCell ? (
          <div className="cell-copy cell-copy-audio">
            {playableAudio && mediaUrl ? <audio src={mediaUrl} controls preload="metadata" /> : null}
            {data.kind === 'audio'
              ? <AudioCellSummary data={data} />
              : <span>{emptyCellLabel(data)}</span>}
          </div>
        ) : visualMediaCell && (mediaUrl || thumbnailUrl) ? (
          <div className="cell-media">
            {playableVideo && mediaUrl ? (
              <video src={mediaUrl} poster={thumbnailUrl ?? undefined} muted playsInline preload="metadata" />
            ) : (
              <img src={thumbnailUrl ?? mediaUrl ?? ''} alt={data.slug} />
            )}
            <NotebookMediaMetadata
              className="cell-media-metadata"
              width={data.asset?.width ?? null}
              height={data.asset?.height ?? null}
              durationSeconds={playableVideo ? data.asset?.duration ?? null : null}
            />
          </div>
        ) : (
          <div className={`cell-copy ${textCell ? 'cell-copy-text' : ''}`}>
            {textCell ? <p>{data.prompt || emptyCellLabel(data)}</p> : <Sparkles size={28} />}
            {!textCell && <span>{emptyCellLabel(data)}</span>}
          </div>
        )}
        <footer className="cell-node-footer">
          <strong>{notebookGridTag(data.slot)}</strong>
          <CellStatusBadge status={statusLabel} />
        </footer>
        <CellStateOverlay
          kind={data.kind}
          slug={notebookGridAddress(data.slot)}
          status={data.status}
          statusStartedAt={data.statusStartedAt}
          statusError={data.statusError}
          icon={<CellIcon kind={data.kind} />}
          onRetry={slotKind ? undefined : () => {
            void runCell(id)
          }}
        />
      </section>
      <Handle
        type="source"
        position={Position.Bottom}
        id="output"
        className="cell-connect-handle"
      />
    </article>
  )
}

const nodeTypes = { cell: CellNode }
const edgeTypes = { busRiver: BusRiverEdge }
const flowProOptions = { hideAttribution: true }
const notebookZoomActivationKeys = ['Control', 'Meta']
const notebookPanOnDragButtons: number[] = []

type AppProps = {
  initialWorkspace: InitialWorkspacePayload | null
}

function App({ initialWorkspace: initialPayload }: AppProps) {
  const initialWorkspace = useMemo(
    () => asInitialWorkspace(initialPayload),
    [initialPayload],
  )
  const mcp = useMcpConnection({
    url: mcpUrl,
    clientName: 'videobook',
    autoReconnect: 3000,
  })
  const [screen, setScreen] = useState<Screen>('notebook')
  const [books, setBooks] = useState<BookProjectSummary[]>(
    () => initialWorkspace?.books ?? [],
  )
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
  const [chatModelCatalog, setChatModelCatalog] = useState<ChatModelCatalog>(
    () => initialWorkspace?.chatModelCatalog ?? fallbackChatModelCatalog,
  )
  const [chatModel, setChatModel] = useState(() => resolveChatModelSelection(
    initialWorkspace?.chatModelCatalog ?? fallbackChatModelCatalog,
    savedValue('videobook.chat-model'),
  ))
  const [generationActions, setGenerationActions] = useState<
    NotebookGenerationAction[]
  >(() => initialWorkspace?.generationActions ?? [])
  const [providers, setProviders] = useState<ProviderRecord[]>([])
  const [storage, setStorage] = useState<unknown>(null)
  const [selectedCellId, setSelectedCellId] = useState<string | null>(null)
  const [queuedCellIds, setQueuedCellIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  )
  const [revealingCellIds, setRevealingCellIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  )
  const [deletingCellId, setDeletingCellId] = useState<string | null>(null)
  const [mediaSlotStates, setMediaSlotStates] = useState<Record<string, MediaSlotState>>({})
  const [cellRunErrors, setCellRunErrors] = useState<Record<string, string>>({})
  const [mediaLibraryPicker, setMediaLibraryPicker] = useState<MediaLibraryPickerState | null>(null)
  const momentSearchRef = useRef<MomentSearchHandle | null>(null)
  const [fullscreenCellId, setFullscreenCellId] = useState<string | null>(null)
  const [previewSlot, setPreviewSlot] = useState<NotebookGridSlot | null>(null)
  const [notebookView, setNotebookView] = useState({ y: 0, zoom: 1 })
  const [notebookSurface, setNotebookSurface] = useState({ width: 0, height: 0 })
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [sourceViewCellId, setSourceViewCellId] = useState<string | null>(null)
  const [bookMenuOpen, setBookMenuOpen] = useState(false)
  const [bookMenuLoading, setBookMenuLoading] = useState(false)
  const [bookMenuError, setBookMenuError] = useState<string | null>(null)
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
  const [pendingChatAction, setPendingChatAction] = useState<PendingChatAction | null>(null)
  const [lastEditActionId, setLastEditActionId] = useState('')
  const [secretKey, setSecretKey] = useState('KIE_API_KEY')
  const [secretValue, setSecretValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [mcpActivity, setMcpActivity] = useState<McpActivity>(idleMcpActivity)
  const [processingArtifactId, setProcessingArtifactId] = useState<string | null>(null)
  const [online, setOnline] = useState(() => window.navigator.onLine)
  const [notice, setNoticeState] = useState<WorkspaceNotice | null>({
    text: 'Connect to the server, then load your books.',
    tone: 'info',
  })
  const setNotice = useCallback((
    text: string,
    tone: WorkspaceNoticeTone = 'info',
  ) => {
    setNoticeState({ text, tone })
  }, [])
  const flowRef = useRef<ReactFlowInstance<CanvasNode, NotebookFlowEdge> | null>(null)
  const notebookScrollRef = useRef<HTMLDivElement | null>(null)
  const bookMenuRequestRef = useRef(0)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const recorderStreamRef = useRef<MediaStream | null>(null)
  const recorderChunksRef = useRef<Blob[]>([])
  const audioSpinePlayerRef = useRef<HTMLAudioElement | null>(null)
  const mediaLibraryRequestRef = useRef(0)
  const mediaLibraryOpenerRef = useRef<HTMLElement | null>(null)
  const activeWatchesRef = useRef(new Map<string, string>())
  const activeMcpCallsRef = useRef(new Map<number, { tool: string; startedAt: number }>())
  const mcpActivitySequenceRef = useRef(0)
  const mcpActivityTimerRef = useRef(0)
  const watchScopeRef = useRef<{
    bookId: string | null
    notebookId: string | null
    assets: AssetRecord[]
  }>({ bookId, notebookId: notebook?.id ?? null, assets })
  const callRef = useRef<(
    tool: string,
    args: Record<string, unknown>,
    options?: { background?: boolean },
  ) => Promise<unknown>>(async () => {
    throw new Error('MCP call is not ready')
  })
  // Monotonic clock over applied poll snapshots. Concurrent watch loops can
  // resolve out of order; a response older than the newest applied snapshot
  // must not clobber global state (it flips statuses back and forth).
  const watchSnapshotClockRef = useRef(0)
  const jobsRef = useRef<JobRecord[]>(jobs)
  const screenRef = useRef<Screen>(screen)

  const setCellRunError = useCallback((cellId: string, message: string | null) => {
    setCellRunErrors((current) => {
      if (message === null) {
        if (!(cellId in current)) return current
        const next = { ...current }
        delete next[cellId]
        return next
      }
      if (current[cellId] === message) return current
      return { ...current, [cellId]: message }
    })
  }, [])

  useEffect(() => {
    if (!notice || notice.tone !== 'info') return
    const expected = notice
    const timer = window.setTimeout(() => {
      setNoticeState((current) => current === expected ? null : current)
    }, 6_000)
    return () => window.clearTimeout(timer)
  }, [notice])
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
  const commandMentionAssets = useMemo(
    () => notebookMentionAssets(notebook?.cells ?? [], assets),
    [assets, notebook],
  )
  const pendingGenerationDraft = pendingChatAction?.kind === 'generation'
    ? pendingChatAction.draft
    : null
  const pendingRoutedActionReview = pendingChatAction?.kind === 'routed'
    ? routedActionReview({
        input: pendingChatAction.plan.prompt,
        params: pendingChatAction.plan.params,
        tool: pendingChatAction.plan.routedTool,
      })
    : null
  const pendingGenerationConnectedInputs = useMemo(
    () => pendingGenerationDraft && notebook
      ? notebookChatGenerationConnectedInputs(pendingGenerationDraft, notebook)
      : [],
    [notebook, pendingGenerationDraft],
  )
  const pendingGenerationActionOptions = useMemo(
    () => pendingGenerationDraft
      ? compatibleGenerationActions(
          generationActions,
          pendingGenerationDraft.cell.type as NotebookChatGenerationCommand['cellType'],
          pendingGenerationConnectedInputs,
        )
      : [],
    [
      generationActions,
      pendingGenerationConnectedInputs,
      pendingGenerationDraft,
    ],
  )
  const pendingGenerationModeOptions = useMemo(
    () => pendingGenerationDraft
      ? compatibleGenerationModes(
          pendingGenerationDraft.action,
          pendingGenerationConnectedInputs,
        )
      : [],
    [pendingGenerationConnectedInputs, pendingGenerationDraft],
  )
  const pendingGenerationSources = useMemo<GenerationReviewSource[]>(
    () => pendingGenerationDraft && notebook
      ? pendingGenerationDraft.sourceCellIds.flatMap((cellId) => {
          const cell = notebook.cells.find((candidate) => candidate.id === cellId)
          if (!cell) return []
          return [{
            cellId,
            slug: notebookGridAddress(cell.slot),
            type: cell.type,
            asset: cell.outputArtifactId
              ? assetById.get(cell.outputArtifactId) ?? null
              : null,
          }]
        })
      : [],
    [assetById, notebook, pendingGenerationDraft],
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
    () => asGenerationPlans(notebook?.generationPlans),
    [notebook],
  )
  const canAttachToTranscript = useMemo(() => {
    const selection = record(notebook?.currentSelection)
    return record(selection?.sequence)?.range !== undefined
  }, [notebook])
  const activeSequenceRange = useMemo(() => {
    const selection = record(notebook?.currentSelection)
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

  const call = useCallback(async (
    tool: string,
    args: Record<string, unknown>,
    options?: { background?: boolean },
  ) => {
    if (mcp.state !== 'ready') throw new Error('MCP server is not ready')
    if (options?.background || !shouldNotifyMcpActivity(tool)) {
      return parseResult(await mcp.callTool(tool, args))
    }
    const sequence = mcpActivitySequenceRef.current + 1
    mcpActivitySequenceRef.current = sequence
    window.clearTimeout(mcpActivityTimerRef.current)
    activeMcpCallsRef.current.set(sequence, { tool, startedAt: performance.now() })
    setMcpActivity({
      phase: 'active',
      tool,
      count: activeMcpCallsRef.current.size,
      sequence,
    })
    let phase: 'success' | 'error' = 'success'
    try {
      return parseResult(await mcp.callTool(tool, args))
    } catch (error) {
      phase = 'error'
      throw error
    } finally {
      const completed = activeMcpCallsRef.current.get(sequence)
      activeMcpCallsRef.current.delete(sequence)
      const remaining = [...activeMcpCallsRef.current.values()].at(-1)
      if (remaining) {
        mcpActivitySequenceRef.current += 1
        setMcpActivity({
          phase: 'active',
          tool: remaining.tool,
          count: activeMcpCallsRef.current.size,
          sequence: mcpActivitySequenceRef.current,
        })
      } else {
        const settle = () => {
          if (activeMcpCallsRef.current.size > 0) return
          mcpActivitySequenceRef.current += 1
          setMcpActivity({
            phase,
            tool,
            count: 0,
            sequence: mcpActivitySequenceRef.current,
          })
          mcpActivityTimerRef.current = window.setTimeout(() => {
            if (activeMcpCallsRef.current.size > 0) return
            mcpActivitySequenceRef.current += 1
            setMcpActivity({
              ...idleMcpActivity,
              sequence: mcpActivitySequenceRef.current,
            })
          }, phase === 'error' ? 1100 : 620)
        }
        const elapsed = completed ? performance.now() - completed.startedAt : 420
        const remainingActiveTime = Math.max(0, 420 - elapsed)
        if (remainingActiveTime > 0) {
          mcpActivityTimerRef.current = window.setTimeout(settle, remainingActiveTime)
        } else {
          settle()
        }
      }
    }
  }, [mcp])

  useEffect(() => () => {
    window.clearTimeout(mcpActivityTimerRef.current)
  }, [])

  useEffect(() => {
    callRef.current = call
  }, [call])

  useEffect(() => {
    watchScopeRef.current = {
      bookId,
      notebookId: notebook?.id ?? null,
      assets,
    }
  }, [assets, bookId, notebook?.id])

  useEffect(() => {
    jobsRef.current = jobs
  }, [jobs])

  useEffect(() => {
    screenRef.current = screen
  }, [screen])

  // Poll loops feed job snapshots through here instead of raw setJobs so an
  // unchanged jobs list never re-renders the app. The snapshot timestamp only
  // matters for elapsed-time display on the jobs screen, so it advances only
  // when the list changes or that screen is watching a live job.
  const applyJobsSnapshot = useCallback((nextJobs: JobRecord[]) => {
    const changed = !jsonEqual(jobsRef.current, nextJobs)
    if (changed) {
      jobsRef.current = nextJobs
      setJobs(nextJobs)
    }
    const ticking = screenRef.current === 'jobs'
      && nextJobs.some((job) => activeJobStates.has(job.state))
    if (changed || ticking) setJobSnapshotAt(Date.now())
  }, [])

  const setMediaSlotOperation = useCallback((
    cellId: string,
    operation: MediaSlotOperation | null,
    error: string | null = null,
  ) => {
    setMediaSlotStates((current) => ({
      ...current,
      [cellId]: { operation, error },
    }))
  }, [])

  const setMediaSlotError = useCallback((cellId: string, message: string) => {
    setMediaSlotOperation(cellId, null, message)
  }, [setMediaSlotOperation])

  const setCellQueued = useCallback((cellId: string, queued: boolean) => {
    setQueuedCellIds((current) => {
      const next = new Set(current)
      if (queued) next.add(cellId)
      else next.delete(cellId)
      return next.size === current.size ? current : next
    })
  }, [])

  const revealCells = useCallback((cellIds: readonly string[]) => {
    setRevealingCellIds((current) => new Set([...current, ...cellIds]))
    window.setTimeout(() => {
      setRevealingCellIds((current) => {
        const next = new Set(current)
        for (const cellId of cellIds) next.delete(cellId)
        return next.size === current.size ? current : next
      })
    }, 900)
  }, [])

  const focusCommandComposer = useCallback(() => {
    restoreCommandComposerFocus(() =>
      document.querySelector<HTMLInputElement>('.command-composer input'))
  }, [])

  useEffect(() => {
    const updateOnlineState = () => setOnline(window.navigator.onLine)
    window.addEventListener('online', updateOnlineState)
    window.addEventListener('offline', updateOnlineState)
    return () => {
      window.removeEventListener('online', updateOnlineState)
      window.removeEventListener('offline', updateOnlineState)
    }
  }, [])

  const createGenerationPlan = useCallback(async (
    cellId: string,
    sourceSurface: 'ui' | 'slash' | 'chat',
  ): Promise<CommandPlan> => {
    if (!bookId || !notebook) {
      throw new Error('Load a notebook first.')
    }
    const startFrame = Number(timelineSelectionStart)
    const durationFrames = Number(timelineSelectionDuration)
    return asCommandPlan(await call('plan_notebook_generation', {
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
  }, [
    bookId,
    call,
    notebook,
    timelineSelectionDuration,
    timelineSelectionStart,
  ])

  const prepareGenerationPlan = useCallback(async (
    cellId: string,
    sourceSurface: 'ui' | 'slash' | 'chat',
  ): Promise<ComposerOutcome> => {
    const plan = await createGenerationPlan(cellId, sourceSurface)
    setPendingChatAction(null)
    setPendingCommandPlan({ plan, previews: {} })
    focusCommandComposer()
    return applyReadyOutcome('Generation plan ready for review')
  }, [createGenerationPlan, focusCommandComposer])

  const [nodes, setNodes] = useState<CanvasNode[]>(() =>
    initialWorkspace?.notebook
      ? canvasNodes(
          initialWorkspace.notebook,
          initialWorkspace.assets,
          initialWorkspace.jobs,
        )
      : [])
  const [edges, setEdges] = useState<NotebookFlowEdge[]>(() =>
    initialWorkspace?.notebook ? notebookEdges(initialWorkspace.notebook) : [])

  const applyNotebook = useCallback((
    next: NotebookDocument,
    nextAssets: AssetRecord[],
    nextJobs: JobRecord[],
  ) => {
    setNotebook((current) => jsonEqual(current, next) ? current : next)
    const cellIds = new Set(next.cells.map((cell) => cell.id))
    setQueuedCellIds((current) => {
      const retained = new Set([...current].filter((cellId) => cellIds.has(cellId)))
      return retained.size === current.size ? current : retained
    })
    setRevealingCellIds((current) => {
      const retained = new Set([...current].filter((cellId) => cellIds.has(cellId)))
      return retained.size === current.size ? current : retained
    })
    setMediaSlotStates((current) => Object.fromEntries(
      Object.entries(current).filter(([cellId]) => cellIds.has(cellId)),
    ))
    setCellRunErrors((current) => Object.fromEntries(
      Object.entries(current).filter(([cellId]) => cellIds.has(cellId)),
    ))
    setMediaLibraryPicker((current) =>
      current && cellIds.has(current.cellId) ? current : null)
    setNodes((current) =>
      reconcileCanvasNodes(current, canvasNodes(next, nextAssets, nextJobs)))
    setEdges((current) => reconcileFlowEdges(current, notebookEdges(next)))
    setSelectedCellId((current) =>
      current && next.cells.some((cell) => cell.id === current) ? current : null)
  }, [])

  const watchNotebookRun = useCallback(async (params: {
    bookId: string
    notebookId: string
    cellId: string
    slug: string
    runId: string
    jobOperationId: string
    intervalMs: number
    timeoutMs: number
    maxPollFailures: number
  }): Promise<{
    kind: NotebookRunWatchOutcomeKind
    message?: string
  }> => {
    activeWatchesRef.current.set(params.cellId, params.runId)
    let sawRun = false
    let consecutiveFailures = 0
    const deadline = Date.now() + params.timeoutMs
    try {
      while (Date.now() < deadline) {
        if (activeWatchesRef.current.get(params.cellId) !== params.runId) {
          return { kind: 'superseded' }
        }
        const scope = watchScopeRef.current
        if (
          scope.bookId !== params.bookId
          || scope.notebookId !== params.notebookId
        ) {
          return { kind: 'superseded' }
        }
        try {
          const fetchedAt = performance.now()
          const [notebookValue, jobValue] = await Promise.all([
            callRef.current('get_notebook', {
              book_id: params.bookId,
              notebook_id: params.notebookId,
            }, { background: true }),
            callRef.current('list_jobs', {
              book_id: params.bookId,
              limit: 200,
            }, { background: true }),
          ])
          consecutiveFailures = 0
          const afterScope = watchScopeRef.current
          if (
            afterScope.bookId !== params.bookId
            || afterScope.notebookId !== params.notebookId
            || activeWatchesRef.current.get(params.cellId) !== params.runId
          ) {
            return { kind: 'superseded' }
          }
          const nextNotebook = asNotebook(notebookValue)
          if (!nextNotebook) {
            throw new Error('The server returned an invalid notebook')
          }
          const nextJobs = asJobs(jobValue)
          const fresh = fetchedAt >= watchSnapshotClockRef.current
          if (fresh) {
            watchSnapshotClockRef.current = fetchedAt
            applyJobsSnapshot(nextJobs)
          }
          const jobViews = nextJobs.map(notebookRunJobViewFromRecord)
          const effectiveJob = selectEffectiveNotebookRunJob({
            jobs: jobViews,
            cellId: params.cellId,
            runId: params.runId,
            jobOperationId: params.jobOperationId,
          })
          const observation = notebookCellRunObservation(
            nextNotebook,
            params.cellId,
            params.runId,
          )
          if (observation.state !== 'pending') {
            setCellQueued(params.cellId, false)
          }
          if (fresh) applyNotebook(nextNotebook, afterScope.assets, nextJobs)
          const step = notebookRunWatchStep({
            observation,
            job: effectiveJob,
            slug: params.slug,
            sawRun,
          })
          if (step.kind === 'continue') {
            sawRun = step.sawRun
            await delay(params.intervalMs)
            continue
          }
          if (step.kind === 'completed') {
            const assetsFetchedAt = performance.now()
            const assetValue = await callRef.current('list_assets', {
              book_id: params.bookId,
              sort: 'newest',
              limit: 200,
              include_referenced: true,
            }, { background: true })
            const nextAssets = asAssets(assetValue)
            if (assetsFetchedAt >= watchSnapshotClockRef.current) {
              watchSnapshotClockRef.current = assetsFetchedAt
              setAssets((current) =>
                jsonEqual(current, nextAssets) ? current : nextAssets)
              applyNotebook(nextNotebook, nextAssets, nextJobs)
            }
            setCellRunError(params.cellId, null)
            return { kind: 'completed' }
          }
          if (step.kind === 'failed') {
            return { kind: 'failed', message: step.message }
          }
          return { kind: 'superseded' }
        } catch (error) {
          consecutiveFailures += 1
          if (consecutiveFailures >= params.maxPollFailures) {
            const detail = error instanceof Error ? error.message : String(error)
            return {
              kind: 'failed',
              message:
                `Lost contact with the server while watching @${params.slug}: ${detail}`,
            }
          }
          await delay(params.intervalMs)
        }
      }
      return { kind: 'timeout' }
    } finally {
      if (activeWatchesRef.current.get(params.cellId) === params.runId) {
        activeWatchesRef.current.delete(params.cellId)
      }
    }
  }, [applyJobsSnapshot, applyNotebook, setCellQueued, setCellRunError])

  const watchGenerationRun = useCallback(async (params: {
    bookId: string
    notebookId: string
    cellId: string
    slug: string
    runId: string
    jobOperationId: string
  }) => {
    try {
      const outcome = await watchNotebookRun({
        ...params,
        intervalMs: notebookGenerationWatchIntervalMs,
        timeoutMs: notebookGenerationWatchTimeoutMs,
        maxPollFailures: 10,
      })
      if (outcome.kind === 'completed') {
        setNotice(`@${params.slug} generated`)
        setCellRunError(params.cellId, null)
        return
      }
      if (outcome.kind === 'failed') {
        const message = outcome.message ?? `@${params.slug} failed`
        setCellRunError(params.cellId, message)
        setNotice(message, 'error')
        return
      }
      if (outcome.kind === 'timeout') {
        setNotice(
          `@${params.slug} is still running — check the Jobs screen`,
        )
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setCellRunError(params.cellId, message)
      setNotice(message, 'error')
    } finally {
      setCellQueued(params.cellId, false)
    }
  }, [setCellQueued, setCellRunError, setNotice, watchNotebookRun])

  const watchDownloadedAsset = useCallback(async (params: {
    bookId: string
    notebookId: string
    cellId: string
    slug: string
    artifactId: string
  }) => {
    const token = `download:${params.artifactId}`
    activeWatchesRef.current.set(params.cellId, token)
    let consecutiveFailures = 0
    const deadline = Date.now() + downloadWatchTimeoutMs
    try {
      while (Date.now() < deadline) {
        const scope = watchScopeRef.current
        if (
          activeWatchesRef.current.get(params.cellId) !== token
          || scope.bookId !== params.bookId
          || scope.notebookId !== params.notebookId
        ) {
          return
        }
        try {
          const fetchedAt = performance.now()
          const [notebookValue, assetValue, jobValue] = await Promise.all([
            callRef.current('get_notebook', {
              book_id: params.bookId,
              notebook_id: params.notebookId,
            }, { background: true }),
            callRef.current('list_assets', {
              book_id: params.bookId,
              sort: 'newest',
              limit: 200,
              include_referenced: true,
            }, { background: true }),
            callRef.current('list_jobs', {
              book_id: params.bookId,
              limit: 200,
            }, { background: true }),
          ])
          consecutiveFailures = 0
          const afterScope = watchScopeRef.current
          if (
            activeWatchesRef.current.get(params.cellId) !== token
            || afterScope.bookId !== params.bookId
            || afterScope.notebookId !== params.notebookId
          ) {
            return
          }
          const nextNotebook = asNotebook(notebookValue)
          if (!nextNotebook) {
            throw new Error('The server returned an invalid notebook')
          }
          const cell = nextNotebook.cells.find((candidate) =>
            candidate.id === params.cellId)
          if (!cell || cell.outputArtifactId !== params.artifactId) return
          const nextAssets = asAssets(assetValue)
          const nextJobs = asJobs(jobValue)
          if (fetchedAt >= watchSnapshotClockRef.current) {
            watchSnapshotClockRef.current = fetchedAt
            setAssets((current) =>
              jsonEqual(current, nextAssets) ? current : nextAssets)
            applyJobsSnapshot(nextJobs)
            applyNotebook(nextNotebook, nextAssets, nextJobs)
          }
          const step = downloadWatchStep(
            params.artifactId,
            nextAssets.find((asset) => asset.artifactId === params.artifactId),
            nextJobs,
          )
          if (step.kind === 'completed') {
            setCellRunError(params.cellId, null)
            setNotice(`@${params.slug} downloaded`)
            return
          }
          if (step.kind === 'failed') {
            setCellRunError(params.cellId, step.message)
            setNotice(step.message, 'error')
            return
          }
          await delay(downloadWatchIntervalMs)
        } catch (error) {
          consecutiveFailures += 1
          if (consecutiveFailures >= 10) {
            const detail = error instanceof Error ? error.message : String(error)
            setNotice(
              `Stopped watching @${params.slug}: ${detail}. Check the Jobs screen.`,
              'error',
            )
            return
          }
          await delay(downloadWatchIntervalMs)
        }
      }
      setNotice(
        `@${params.slug} is still downloading — check the Jobs screen`,
      )
    } finally {
      if (activeWatchesRef.current.get(params.cellId) === token) {
        activeWatchesRef.current.delete(params.cellId)
      }
    }
  }, [applyJobsSnapshot, applyNotebook, setCellRunError, setNotice])

  const runCell = useCallback(async (
    cellId: string,
    providedNotebook?: NotebookSnapshot,
  ) => {
    if (!bookId || !notebook) return
    setBusy(true)
    setCellRunError(cellId, null)
    try {
      const currentNotebook = providedNotebook ?? asNotebook(await call(
        'get_notebook',
        {
          book_id: bookId,
          notebook_id: notebook.id,
        },
      ))
      if (!currentNotebook) {
        throw new Error('The server returned an invalid notebook')
      }
      const cell = currentNotebook.cells.find((candidate) =>
        candidate.id === cellId)
      if (!cell || !isRunnableCell(cell)) {
        throw new Error('Configure this cell before running it')
      }
      const cloud = isGenerationCell(cell)
      if (cloud && !online) {
        throw new Error(
          'Offline: cloud generation is unavailable. '
          + 'Local search, editing, playback, and export remain available.',
        )
      }
      if (cloud) {
        const outcome = await prepareGenerationPlan(cellId, 'ui')
        setNotice(outcome.message, outcome.ok ? 'info' : 'error')
        return outcome
      }
      const accepted = await startNotebookCellRun({
        start: () => call('run_notebook_cell', {
          book_id: bookId,
          notebook_id: currentNotebook.id,
          cell_id: cellId,
          actor: 'videobook-user',
          ...(currentNotebook.revision
            ? { expected_revision: currentNotebook.revision }
            : {}),
        }),
        onStarting: () => setCellQueued(cellId, true),
        onRejected: () => setCellQueued(cellId, false),
      })
      const runId = asString(record(accepted)?.run_id)
      const jobOperationId = asString(record(accepted)?.job_id)
      if (!runId || !jobOperationId) {
        throw new Error('The server did not return a notebook run')
      }
      setNotice(`${notebookGridTag(cell.slot)} queued`)
      const outcome = await watchNotebookRun({
        bookId,
        notebookId: currentNotebook.id,
        cellId,
        slug: notebookGridAddress(cell.slot),
        runId,
        jobOperationId,
        intervalMs: notebookRunPollIntervalMs,
        timeoutMs: notebookRunPollTimeoutMs,
        maxPollFailures: 1,
      })
      if (outcome.kind === 'failed') {
        throw new Error(outcome.message ?? `${notebookGridTag(cell.slot)} failed`)
      }
      if (outcome.kind === 'timeout') {
        throw new Error('Notebook run did not finish within five minutes')
      }
      if (outcome.kind === 'completed') {
        setNotice(`${notebookGridTag(cell.slot)} updated`)
      }
      return {
        ok: true,
        message: `${notebookGridTag(cell.slot)} run accepted`,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setCellRunError(cellId, message)
      setNotice(message, 'error')
      return { ok: false, message }
    } finally {
      setCellQueued(cellId, false)
      setBusy(false)
    }
  }, [
    bookId,
    call,
    notebook,
    online,
    prepareGenerationPlan,
    setCellQueued,
    setCellRunError,
    setNotice,
    watchNotebookRun,
  ])

  const presentedNodes = useMemo(() => {
    let next = nodes
    for (const cellId of queuedCellIds) {
      next = notebookNodesWithCellStatus(next, cellId, 'queued')
    }
    if (revealingCellIds.size > 0) {
      next = next.map((node) => revealingCellIds.has(node.id)
        ? { ...node, data: { ...node.data, revealing: true } }
        : node)
    }
    if (Object.keys(cellRunErrors).length === 0) return next
    return next.map((node) => {
      const liveError = cellRunErrors[node.id]
      if (!liveError) return node
      return {
        ...node,
        data: {
          ...node.data,
          status: 'error',
          statusError: liveError,
        },
      }
    })
  }, [cellRunErrors, nodes, queuedCellIds, revealingCellIds])
  const focusedEdges = useMemo(
    () => notebookEdgesWithCellFocus(edges, selectedCellId),
    [edges, selectedCellId],
  )
  const notebookBaseMetrics = useMemo(
    () => notebookGridMetrics(
      nodes.map((node) => node.data.slot),
      {
        viewportWidth: notebookSurface.width,
        viewportHeight: notebookSurface.height,
        zoom: notebookView.zoom,
      },
    ),
    [
      nodes,
      notebookSurface.height,
      notebookSurface.width,
      notebookView.zoom,
    ],
  )
  const notebookMetrics = useMemo(
    () => previewSlot
      ? notebookGridMetrics(
          nodes.map((node) => node.data.slot),
          {
            preview: previewSlot,
            viewportWidth: notebookSurface.width,
            viewportHeight: notebookSurface.height,
            zoom: notebookView.zoom,
          },
        )
      : notebookBaseMetrics,
    [
      nodes,
      notebookBaseMetrics,
      notebookSurface.height,
      notebookSurface.width,
      notebookView.zoom,
      previewSlot,
    ],
  )
  const notebookFrameSize = useMemo(
    () => notebookGridFrameSize(notebookMetrics, notebookView.zoom),
    [notebookMetrics, notebookView.zoom],
  )
  const notebookFlowStyle = useMemo<CSSProperties>(
    () => ({
      width: notebookFrameSize.width,
      height: notebookFrameSize.height,
    }),
    [notebookFrameSize.height, notebookFrameSize.width],
  )
  const notebookViewport = useMemo(
    () => notebookGridViewport(
      notebookMetrics,
      notebookView.zoom,
      notebookView.y,
    ),
    [notebookMetrics, notebookView.y, notebookView.zoom],
  )
  const updateNotebookViewport = useCallback((viewport: Viewport) => {
    const zoom = normalizeNotebookGridZoom(viewport.zoom)
    setNotebookView((current) => {
      const y = zoom === current.zoom
        ? current.y
        : Number.isFinite(viewport.y)
          ? viewport.y
          : 0
      return current.zoom === zoom && current.y === y
        ? current
        : { y, zoom }
    })
  }, [])
  const adjustNotebookZoom = useCallback((change: number) => {
    setNotebookView((current) => ({
      ...current,
      zoom: normalizeNotebookGridZoom(current.zoom + change),
    }))
  }, [])
  const resetNotebookZoom = useCallback(() => {
    setNotebookView({ y: 0, zoom: 1 })
  }, [])
  const revealLatestNotebookResult = useCallback(() => {
    if (screen !== 'notebook') return
    revealNotebookResult(() => notebookScrollRef.current)
  }, [screen])
  const dismissPendingCommandPlan = useCallback(() => {
    setPendingCommandPlan(null)
    setPendingChatAction(null)
    focusCommandComposer()
  }, [focusCommandComposer])
  const loadPendingGenerationPreview = useCallback(async (
    draft: NotebookChatGenerationDraft,
    document: NotebookDocument,
  ): Promise<unknown> => {
    if (!bookId) throw new Error('Open a book before previewing generation.')
    return await call('preview_notebook_generation', {
      book_id: bookId,
      notebook_id: document.id,
      cell_id: draft.cell.id,
      draft: {
        type: draft.cell.type,
        slug: draft.cell.slug,
        slot: draft.cell.slot,
        prompt: draft.cell.prompt ?? '',
        provider: draft.cell.provider ?? draft.action.provider,
        model: draft.cell.model ?? draft.action.model,
        operation: draft.cell.operation ?? draft.action.operation,
        tool: draft.cell.tool ?? draft.action.tool,
        inputs: draft.cell.inputs ?? {},
      },
      connections: draft.connections.map((connection) => ({
        source_cell_id: connection.sourceCellId,
        target_input: connection.targetInput,
      })),
    })
  }, [bookId, call])
  const requestPendingGenerationPreview = useCallback((
    draft: NotebookChatGenerationDraft,
    document: NotebookDocument,
  ) => {
    const requestKey = JSON.stringify({
      id: draft.cell.id,
      prompt: draft.cell.prompt,
      action: draft.action.id,
      inputs: draft.cell.inputs,
      connections: draft.connections,
    })
    setPendingChatAction((current) => current?.kind === 'generation'
      && current.draft.cell.id === draft.cell.id
      ? {
          ...current,
          previewError: null,
          previewLoading: true,
          previewStale: false,
        }
      : current)
    void loadPendingGenerationPreview(draft, document)
      .then((preview) => {
        setPendingChatAction((current) => {
          if (current?.kind !== 'generation') return current
          const currentKey = JSON.stringify({
            id: current.draft.cell.id,
            prompt: current.draft.cell.prompt,
            action: current.draft.action.id,
            inputs: current.draft.cell.inputs,
            connections: current.draft.connections,
          })
          return currentKey === requestKey
            ? {
                ...current,
                preview,
                previewError: null,
                previewLoading: false,
                previewStale: false,
              }
            : current
        })
      })
      .catch((error: unknown) => {
        setPendingChatAction((current) => {
          if (current?.kind !== 'generation') return current
          const currentKey = JSON.stringify({
            id: current.draft.cell.id,
            prompt: current.draft.cell.prompt,
            action: current.draft.action.id,
            inputs: current.draft.cell.inputs,
            connections: current.draft.connections,
          })
          return currentKey === requestKey
            ? {
                ...current,
                previewError: error instanceof Error ? error.message : String(error),
                previewLoading: false,
              }
            : current
        })
      })
  }, [loadPendingGenerationPreview])
  const setPendingGenerationDraft = useCallback((
    draft: NotebookChatGenerationDraft,
    refreshPreview: boolean,
  ) => {
    setPendingChatAction((current) => current?.kind === 'generation'
      && current.draft.cell.id === draft.cell.id
      ? {
          ...current,
          draft,
          previewError: null,
          previewLoading: false,
          previewStale: true,
        }
      : current)
    if (refreshPreview && notebook) {
      requestPendingGenerationPreview(draft, notebook)
    }
  }, [notebook, requestPendingGenerationPreview])
  const updatePendingGenerationPrompt = useCallback((prompt: string) => {
    if (!pendingGenerationDraft) return
    setPendingGenerationDraft(
      reviseNotebookChatGenerationPrompt(pendingGenerationDraft, prompt),
      false,
    )
  }, [pendingGenerationDraft, setPendingGenerationDraft])
  const updatePendingGenerationAction = useCallback((actionId: string) => {
    if (!pendingGenerationDraft) return
    const action = pendingGenerationActionOptions.find((candidate) =>
      candidate.id === actionId)
    if (!action) return
    setPendingGenerationDraft(reviseNotebookChatGenerationAction(
      pendingGenerationDraft,
      action,
      pendingGenerationConnectedInputs,
    ), true)
  }, [
    pendingGenerationActionOptions,
    pendingGenerationConnectedInputs,
    pendingGenerationDraft,
    setPendingGenerationDraft,
  ])
  const updatePendingGenerationMode = useCallback((modeId: string) => {
    if (!pendingGenerationDraft) return
    setPendingGenerationDraft(reviseNotebookChatGenerationMode(
      pendingGenerationDraft,
      modeId,
      pendingGenerationConnectedInputs,
    ), true)
  }, [
    pendingGenerationConnectedInputs,
    pendingGenerationDraft,
    setPendingGenerationDraft,
  ])
  const updatePendingGenerationSetting = useCallback((
    name: string,
    value: GenerationControlValue | undefined,
  ) => {
    if (!pendingGenerationDraft) return
    setPendingGenerationDraft(reviseNotebookChatGenerationSetting(
      pendingGenerationDraft,
      name,
      value,
    ), true)
  }, [pendingGenerationDraft, setPendingGenerationDraft])
  const refreshPendingGenerationPreview = useCallback(() => {
    if (!pendingGenerationDraft || !notebook) return
    requestPendingGenerationPreview(pendingGenerationDraft, notebook)
  }, [notebook, pendingGenerationDraft, requestPendingGenerationPreview])
  const selectPendingGenerationSource = useCallback((cellId: string) => {
    setSelectedCellId(cellId)
    setInspectorOpen(true)
  }, [])

  useLayoutEffect(() => {
    const container = notebookScrollRef.current
    if (!container) return
    const sync = () => {
      setNotebookSurface((current) => {
        const next = {
          width: container.clientWidth,
          height: container.clientHeight,
        }
        return current.width === next.width && current.height === next.height
          ? current
          : next
      })
    }
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(container)
    return () => observer.disconnect()
  }, [notebook?.id])

  useLayoutEffect(() => {
    const container = notebookScrollRef.current
    if (!container) return
    container.scrollLeft = 0
    container.scrollTop = 0
  }, [bookId, notebook?.id])

  const selectedCell = useMemo(
    () => presentedNodes.find((node) => node.id === selectedCellId) ?? null,
    [presentedNodes, selectedCellId],
  )
  const selectedNotebookCell = useMemo(
    () => notebook?.cells.find((cell) => cell.id === selectedCellId) ?? null,
    [notebook, selectedCellId],
  )
  const notebookCellAssets = useMemo(
    () => new Map((notebook?.cells ?? []).flatMap((cell) => {
      const cellAsset = artifactForCell(assetById, cell.outputArtifactId)
      return cellAsset ? [[cell.id, cellAsset] as const] : []
    })),
    [assetById, notebook],
  )
  const selectedCellError = notebook && selectedNotebookCell
    ? (
      notebookCellExecutionObservation(notebook, selectedNotebookCell.id).error
      ?? cellRunErrors[selectedNotebookCell.id]
      ?? null
    )
    : null
  const selectedCellVersionAssets = useMemo(() => {
    if (
      !selectedNotebookCell
      || (
        selectedNotebookCell.type !== 'audio'
        && selectedNotebookCell.type !== 'image'
        && selectedNotebookCell.type !== 'analysis'
      )
    ) {
      return []
    }
    return notebookOutputVersionArtifactIds(
      selectedNotebookCell.inputs,
      selectedNotebookCell.outputArtifactId,
    ).flatMap((artifactId) => {
      const versionAsset = assetById.get(artifactId)
      return versionAsset ? [versionAsset] : []
    })
  }, [assetById, selectedNotebookCell])
  const selectedMediaSlotState = selectedNotebookCell
    ? mediaSlotStates[selectedNotebookCell.id]
    : undefined
  const fullscreenCell = useMemo(
    () => notebook?.cells.find((cell) => cell.id === fullscreenCellId) ?? null,
    [fullscreenCellId, notebook],
  )
  const fullscreenNode = useMemo(
    () => nodes.find((node) => node.id === fullscreenCellId) ?? null,
    [fullscreenCellId, nodes],
  )
  const closeMediaFullscreen = useCallback(() => {
    setFullscreenCellId(null)
  }, [])

  const previewGenerationPayload = useCallback(async (
    cellId: string,
    draft: GenerationPreviewDraft,
  ) => {
    if (!bookId || !notebook) throw new Error('Notebook is not ready')
    return await call('preview_notebook_generation', {
      book_id: bookId,
      notebook_id: notebook.id,
      cell_id: cellId,
      draft,
    })
  }, [bookId, call, notebook])

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
    applyNotebook(next, assets, jobs)
    const nextAudio = asAudioNotebook(audioValue)
    setAudioNotebook(nextAudio)
    setAudioSpineAssetId(nextAudio.spine?.artifactId ?? '')
    return next
  }, [applyNotebook, assets, call, jobs])

  const refreshBookData = useCallback(async (targetBookId: string, preferredNotebookId?: string) => {
    const [
      notebookValue,
      assetValue,
      sequenceValue,
      jobValue,
      ingestStatusValue,
      actionValue,
    ] = await Promise.all([
      call('list_notebooks', { book_id: targetBookId }),
      call('list_assets', {
        book_id: targetBookId,
        sort: 'newest',
        limit: 200,
        include_referenced: true,
      }),
      call('get_primary_sequence', { book_id: targetBookId }),
      call('list_jobs', { book_id: targetBookId, limit: 200 }),
      call('list_ingest_status', { book_id: targetBookId, limit: 200 }),
      call('list_notebook_actions', { book_id: targetBookId }),
    ])
    const nextNotebooks = asNotebooks(notebookValue)
    const nextAssets = asAssets(assetValue)
    const nextJobs = asJobs(jobValue)
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
    setJobs(nextJobs)
    setGenerationActions(asNotebookGenerationActions(actionValue))
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
    applyNotebook(nextNotebook, nextAssets, nextJobs)
  }, [applyNotebook, call])

  const refreshBookList = useCallback(async () => {
    const value = await call('list_books', { sort: 'newest' })
    const nextBooks = asBooks(value)
    setBooks(nextBooks)
    return nextBooks
  }, [call])

  const refreshBookCommands = useCallback(async () => {
    const value = await call('slash_commands', {})
    setCommands(asCommands(value))
  }, [call])

  const refreshChatModels = useCallback(async () => {
    const catalog = asChatModelCatalog(await call('list_chat_models', {}))
    const persistedModel = savedValue('videobook.chat-model')
    setChatModelCatalog(catalog)
    setChatModel((current) => {
      const next = resolveChatModelSelection(catalog, persistedModel || current)
      saveValue('videobook.chat-model', next)
      return next
    })
  }, [call])

  const refreshComposerCatalog = useCallback(async () => {
    await Promise.all([refreshBookCommands(), refreshChatModels()])
  }, [refreshBookCommands, refreshChatModels])

  const changeChatModel = useCallback((model: string) => {
    const next = resolveChatModelSelection(chatModelCatalog, model)
    setChatModel(next)
    saveValue('videobook.chat-model', next)
  }, [chatModelCatalog])

  const refreshBookCommandsAfterMutation = useCallback(async () => {
    try {
      await refreshBookCommands()
      return null
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }, [refreshBookCommands])

  const loadBooks = useCallback(async (preferredBookId?: string) => {
    setBusy(true)
    try {
      const [nextBooks] = await Promise.all([
        refreshBookList(),
        refreshBookCommands(),
        refreshChatModels(),
      ])
      const target = nextBooks.find((book) => book.bookId === preferredBookId)
        ?? nextBooks.find((book) => book.slug === 'dancing')
        ?? nextBooks.find((book) => book.bookId === bookId)
        ?? nextBooks[0]
      if (target) {
        await refreshBookData(target.bookId)
        setNotice(`Loaded ${target.slug}`)
      } else {
        setBookId('')
        setNotebook(null)
        setAssets([])
        setGenerationActions([])
        setSequence(null)
        setNodes([])
        setEdges([])
        setNotice('No videobook projects are available.')
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setBusy(false)
    }
  }, [bookId, refreshBookCommands, refreshBookData, refreshBookList, refreshChatModels, setNotice])

  const openBookMenu = useCallback(async (): Promise<BookProjectMutationResult> => {
    const requestId = bookMenuRequestRef.current + 1
    bookMenuRequestRef.current = requestId
    setBookMenuOpen(true)
    setBookMenuLoading(true)
    setBookMenuError(null)
    try {
      await refreshBookList()
      return { ok: true }
    } catch (error) {
      const result = bookProjectFailure(error)
      if (bookMenuRequestRef.current === requestId) {
        setBookMenuError(result.error)
      }
      setNotice(result.error, 'error')
      return result
    } finally {
      if (bookMenuRequestRef.current === requestId) {
        setBookMenuLoading(false)
      }
    }
  }, [refreshBookList, setNotice])

  const handleBookMenuOpenChange = useCallback((open: boolean) => {
    if (open) {
      void openBookMenu()
      return
    }
    bookMenuRequestRef.current += 1
    setBookMenuOpen(false)
    setBookMenuLoading(false)
    setBookMenuError(null)
  }, [openBookMenu])

  const refreshOpenBookMenu = useCallback(() => {
    void openBookMenu()
  }, [openBookMenu])

  const chooseBook = useCallback(async (
    nextBookId: string,
  ): Promise<BookProjectMutationResult> => {
    setBusy(true)
    try {
      await refreshBookData(nextBookId)
      const next = books.find((book) => book.bookId === nextBookId)
      setNotice(next ? `Opened ${next.slug}` : 'Book opened')
      setScreen('notebook')
      handleBookMenuOpenChange(false)
      return { ok: true }
    } catch (error) {
      const result = bookProjectFailure(error)
      setNotice(result.error, 'error')
      return result
    } finally {
      setBusy(false)
    }
  }, [books, handleBookMenuOpenChange, refreshBookData, setNotice])

  const createBookProject = useCallback(async (
    slug: string,
  ): Promise<BookProjectMutationResult> => {
    setBusy(true)
    try {
      const created = asBook(await call('create_book', { slug }))
      if (!created) throw new Error('The server returned an invalid project')
      setBooks((current) => [
        created,
        ...current.filter((book) => book.bookId !== created.bookId),
      ])
      await refreshBookData(created.bookId)
      const commandError = await refreshBookCommandsAfterMutation()
      setScreen('notebook')
      handleBookMenuOpenChange(false)
      setNotice(commandError
        ? `Created ${created.slug}; commands could not refresh: ${commandError}`
        : `Created ${created.slug}`)
      return { ok: true }
    } catch (error) {
      const result = bookProjectFailure(error)
      setNotice(result.error, 'error')
      return result
    } finally {
      setBusy(false)
    }
  }, [
    call,
    handleBookMenuOpenChange,
    refreshBookCommandsAfterMutation,
    refreshBookData,
    setNotice,
  ])

  const renameBookProject = useCallback(async (
    targetBookId: string,
    slug: string,
  ): Promise<BookProjectMutationResult> => {
    setBusy(true)
    try {
      const renamed = asBook(await call('rename_book', {
        book_id: targetBookId,
        slug,
      }))
      if (!renamed) throw new Error('The server returned an invalid project')
      setBooks((current) => current.map((book) =>
        book.bookId === targetBookId ? renamed : book))
      const commandError = await refreshBookCommandsAfterMutation()
      setNotice(commandError
        ? `Renamed to ${renamed.slug}; commands could not refresh: ${commandError}`
        : `Renamed to ${renamed.slug}`)
      return { ok: true }
    } catch (error) {
      const result = bookProjectFailure(error)
      setNotice(result.error, 'error')
      return result
    } finally {
      setBusy(false)
    }
  }, [call, refreshBookCommandsAfterMutation, setNotice])

  const deleteBookProject = useCallback(async (
    targetBookId: string,
    confirmSlug: string,
  ): Promise<BookProjectMutationResult> => {
    if (books.length < 2) {
      return { ok: false, error: 'Create another project before deleting this one' }
    }
    const target = books.find((book) => book.bookId === targetBookId)
    const fallback = books.find((book) => book.bookId !== targetBookId)
    if (!target || !fallback) {
      return { ok: false, error: 'The selected project is no longer available' }
    }
    setBusy(true)
    try {
      await call('delete_book', {
        book_id: targetBookId,
        confirm_slug: confirmSlug,
      })
      setBooks((current) => current.filter((book) => book.bookId !== targetBookId))
      if (targetBookId === bookId) {
        await refreshBookData(fallback.bookId)
        setScreen('notebook')
        handleBookMenuOpenChange(false)
      }
      const commandError = await refreshBookCommandsAfterMutation()
      setNotice(commandError
        ? `Deleted ${target.slug}; commands could not refresh: ${commandError}`
        : `Deleted ${target.slug}`)
      return { ok: true }
    } catch (error) {
      const result = bookProjectFailure(error)
      setNotice(result.error, 'error')
      return result
    } finally {
      setBusy(false)
    }
  }, [
    bookId,
    books,
    call,
    handleBookMenuOpenChange,
    refreshBookCommandsAfterMutation,
    refreshBookData,
    setNotice,
  ])

  const createCell = async (type: NotebookCellType, position?: { x: number; y: number }) => {
    if (!bookId || !notebook) return
    const slot = position
      ? notebookGridDropSlot(position, notebookBaseMetrics)
      : nextNotebookGridSlot(nodes)
    if (
      position
      && nodes.some((node) =>
        node.data.slot.row === slot.row
        && node.data.slot.column === slot.column)
    ) {
      setNotice('Choose an empty grid square for the new cell', 'error')
      return
    }
    const slug = nextNotebookCellSlug(type, notebook.cells)
    setBusy(true)
    try {
      await call('create_notebook_cell', {
        book_id: bookId,
        notebook_id: notebook.id,
        cell: {
          type,
          slug,
          slot,
          ...(type === 'prompt'
            || type === 'analyze'
            || type === 'generate_video'
            || type === 'generate_image'
            || type === 'generate_audio'
            ? { prompt: '' }
            : {}),
        },
      })
      await refreshBookData(bookId, notebook.id)
      setNotice(`Added ${notebookGridTag(slot)} cell`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  const updateCell = async (patch: Record<string, unknown>) => {
    if (!bookId || !notebook || !selectedCell) return false
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
      return true
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : String(error),
        'error',
      )
      return false
    } finally {
      setBusy(false)
    }
  }

  const setSelectedCellInput = async (
    targetInput: string,
    sourceCellId: string | null,
  ) => {
    if (!bookId || !notebook || !selectedNotebookCell) return
    setBusy(true)
    try {
      await call('set_notebook_cell_input', {
        book_id: bookId,
        notebook_id: notebook.id,
        target_cell_id: selectedNotebookCell.id,
        target_input: targetInput,
        source_cell_id: sourceCellId,
      })
      await refreshNotebook(bookId, notebook.id)
      setNotice(sourceCellId ? 'Input source replaced' : 'Input source cleared')
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : String(error),
        'error',
      )
    } finally {
      setBusy(false)
    }
  }

  const deleteSelectedCell = async () => {
    if (!bookId || !notebook || !selectedCell) return
    const cellId = selectedCell.id
    setDeletingCellId(cellId)
    setNodes((current) => current.map((node) => node.id === cellId
      ? { ...node, data: { ...node.data, deleting: true } }
      : node))
    setBusy(true)
    try {
      await delay(180)
      await call('delete_notebook_cell', {
        book_id: bookId,
        notebook_id: notebook.id,
        cell_id: cellId,
      })
      if (fullscreenCellId === cellId) setFullscreenCellId(null)
      await refreshBookData(bookId, notebook.id)
      setNotice('Cell deleted')
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : String(error),
        'error',
      )
    } finally {
      setNodes((current) => current.map((node) => node.id === cellId
        ? { ...node, data: { ...node.data, deleting: false } }
        : node))
      setDeletingCellId(null)
      setBusy(false)
    }
  }

  const persistSlots = async (nextNodes: CanvasNode[]) => {
    if (!bookId || !notebook) return
    try {
      await call('move_notebook_cells', {
        book_id: bookId,
        notebook_id: notebook.id,
        slots: nextNodes.map((node) => ({
          id: node.id,
          row: node.data.slot.row,
          column: node.data.slot.column,
        })),
      })
      await refreshNotebook(bookId, notebook.id)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await refreshNotebook(bookId, notebook.id).catch(() => undefined)
      setNotice(message, 'error')
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
        target_input: notebookConnectionTargetInput(notebook, connection),
      })
      await refreshNotebook(bookId, notebook.id)
      setNotice('Cells connected')
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : String(error),
        'error',
      )
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
      setNotice(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  const clearSelectedCellSlot = async () => {
    if (!bookId || !notebook || !selectedNotebookCell) return
    const cellId = selectedNotebookCell.id
    setMediaSlotOperation(cellId, 'clear')
    try {
      await call('clear_notebook_cell_slot', {
        book_id: bookId,
        notebook_id: notebook.id,
        cell_id: cellId,
      })
      if (fullscreenCellId === cellId) setFullscreenCellId(null)
      await refreshNotebook(bookId, notebook.id)
      setMediaSlotOperation(cellId, null)
      setNotice('Cell slot cleared')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setMediaSlotError(cellId, message)
      setNotice(message, 'error')
    }
  }

  const uploadMediaSlotFile = async (cellId: string, file: File) => {
    if (!bookId || !notebook) return
    const cell = notebook.cells.find((candidate) => candidate.id === cellId)
    const kind = cell && passiveMediaKind(cell.type)
    if (!cell || !kind) return
    if (
      cell.outputArtifactId
      || notebook.edges.some((edge) => edge.target === cellId)
    ) {
      setMediaSlotError(cellId, 'Clear this slot before attaching different media.')
      return
    }
    const fileKind = mediaKindForFile(file)
    if (fileKind !== kind) {
      setMediaSlotError(cellId, `Choose one ${kind} file for this slot.`)
      return
    }

    setMediaSlotOperation(cellId, 'upload')
    try {
      const objectHash = await fileObjectHash(file)
      const duplicateValue = record(await call('check_duplicate_bytes', {
        book_id: bookId,
        object_hash: objectHash,
      }))
      const matches = Array.isArray(duplicateValue?.matches)
        ? duplicateValue.matches
        : []
      const duplicate = matches
        .map((value) => record(value))
        .find((value) => {
          const duplicateKind = value && asString(value.kind)
          return duplicateKind !== null && isCompatibleLibraryAsset(kind, duplicateKind)
        })
      let artifactRef = duplicate && asString(duplicate.slug)
      const reusedExisting = Boolean(artifactRef)

      if (!artifactRef) {
        const response = await fetch(
          `/api/books/${encodeURIComponent(bookId)}/upload?filename=${encodeURIComponent(file.name)}`,
          { method: 'POST', body: file },
        )
        const payload = record(await response.json())
        if (!response.ok) {
          throw new Error(asString(payload?.error) ?? `Upload failed: ${file.name}`)
        }
        artifactRef = asString(payload?.assetId)
        if (!artifactRef) throw new Error('Upload did not return an asset slug')
      }

      await call('set_notebook_media_slot', {
        book_id: bookId,
        notebook_id: notebook.id,
        cell_id: cellId,
        artifact_ref: artifactRef,
      })
      await refreshBookData(bookId, notebook.id)
      setMediaSlotOperation(cellId, null)
      setNotice(reusedExisting
        ? `Reused @${artifactRef} in media slot`
        : `Uploaded and attached @${artifactRef}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setMediaSlotError(cellId, message)
      setNotice(message, 'error')
    }
  }

  const closeMediaLibrary = () => {
    mediaLibraryRequestRef.current += 1
    void releaseSearchReference(mediaLibraryPicker?.reference ?? null)
    setMediaLibraryPicker(null)
    const opener = mediaLibraryOpenerRef.current
    mediaLibraryOpenerRef.current = null
    if (opener?.isConnected) window.setTimeout(() => opener.focus(), 0)
  }

  const loadMediaLibrary = async (
    cellId: string,
    query: string,
    offset: number,
    append: boolean,
    criteria?: MediaLibrarySearchCriteria,
  ) => {
    const cell = notebook?.cells.find((candidate) => candidate.id === cellId)
    const kind = cell && passiveMediaKind(cell.type)
    if (!kind) return
    const activeCriteria = criteria
      ?? (mediaLibraryPicker?.cellId === cellId
        ? {
            mode: mediaLibraryPicker.mode,
            reference: mediaLibraryPicker.reference,
            referenceStartSeconds: mediaLibraryPicker.referenceStartSeconds,
            referenceDurationSeconds: mediaLibraryPicker.referenceDurationSeconds,
          }
        : {
            mode: 'text' as const,
            reference: null,
            referenceStartSeconds: '0',
            referenceDurationSeconds: '',
          })
    const requestId = mediaLibraryRequestRef.current + 1
    mediaLibraryRequestRef.current = requestId
    setMediaLibraryPicker((current) => {
      if (!current || current.cellId !== cellId) return current
      return {
        ...current,
        query,
        assets: append ? current.assets : [],
        page: append ? current.page : emptyLibraryPage,
        booksWithErrors: append ? current.booksWithErrors : [],
        loading: !append,
        loadingMore: append,
        error: null,
      }
    })
    try {
      const result = asLibrarySearchResult(await call('search_library_assets', {
        ...(activeCriteria.mode === 'text' && query.trim()
          ? { query: query.trim() }
          : {}),
        ...(activeCriteria.mode !== 'text' && activeCriteria.reference
          ? { reference_id: activeCriteria.reference.referenceId }
          : {}),
        ...(activeCriteria.mode === 'video-reverse' && activeCriteria.reference
          ? {
              reference_range: searchReferenceRange(
                activeCriteria.referenceStartSeconds,
                activeCriteria.referenceDurationSeconds,
                activeCriteria.reference,
              ),
            }
          : {}),
        kinds: [kind],
        limit: emptyLibraryPage.limit,
        offset,
      }))
      if (mediaLibraryRequestRef.current !== requestId) return
      setMediaLibraryPicker((current) => {
        if (!current || current.cellId !== cellId) return current
        const compatible = result.assets.filter((asset) =>
          isCompatibleLibraryAsset(kind, asset.type))
        const combined = append ? [...current.assets, ...compatible] : compatible
        const unique = new Map(combined.map((asset) => [
          `${asset.owningBookId}:${asset.artifactId}`,
          asset,
        ]))
        return {
          ...current,
          assets: [...unique.values()],
          page: result.page,
          booksWithErrors: result.booksWithErrors,
          loading: false,
          loadingMore: false,
        }
      })
    } catch (error) {
      if (mediaLibraryRequestRef.current !== requestId) return
      const message = error instanceof Error ? error.message : String(error)
      setMediaLibraryPicker((current) =>
        current && current.cellId === cellId
          ? {
              ...current,
              loading: false,
              loadingMore: false,
              error: message,
            }
          : current)
      setNotice(message, 'error')
    }
  }

  const openMediaLibrary = (cellId: string) => {
    if (!notebook) return
    const cell = notebook.cells.find((candidate) => candidate.id === cellId)
    const kind = cell && passiveMediaKind(cell.type)
    if (
      !cell
      || !kind
      || cell.outputArtifactId
      || notebook.edges.some((edge) => edge.target === cellId)
    ) return
    mediaLibraryOpenerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    setMediaSlotOperation(cellId, null)
    setMediaLibraryPicker({
      cellId,
      mode: 'text',
      query: '',
      draftQuery: '',
      reference: null,
      referenceStartSeconds: '0',
      referenceDurationSeconds: '',
      preparingReference: false,
      assets: [],
      page: emptyLibraryPage,
      booksWithErrors: [],
      loading: true,
      loadingMore: false,
      error: null,
      activeArtifactId: null,
    })
    void loadMediaLibrary(cellId, '', 0, false, {
      mode: 'text',
      reference: null,
      referenceStartSeconds: '0',
      referenceDurationSeconds: '',
    })
  }

  const attachLibraryAsset = async (asset: LibraryAssetRecord) => {
    if (!bookId || !notebook || !mediaLibraryPicker) return
    const cellId = mediaLibraryPicker.cellId
    const cell = notebook.cells.find((candidate) => candidate.id === cellId)
    const kind = cell && passiveMediaKind(cell.type)
    if (!cell || !kind || !isCompatibleLibraryAsset(kind, asset.type)) return
    setMediaSlotOperation(cellId, 'attach')
    setMediaLibraryPicker((current) =>
      current && current.cellId === cellId
        ? { ...current, activeArtifactId: asset.artifactId, error: null }
        : current)
    try {
      if (asset.owningBookId === bookId) {
        await call('set_notebook_media_slot', {
          book_id: bookId,
          notebook_id: notebook.id,
          cell_id: cellId,
          artifact_ref: asset.artifactId,
        })
      } else {
        await call('attach_library_asset', {
          source_book_id: asset.owningBookId,
          source_artifact_id: asset.artifactId,
          target_book_id: bookId,
          notebook_id: notebook.id,
          cell_id: cellId,
          expected_output_artifact_id: cell.outputArtifactId ?? null,
        })
      }
      await refreshBookData(bookId, notebook.id)
      setMediaSlotOperation(cellId, null)
      setNotice(asset.owningBookId === bookId
        ? `Attached @${asset.id}`
        : `Copied and attached @${asset.id} from ${asset.owningBookSlug}`)
      closeMediaLibrary()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setMediaSlotError(cellId, message)
      setMediaLibraryPicker((current) =>
        current && current.cellId === cellId
          ? { ...current, activeArtifactId: null, error: message }
          : current)
      setNotice(message, 'error')
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
      setNotice(error instanceof Error ? error.message : String(error), 'error')
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
      setNotice(error instanceof Error ? error.message : String(error), 'error')
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
      setNotice(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  const stopRecording = () => {
    const recorder = recorderRef.current
    if (!recorder || recorder.state === 'inactive') return
    recorder.stop()
    setRecording(false)
    setNotice('Saving microphone recording…')
  }

  const waitForIngestProcessing = useCallback(async (
    targetBookId: string,
    artifactId: string,
    jobId: number,
  ): Promise<IngestStatus | null> => {
    const deadline = Date.now() + ingestPollTimeoutMs
    let quietPolls = 0
    let failedPolls = 0
    let lastError: unknown = null
    while (Date.now() < deadline) {
      try {
        const fetchedAt = performance.now()
        const [jobValue, ingestValue] = await Promise.all([
          call('list_jobs', { book_id: targetBookId, limit: 200 }, { background: true }),
          call('list_ingest_status', { book_id: targetBookId, limit: 200 }, { background: true }),
        ])
        const nextJobs = asJobs(jobValue)
        const nextStatuses = asIngestStatuses(ingestValue)
        const job = nextJobs.find((candidate) => candidate.id === jobId)
        const status = nextStatuses.find((candidate) =>
          candidate.artifactId === artifactId) ?? null
        const active = nextJobs.some((candidate) =>
          candidate.artifactId === artifactId
          && activeJobStates.has(candidate.state))
        if (fetchedAt >= watchSnapshotClockRef.current) {
          watchSnapshotClockRef.current = fetchedAt
          applyJobsSnapshot(nextJobs)
          setIngestStatuses((current) =>
            jsonEqual(current, nextStatuses) ? current : nextStatuses)
        }
        failedPolls = 0
        if (job?.state === 'failed' || job?.state === 'aborted') {
          const error = new Error(
            job.error?.message ?? `Processing job ${job.id} ${job.state}`,
          )
          error.name = 'ProcessingJobError'
          throw error
        }
        if (status?.state === 'ready') return status
        if (job?.state === 'done' && !active) {
          quietPolls += 1
          if (quietPolls >= 2) return status
        } else {
          quietPolls = 0
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'ProcessingJobError') {
          throw error
        }
        lastError = error
        failedPolls += 1
        if (failedPolls >= 5) throw error
      }
      await delay(ingestPollIntervalMs)
    }
    if (lastError instanceof Error) throw lastError
    throw new Error('Processing did not finish within five minutes')
  }, [applyJobsSnapshot, call])

  const retryIngest = async (artifactId: string) => {
    if (!bookId) return
    setBusy(true)
    setProcessingArtifactId(artifactId)
    try {
      const result = record(await call('retry_ingest', {
        book_id: bookId,
        artifact_id: artifactId,
      }))
      const jobId = asNumber(result?.jobId)
      if (!jobId) throw new Error('The server did not return a processing job')
      setNotice('Processing media…')
      const status = await waitForIngestProcessing(bookId, artifactId, jobId)
      const missing = status?.missingOutputs ?? []
      setNotice(missing.length > 0
        ? `Processing finished; ${missing.join(', ')} not indexed`
        : 'Processing complete')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      try {
        await refreshBookData(bookId, notebook?.id)
      } catch {
        void 0
      }
      setProcessingArtifactId(null)
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
      setNotice(error instanceof Error ? error.message : String(error), 'error')
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
      setNotice(error instanceof Error ? error.message : String(error), 'error')
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
        setPendingChatAction(null)
        setPendingCommandPlan({ plan: asCommandPlan(value), previews: {} })
        setNotice(action === 'retry'
          ? 'Retry plan ready for review'
          : 'Provider/model switch ready for review')
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error), 'error')
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
        setNotice(
          asString(result.message) ?? 'The sequence changed; review a new destination',
          'error',
        )
        await refreshBookData(bookId, notebook.id)
        return
      }
      const outcome = await previewCommandPlan(asCommandPlan(value))
      setNotice(outcome.message, outcome.ok ? 'info' : 'error')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error), 'error')
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
      setNotice('Audio notebook spine set')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error), 'error')
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
      setNotice(error instanceof Error ? error.message : String(error), 'error')
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
      setNotice(error instanceof Error ? error.message : String(error), 'error')
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
      setNotice(error instanceof Error ? error.message : String(error), 'error')
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
      setNotice(error instanceof Error ? error.message : String(error), 'error')
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
      setNotice(error instanceof Error ? error.message : String(error), 'error')
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
      setNotice(
        'Timeline selection requires whole, non-negative frame values',
        'error',
      )
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
      setNotice(error instanceof Error ? error.message : String(error), 'error')
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
      setNotice(error instanceof Error ? error.message : String(error), 'error')
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
      setNotice(error instanceof Error ? error.message : String(error), 'error')
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
      setPendingChatAction(null)
      setPendingCommandPlan({ plan, previews })
      const conflictCount = Object.values(previews)
        .reduce((count, preview) => count + preview.conflicts.length, 0)
      return conflictCount > 0
        ? { ok: false, message: `Plan requires review: ${conflictCount} conflicts` }
        : applyReadyOutcome('Plan preview ready')
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
    setNotice(outcome.message, outcome.ok ? 'info' : 'error')
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

  const applyPendingCommandPlan = async (): Promise<ComposerOutcome> => {
    if (!bookId || !pendingCommandPlan) {
      return { ok: false, message: 'There is no pending command plan.' }
    }
    const pending = pendingCommandPlan
    setBusy(true)
    try {
      const workbookStage = pending.plan.stages.find((stage) =>
        stage.kind === 'queued' && stage.input.workbook_run === true)
      if (workbookStage?.kind === 'queued') {
        const hasCloudStages = pending.plan.stages.some((stage) =>
          stage.kind === 'queued' && stage.jobType === 'generation')
        if (hasCloudStages && !online) {
          throw new Error('Offline: cloud generation is unavailable. The workbook plan remains preserved.')
        }
        const consentKey = 'videobook.cloud-generation-consent'
        if (
          hasCloudStages
          && window.localStorage.getItem(consentKey) !== 'accepted'
        ) {
          const accepted = window.confirm(
            'Cloud generation disclosure\n\n'
            + 'Payload class: rewritten prompts, extracted first and last frames, and connected media references.\n'
            + 'The four scene audio assets remain local and replace generated sound after animation.\n\n'
            + 'Continue and remember this choice on this device?',
          )
          if (!accepted) {
            throw new Error('Workbook generation cancelled before sending data')
          }
          window.localStorage.setItem(consentKey, 'accepted')
        }
        const notebookId = asString(workbookStage.input.notebook_id)
          ?? notebook?.id
        if (!notebookId) {
          throw new Error('The workbook plan is missing its notebook')
        }
        const queued = record(await call('enqueue_notebook_run', {
          book_id: bookId,
          notebook_id: notebookId,
          plan_id: pending.plan.planId,
          actor: 'videobook-user',
          confirm_unpriced: true,
        }))
        setPendingCommandPlan(null)
        await refreshBookData(bookId, notebookId).catch(() => undefined)
        const message = asString(queued?.status) === 'completed'
          ? 'Workbook is already current'
          : 'Workbook run accepted and queued'
        setNotice(message)
        return { ok: true, message }
      }
      let latestActionId = ''
      let queuedCount = 0
      for (const stage of pending.plan.stages) {
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
          setCellRunError(cellId, null)
          const accepted = await startNotebookCellRun({
            start: () => call('run_notebook_cell', {
              book_id: bookId,
              notebook_id: notebookId,
              cell_id: cellId,
              plan: pending.plan,
              actor: 'videobook-user',
            }),
            onStarting: () => setCellQueued(cellId, true),
            onRejected: () => setCellQueued(cellId, false),
          })
          const runId = asString(record(accepted)?.run_id)
          const jobOperationId = asString(record(accepted)?.job_id)
          if (!runId || !jobOperationId) {
            setCellQueued(cellId, false)
            throw new Error('The server did not return a notebook run')
          }
          const slug = notebook?.cells.find((cell) => cell.id === cellId)?.slug
            ?? cellId.slice(0, 8)
          void watchGenerationRun({
            bookId,
            notebookId,
            cellId,
            slug,
            runId,
            jobOperationId,
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
      await refreshBookData(bookId, notebook?.id).catch(() => undefined)
      const message = queuedCount > 0
        ? `CommandPlan accepted · ${queuedCount} queued job`
        : 'CommandPlan committed to a new sequence revision'
      setNotice(message)
      return { ok: true, message }
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error)
      setNotice(message, 'error')
      const hasGeneration = pending.plan.stages.some((stage) =>
        stage.kind === 'queued' && stage.jobType === 'generation')
      if (!hasGeneration) {
        try {
          const refreshed = await prepareSequenceEdit(
            requestFromEditStage(pending.plan.stages),
            pending.plan.sourceSurface === 'system'
              ? 'ui'
              : pending.plan.sourceSurface,
          )
          if (!refreshed.ok) {
            message = refreshed.message
            setNotice(message, 'error')
          }
        } catch {
          setPendingCommandPlan(null)
          message = 'The sequence changed. Recreate this plan against the current cut.'
          setNotice(message, 'error')
        }
      }
      return {
        ok: false,
        message,
        ...(hasGeneration
          ? { nextInput: '/apply', selectInput: true }
          : {}),
      }
    } finally {
      setBusy(false)
      focusCommandComposer()
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
      setNotice(error instanceof Error ? error.message : String(error), 'error')
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
      focusCommandComposer()
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
      setNotice('No clip is selected at the playhead', 'error')
      return
    }
    if (action === 'split') {
      void prepareSequenceEdit({
        kind: 'split',
        clip_id: clip.clipId,
        split_frame: frame,
      }, 'ui').then((outcome) => setNotice(outcome.message, outcome.ok ? 'info' : 'error'))
      return
    }
    if (action === 'delete') {
      void prepareSequenceEdit({
        kind: 'delete',
        clip_id: clip.clipId,
        ripple: true,
      }, 'ui').then((outcome) => setNotice(outcome.message, outcome.ok ? 'info' : 'error'))
    }
  }

  const completeVideoDownload = async (
    result: unknown,
    sourceUrl: string,
  ): Promise<ComposerOutcome> => {
    if (!notebook) {
      await refreshBookData(bookId)
      return { ok: true, message: messageFor(result, 'Download queued') }
    }
    const cell = downloadVideoCellInput(
      result,
      sourceUrl,
      nextNotebookGridSlot(nodes),
      notebook.cells,
    )
    let createdCellId: string
    try {
      const created = record(await call('create_notebook_cell', {
        book_id: bookId,
        notebook_id: notebook.id,
        cell,
      }))
      const nextCellId = asString(created?.id)
      if (!nextCellId) {
        throw new Error('The server did not return the new notebook cell')
      }
      createdCellId = nextCellId
      setSelectedCellId(nextCellId)
    } catch (error) {
      await refreshBookData(bookId, notebook.id)
      const message = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        message: `Download queued in Library, but board placement failed: ${message}`,
      }
    }
    await refreshBookData(bookId, notebook.id)
    void watchDownloadedAsset({
      bookId,
      notebookId: notebook.id,
      cellId: createdCellId,
      slug: notebookGridAddress(cell.slot),
      artifactId: cell.output_artifact_id,
    })
    return {
      ok: true,
      message: messageFor(result, `Download queued as ${notebookGridTag(cell.slot)}`),
    }
  }

  const watchNotebookSplitRun = async (input: {
    actionAddress: string
    bookId: string
    notebookId: string
    outputAddresses: string[]
    run: NotebookSplitRun
    sourceAddress: string
  }) => {
    let outcome: Awaited<ReturnType<typeof watchNotebookRun>>
    try {
      outcome = await watchNotebookRun({
        bookId: input.bookId,
        notebookId: input.notebookId,
        cellId: input.run.actionCellId,
        slug: input.actionAddress.slice(1),
        runId: input.run.runId,
        jobOperationId: input.run.jobId,
        intervalMs: notebookRunPollIntervalMs,
        timeoutMs: notebookRunPollTimeoutMs,
        maxPollFailures: 10,
      })
      if (outcome.kind === 'failed') {
        setCellRunError(
          input.run.actionCellId,
          outcome.message ?? `${input.actionAddress} failed`,
        )
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setCellRunError(input.run.actionCellId, message)
      outcome = { kind: 'failed', message }
    } finally {
      setCellQueued(input.run.actionCellId, false)
    }
    if (outcome.kind === 'failed') {
      setNotice(outcome.message ?? `${input.actionAddress} failed`, 'error')
      return
    }
    if (outcome.kind === 'timeout') {
      setNotice(
        `${input.sourceAddress} is still splitting — check the Jobs screen`,
      )
      return
    }
    if (outcome.kind === 'superseded') return
    setSelectedCellId(input.run.outputs.at(-1)?.outputCellId ?? null)
    setNotice(
      `Split ${input.sourceAddress} into ${input.outputAddresses.join(' and ')}`,
    )
  }

  const executeNotebookSplitCommand = async (
    command: NotebookSplitCommand,
    currentNotebook: NotebookSnapshot,
  ): Promise<ComposerOutcome> => {
    if (!bookId || !notebook) {
      return { ok: false, message: 'Open a notebook before splitting a video.' }
    }
    let actionCellId: string | null = null
    setBusy(true)
    try {
      const assetValue = await call('list_assets', {
        book_id: bookId,
        sort: 'newest',
        limit: 200,
        include_referenced: true,
      })
      const currentAssets = asAssets(assetValue)
      const source = resolveNotebookSplitSource(
        currentNotebook,
        command.sourceReference,
      )
      const sourceAddress = notebookGridTag(source.slot)
      const sourceDuration = currentAssets.find((asset) =>
        asset.artifactId === source.outputArtifactId)?.duration
        ?? asNumber(source.inputs?.durationSeconds)
      const draft = planNotebookSplitCommand({
        command,
        document: currentNotebook,
        sourceDurationSeconds: sourceDuration ?? Number.NaN,
      })
      const actionAddress = notebookGridTag(draft.actionCell.slot)
      const outputAddresses = draft.outputs.map((output) =>
        notebookGridTag(output.outputCell.slot))
      actionCellId = draft.actionCell.id
      setAssets(currentAssets)
      applyNotebook(draft.document, currentAssets, jobs)
      revealCells(draft.createdCellIds)
      setCellRunError(actionCellId, null)
      setCellQueued(actionCellId, true)
      setSelectedCellId(draft.outputs[0].outputCell.id)
      setNotice(`Splitting ${sourceAddress} at ${draft.splitAtSeconds}s`)
      const run = await enqueueNotebookSplitCommand({
        actor: 'videobook-user',
        bookId,
        callTool: call,
        draft,
        ...(currentNotebook.revision
          ? { expectedRevision: currentNotebook.revision }
          : {}),
      })
      await refreshBookData(bookId, currentNotebook.id).catch(() => undefined)
      void watchNotebookSplitRun({
        actionAddress,
        bookId,
        notebookId: currentNotebook.id,
        outputAddresses,
        run,
        sourceAddress,
      })
      return {
        ok: true,
        message: `Splitting ${sourceAddress} into ${outputAddresses.join(' and ')}`,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (actionCellId) setCellQueued(actionCellId, false)
      await refreshBookData(bookId, notebook.id).catch(() => undefined)
      setNotice(message, 'error')
      return { ok: false, message }
    } finally {
      setBusy(false)
    }
  }

  const executeNotebookFrameCommand = async (
    command: NotebookFrameCommand,
    currentNotebook: NotebookSnapshot,
  ): Promise<ComposerOutcome> => {
    if (!bookId || !notebook) {
      return { ok: false, message: 'Open a notebook before extracting a frame.' }
    }
    let actionCellId: string | null = null
    setBusy(true)
    try {
      const source = resolveNotebookFrameSource(
        currentNotebook,
        command.sourceReference,
      )
      const sourceAddress = notebookGridTag(source.slot)
      const run = await enqueueNotebookFrameCommand({
        actor: 'videobook-user',
        bookId,
        callTool: call,
        command,
        document: currentNotebook,
        ...(currentNotebook.revision
          ? { expectedRevision: currentNotebook.revision }
          : {}),
      })
      actionCellId = run.actionCellId
      setCellRunError(actionCellId, null)
      setCellQueued(actionCellId, true)
      setSelectedCellId(run.outputCellId ?? actionCellId)
      setNotice(`Frame extraction queued for ${sourceAddress}`)
      const outcome = await watchNotebookRun({
        bookId,
        notebookId: currentNotebook.id,
        cellId: actionCellId,
        slug: notebookGridAddress(source.slot),
        runId: run.runId,
        jobOperationId: run.jobId,
        intervalMs: notebookRunPollIntervalMs,
        timeoutMs: notebookRunPollTimeoutMs,
        maxPollFailures: 1,
      })
      if (outcome.kind === 'failed') {
        throw new Error(outcome.message ?? `Frame extraction for ${sourceAddress} failed`)
      }
      if (outcome.kind === 'timeout') {
        throw new Error('Frame extraction did not finish within five minutes')
      }
      if (outcome.kind === 'superseded') {
        throw new Error(`Frame extraction for ${sourceAddress} was superseded by a newer run`)
      }
      setSelectedCellId(run.outputCellId ?? actionCellId)
      return {
        ok: true,
        message: `Extracted the ${command.frameMode} frame of ${sourceAddress}`,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (actionCellId) setCellRunError(actionCellId, message)
      setNotice(message, 'error')
      return { ok: false, message }
    } finally {
      if (actionCellId) setCellQueued(actionCellId, false)
      setBusy(false)
    }
  }

  const previewNotebookFrameCommand = async (
    command: NotebookFrameCommand,
  ): Promise<ComposerOutcome> => {
    if (!bookId || !notebook) {
      return { ok: false, message: 'Open a notebook before extracting a frame.' }
    }
    try {
      const currentNotebook = asNotebook(await call('get_notebook', {
        book_id: bookId,
        notebook_id: notebook.id,
      }))
      if (!currentNotebook) {
        throw new Error('The server returned an invalid notebook')
      }
      const source = resolveNotebookFrameSource(
        currentNotebook,
        command.sourceReference,
      )
      setPendingCommandPlan(null)
      setPendingChatAction({
        kind: 'frame',
        command,
        expectations: [{
          address: notebookGridTag(source.slot),
          cellId: source.id,
        }],
        notebookId: currentNotebook.id,
        reason: 'This request creates and runs an Extract Frame cell',
        summary: `Extract the ${command.frameMode} frame from ${notebookGridTag(source.slot)}`,
      })
      return applyReadyOutcome('Frame extraction ready to apply')
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  const previewNotebookCoordinateAction = async (
    action: NotebookCoordinateAction,
  ): Promise<ComposerOutcome> => {
    if (!bookId || !notebook) {
      return { ok: false, message: 'Open a notebook before changing its cells.' }
    }
    try {
      const currentNotebook = asNotebook(await call('get_notebook', {
        book_id: bookId,
        notebook_id: notebook.id,
      }))
      if (!currentNotebook) {
        throw new Error('The server returned an invalid notebook')
      }
      const plan = planNotebookCoordinateAction(currentNotebook, action)
      setPendingCommandPlan(null)
      setPendingChatAction({
        kind: 'notebook',
        notebookId: currentNotebook.id,
        plan,
      })
      return applyReadyOutcome('Notebook action ready to apply')
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  const previewNotebookSplitCommand = async (
    command: NotebookSplitCommand,
  ): Promise<ComposerOutcome> => {
    if (!bookId || !notebook) {
      return { ok: false, message: 'Open a notebook before splitting a video.' }
    }
    try {
      const currentNotebook = asNotebook(await call('get_notebook', {
        book_id: bookId,
        notebook_id: notebook.id,
      }))
      if (!currentNotebook) {
        throw new Error('The server returned an invalid notebook')
      }
      const source = resolveNotebookSplitSource(
        currentNotebook,
        command.sourceReference,
      )
      setPendingCommandPlan(null)
      setPendingChatAction({
        kind: 'split',
        command,
        expectations: [{
          address: notebookGridTag(source.slot),
          cellId: source.id,
        }],
        notebookId: currentNotebook.id,
        reason: 'This request creates and runs a Split Video workflow',
        summary: `Split ${notebookGridTag(source.slot)} at ${command.splitAtSeconds}s`,
      })
      return applyReadyOutcome('Video split ready to apply')
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  const previewNotebookGenerationCommand = async (
    command: NotebookChatGenerationCommand,
    options?: {
      preferredTool?: string
      reason?: string
      routedParams?: Record<string, unknown>
      summary?: string
    },
  ): Promise<ComposerOutcome> => {
    if (!bookId || !notebook) {
      return { ok: false, message: 'Open a notebook before generating media.' }
    }
    try {
      const currentNotebook = asNotebook(await call('get_notebook', {
        book_id: bookId,
        notebook_id: notebook.id,
      }))
      if (!currentNotebook) {
        throw new Error('The server returned an invalid notebook')
      }
      const draft = planNotebookChatGeneration({
        actions: generationActions,
        cellId: uuidv7(),
        command,
        document: currentNotebook,
        fallbackSlot: nextNotebookGridSlot(nodes),
        ...(options?.preferredTool
          ? { preferredTool: options.preferredTool }
          : {}),
        ...(options?.routedParams
          ? { routedParams: options.routedParams }
          : {}),
      })
      const references = draft.sourceCellIds.length > 0
        ? ` from ${draft.sourceCellIds.flatMap((cellId) => {
            const cell = currentNotebook.cells.find((candidate) => candidate.id === cellId)
            return cell ? [notebookGridTag(cell.slot)] : []
          }).join(', ')}`
        : ''
      setPendingCommandPlan(null)
      setPendingChatAction({
        kind: 'generation',
        draft,
        notebookId: currentNotebook.id,
        preview: null,
        previewError: null,
        previewLoading: true,
        previewStale: false,
        expectations: [
          ...draft.sourceCellIds.flatMap((cellId) => {
            const cell = currentNotebook.cells.find((candidate) => candidate.id === cellId)
            return cell
              ? [{ address: notebookGridTag(cell.slot), cellId: cell.id }]
              : []
          }),
          {
            address: notebookGridTag(draft.cell.slot),
            cellId: null,
          },
        ],
        reason: options?.reason
          ?? 'Generation can incur provider spend and sends the prompt and required references',
        summary: options?.summary
          ?? `Generate ${command.mediaKind} as ${notebookGridTag(draft.cell.slot)}${references}`,
      })
      requestPendingGenerationPreview(draft, currentNotebook)
      return generationApplyReadyOutcome(
        `Generation ready to apply as ${notebookGridTag(draft.cell.slot)}`,
      )
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  const previewRoutedChatAction = async (
    plan: ChatActionPlan,
    originalInput: string,
  ): Promise<ComposerOutcome> => {
    if (plan.effect === 'generation') {
      const cellType = generationCellTypeForRoutedTool(
        plan.tool,
        plan.routedTool,
        generationActions,
      )
      const command: NotebookChatGenerationCommand = {
        cellType,
        mediaKind: generationMediaKind(cellType),
        prompt: asString(plan.params.prompt) ?? originalInput,
        sourceReferences: notebookChatGenerationReferences(originalInput),
      }
      return await previewNotebookGenerationCommand(command, {
        preferredTool: plan.tool,
        reason: plan.confirmation.reason,
        routedParams: plan.params,
        summary: plan.summary,
      })
    }
    setPendingCommandPlan(null)
    setPendingChatAction({ kind: 'routed', plan })
    return applyReadyOutcome('Action preview ready')
  }

  const showOptimisticGeneration = (
    draft: NotebookChatGenerationDraft,
    document: NotebookDocument,
  ) => {
    const optimistic = canvasNodes({
      ...document,
      cells: [draft.cell],
      edges: [],
    }, assets, jobs)[0]
    if (!optimistic) return
    const startedAt = new Date().toISOString()
    setNodes((current) => current.some((node) => node.id === optimistic.id)
      ? current.map((node) => node.id === optimistic.id
          ? {
              ...optimistic,
              data: { ...optimistic.data, status: 'queued', statusStartedAt: startedAt },
            }
          : node)
      : [...current, {
          ...optimistic,
          data: { ...optimistic.data, status: 'queued', statusStartedAt: startedAt },
        }])
  }

  const applyPendingGenerationAction = async (
    action: Extract<PendingChatAction, { kind: 'generation' }>,
    promptOverride: string | null = null,
  ): Promise<ComposerOutcome> => {
    const preparedAction = promptOverride
      ? {
          ...action,
          draft: reviseNotebookChatGenerationPrompt(action.draft, promptOverride),
        }
      : action
    const retryInput = promptOverride ? `/apply ${promptOverride}` : '/apply '
    if (!preparedAction.draft.cell.prompt?.trim()) {
      return {
        ok: false,
        message: 'Enter a generation prompt before applying.',
        nextInput: retryInput,
        selectInput: false,
      }
    }
    if (!bookId || !notebook || notebook.id !== preparedAction.notebookId) {
      return { ok: false, message: 'The generation draft belongs to another notebook.' }
    }
    let currentNotebook: NotebookSnapshot
    try {
      const value = asNotebook(await call('get_notebook', {
        book_id: bookId,
        notebook_id: preparedAction.notebookId,
      }))
      if (!value) throw new Error('The server returned an invalid notebook')
      currentNotebook = value
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        nextInput: retryInput,
        selectInput: false,
      }
    }
    if (notebookAddressExpectationsAreStale(
      currentNotebook,
      preparedAction.expectations,
    )) {
      setPendingChatAction(null)
      return {
        ok: false,
        message: 'Notebook changed since this preview; prepare the action again.',
      }
    }
    if (!online) {
      return {
        ok: false,
        message: 'Offline: cloud generation is unavailable.',
        nextInput: retryInput,
        selectInput: false,
      }
    }
    if (promptOverride) {
      setPendingChatAction((current) => current === action
        ? {
            ...preparedAction,
            previewLoading: false,
            previewStale: true,
          }
        : current)
    }
    const consentKey = 'videobook.cloud-generation-consent'
    if (window.localStorage.getItem(consentKey) !== 'accepted') {
      const accepted = window.confirm(
        `Cloud generation disclosure\n\nProvider/model: ${preparedAction.draft.action.provider} · ${preparedAction.draft.action.model}\n`
        + 'Payload class: prompt text and connected media references.\n'
        + 'Your local source files are sent only when required by the selected model.\n\n'
        + 'Continue and remember this choice on this device?',
      )
      if (!accepted) {
        return {
          ok: false,
          message: 'Cloud generation cancelled before sending data',
          nextInput: retryInput,
          selectInput: false,
        }
      }
      window.localStorage.setItem(consentKey, 'accepted')
    }
    const cellId = preparedAction.draft.cell.id
    const cellAddress = notebookGridTag(preparedAction.draft.cell.slot)
    let materialized = false
    let runAccepted = false
    setBusy(true)
    setCellRunError(cellId, null)
    setCellQueued(cellId, true)
    setSelectedCellId(cellId)
    showOptimisticGeneration(preparedAction.draft, currentNotebook)
    try {
      await materializeNotebookChatGeneration({
        bookId,
        callTool: call,
        document: currentNotebook,
        draft: preparedAction.draft,
        ...(currentNotebook.revision
          ? { expectedRevision: currentNotebook.revision }
          : {}),
      })
      materialized = true
      const plan = await createGenerationPlan(cellId, 'chat')
      const accepted = await call('run_notebook_cell', {
        book_id: bookId,
        notebook_id: currentNotebook.id,
        cell_id: cellId,
        plan,
        actor: 'videobook-user',
      })
      runAccepted = true
      const runId = asString(record(accepted)?.run_id)
      const jobOperationId = asString(record(accepted)?.job_id)
      setPendingChatAction(null)
      if (!runId || !jobOperationId) {
        setCellQueued(cellId, false)
        await refreshBookData(bookId, currentNotebook.id).catch(() => undefined)
        return {
          ok: true,
          message: `${cellAddress} was accepted; follow its status in Jobs`,
        }
      }
      setNotice(`${cellAddress} queued`)
      void watchGenerationRun({
        bookId,
        notebookId: currentNotebook.id,
        cellId,
        slug: notebookGridAddress(preparedAction.draft.cell.slot),
        runId,
        jobOperationId,
      })
      await refreshBookData(bookId, currentNotebook.id).catch(() => undefined)
      return { ok: true, message: `${cellAddress} queued` }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const stale = message.startsWith('Stale notebook revision:')
      if (materialized && !runAccepted) {
        await call('delete_notebook_cell', {
          book_id: bookId,
          notebook_id: currentNotebook.id,
          cell_id: cellId,
        }).catch(() => undefined)
      }
      if (!runAccepted) {
        setNodes((current) => current.filter((node) => node.id !== cellId))
        setCellQueued(cellId, false)
      }
      setCellRunError(cellId, message)
      await refreshBookData(bookId, currentNotebook.id).catch(() => undefined)
      if (stale) {
        setPendingChatAction(null)
        setNotice('Notebook changed since this preview; prepare the action again.', 'error')
        return {
          ok: false,
          message: 'Notebook changed since this preview; prepare the action again.',
        }
      }
      setNotice(message, 'error')
      return {
        ok: false,
        message,
        nextInput: retryInput,
        selectInput: false,
      }
    } finally {
      setBusy(false)
    }
  }

  const applyPendingChatAction = async (
    promptOverride: string | null = null,
  ): Promise<ComposerOutcome> => {
    if (!pendingChatAction || !bookId) {
      return { ok: false, message: 'There is no pending chat action.' }
    }
    if (pendingChatAction.kind === 'generation') {
      return await applyPendingGenerationAction(pendingChatAction, promptOverride)
    }
    if (
      pendingChatAction.kind === 'frame'
      || pendingChatAction.kind === 'split'
      || pendingChatAction.kind === 'notebook'
    ) {
      const currentNotebook = asNotebook(await call('get_notebook', {
        book_id: bookId,
        notebook_id: pendingChatAction.notebookId,
      }))
      if (!currentNotebook) {
        return { ok: false, message: 'The server returned an invalid notebook' }
      }
      const expectations = pendingChatAction.kind === 'notebook'
        ? pendingChatAction.plan.expectations
        : pendingChatAction.expectations
      if (notebookAddressExpectationsAreStale(currentNotebook, expectations)) {
        setPendingChatAction(null)
        return {
          ok: false,
          message: 'Notebook changed since this preview; prepare the action again.',
        }
      }
      if (pendingChatAction.kind === 'frame') {
        const outcome = await executeNotebookFrameCommand(
          pendingChatAction.command,
          currentNotebook,
        )
        if (outcome.ok) {
          setPendingChatAction(null)
        } else if (outcome.message.startsWith('Stale notebook revision:')) {
          setPendingChatAction(null)
          return {
            ok: false,
            message: 'Notebook changed since this preview; prepare the action again.',
          }
        }
        return outcome
      }
      if (pendingChatAction.kind === 'split') {
        const outcome = await executeNotebookSplitCommand(
          pendingChatAction.command,
          currentNotebook,
        )
        if (outcome.ok) {
          setPendingChatAction(null)
        } else if (outcome.message.startsWith('Stale notebook revision:')) {
          setPendingChatAction(null)
          return {
            ok: false,
            message: 'Notebook changed since this preview; prepare the action again.',
          }
        }
        return outcome
      }
      const action = pendingChatAction.plan.action
      if (action.kind === 'run') {
        const cell = notebookCellAtSlot(currentNotebook, action.source)!
        const outcome = await runCell(cell.id, currentNotebook)
        if (!outcome?.ok) {
          if (outcome?.message.startsWith('Stale notebook revision:')) {
            setPendingChatAction(null)
            return {
              ok: false,
              message: 'Notebook changed since this preview; prepare the action again.',
            }
          }
          return outcome ?? {
            ok: false,
            message: `Could not run ${notebookGridTag(cell.slot)}`,
          }
        }
        setPendingChatAction(null)
        return {
          ok: true,
          message: `Run requested for ${notebookGridTag(cell.slot)}`,
        }
      }
      setBusy(true)
      try {
        const revisionInput = currentNotebook.revision
          ? { expected_revision: currentNotebook.revision }
          : {}
        if (action.kind === 'create') {
          const destination = action.destination!
          const slug = nextNotebookCellSlug(action.cellType, currentNotebook.cells)
          const created = record(await call('create_notebook_cell', {
            book_id: bookId,
            notebook_id: currentNotebook.id,
            ...revisionInput,
            cell: {
              type: action.cellType,
              slug,
              slot: destination,
              ...(action.cellType === 'prompt'
                || action.cellType === 'analyze'
                || action.cellType === 'generate_video'
                || action.cellType === 'generate_image'
                || action.cellType === 'generate_audio'
                ? { prompt: '' }
                : {}),
            },
          }))
          const cellId = asString(created?.id)
          if (cellId) setSelectedCellId(cellId)
        } else if (action.kind === 'move') {
          const source = notebookCellAtSlot(currentNotebook, action.source)!
          const target = notebookCellAtSlot(currentNotebook, action.destination)
          await call('move_notebook_cells', {
            book_id: bookId,
            notebook_id: currentNotebook.id,
            ...revisionInput,
            slots: [
              {
                id: source.id,
                row: action.destination.row,
                column: action.destination.column,
              },
              ...(target
                ? [{
                    id: target.id,
                    row: action.source.row,
                    column: action.source.column,
                  }]
                : []),
            ],
          })
        } else if (action.kind === 'delete') {
          const cell = notebookCellAtSlot(currentNotebook, action.source)!
          await call('delete_notebook_cell', {
            book_id: bookId,
            notebook_id: currentNotebook.id,
            cell_id: cell.id,
            ...revisionInput,
          })
        } else if (action.kind === 'clear') {
          const cell = notebookCellAtSlot(currentNotebook, action.source)!
          await call('clear_notebook_cell_slot', {
            book_id: bookId,
            notebook_id: currentNotebook.id,
            cell_id: cell.id,
            ...revisionInput,
          })
        } else if (action.kind === 'connect') {
          const source = notebookCellAtSlot(currentNotebook, action.source)!
          const target = notebookCellAtSlot(currentNotebook, action.target)!
          const targetInput = action.targetInput ?? notebookConnectionTargetInput(
            currentNotebook,
            {
              source: source.id,
              target: target.id,
              targetHandle: null,
            },
          )
          await call('set_notebook_cell_input', {
            book_id: bookId,
            notebook_id: currentNotebook.id,
            source_cell_id: source.id,
            target_cell_id: target.id,
            target_input: targetInput,
            ...revisionInput,
          })
        } else {
          throw new Error('Unsupported notebook action')
        }
        setPendingChatAction(null)
        await refreshBookData(bookId, currentNotebook.id)
        setNotice(pendingChatAction.plan.summary)
        return { ok: true, message: pendingChatAction.plan.summary }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.startsWith('Stale notebook revision:')) {
          setPendingChatAction(null)
          setNotice('Notebook changed since this preview; prepare the action again.', 'error')
          return {
            ok: false,
            message: 'Notebook changed since this preview; prepare the action again.',
          }
        }
        setNotice(message, 'error')
        return { ok: false, message, nextInput: '/apply', selectInput: true }
      } finally {
        setBusy(false)
      }
    }
    setBusy(true)
    try {
      const result = await call('chat', {
        book_id: bookId,
        action_plan: pendingChatAction.plan,
      })
      const outcome = isDownloadVideoResult(result)
        ? await completeVideoDownload(
            result,
            urlFromText(pendingChatAction.plan.prompt),
          )
        : {
            ok: true,
            message: messageFor(result, pendingChatAction.plan.message || 'Action applied'),
          }
      if (outcome.ok) {
        setPendingChatAction(null)
        await refreshBookData(bookId, notebook?.id)
        setNotice(outcome.message, outcome.ok ? 'info' : 'error')
      }
      return outcome
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setNotice(message, 'error')
      return {
        ok: false,
        message,
        nextInput: '/apply',
        selectInput: true,
      }
    } finally {
      setBusy(false)
    }
  }

  const executeCommand = async (input: string): Promise<ComposerOutcome> => {
    try {
      const normalizedInput = input.trim().toLowerCase()
      const applyCommand = parsePendingApplyCommand(input)
      if (applyCommand) {
        if (applyCommand.promptOverride && pendingChatAction?.kind !== 'generation') {
          return {
            ok: false,
            message: 'A quick prompt can only revise a pending generation.',
            nextInput: input,
            selectInput: false,
          }
        }
        if (pendingChatAction) {
          return await applyPendingChatAction(applyCommand.promptOverride)
        }
        if (pendingCommandPlan) return await applyPendingCommandPlan()
        return { ok: false, message: 'There is no pending action to apply.' }
      }
      if (normalizedInput === '/cancel') {
        if (!pendingChatAction && !pendingCommandPlan) {
          return { ok: false, message: 'There is no pending action to cancel.' }
        }
        setPendingChatAction(null)
        setPendingCommandPlan(null)
        return { ok: true, message: 'Pending action cancelled' }
      }
      if (!bookId) return { ok: false, message: 'Load or create a book first.' }
      const notebookAction = parseNotebookCoordinateAction(input)
      if (notebookAction) {
        return await previewNotebookCoordinateAction(notebookAction)
      }
      const splitCommand = parseNotebookSplitCommand(input)
      if (splitCommand) {
        return await previewNotebookSplitCommand(splitCommand)
      }
      const resolvedAssetInput = resolveNotebookMentionAliases(
        input,
        commandMentionAssets,
      )
      if (!input.startsWith('/')) {
        const frameCommand = parseNotebookFrameCommand(input)
        if (frameCommand) {
          return await previewNotebookFrameCommand(frameCommand)
        }
        const generationCommand = parseNotebookChatGenerationCommand(input)
        if (generationCommand) {
          return await previewNotebookGenerationCommand(generationCommand)
        }
        const generationCellReference = parseNotebookGenerationCellCommand(input)
        if (generationCellReference && notebook) {
          const cell = notebook.cells.find((candidate) =>
            candidate.id.toLowerCase().startsWith(generationCellReference)
            || candidate.slug === generationCellReference)
          if (
            !cell
            || !isGenerationCell(cell)
          ) {
            return {
              ok: false,
              message: 'Name a configured generation cell, for example: generate cell @cell-id',
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
        const routed = await call('chat', {
          book_id: bookId,
          prompt: resolvedAssetInput,
          model: chatModel,
        })
        const routedRecord = record(routed)
        if (routedRecord?.kind === 'chat-action-plan') {
          return await previewRoutedChatAction(
            asChatActionPlan(routed),
            input,
          )
        }
        setPendingChatAction(null)
        setPendingCommandPlan(null)
        if (isDownloadVideoResult(routed)) {
          return await completeVideoDownload(routed, urlFromText(input))
        }
        await refreshBookData(bookId, notebook?.id)
        return {
          ok: true,
          message: messageFor(routed, 'Command complete'),
        }
      }
      const [commandToken, ...restParts] = input.trim().split(/\s+/)
      const rest = restParts.join(' ')
      const resolvedRest = resolveNotebookMentionAliases(
        rest,
        commandMentionAssets,
      )
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
        if (
          !cell
          || !isGenerationCell(cell)
        ) {
          return { ok: false, message: 'Choose a configured generation cell' }
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
      if (commandToken === '/split-clip') {
        const [clipValue, frameValue] = restParts
        const clip = sequenceClipReference(sequence, clipValue)
        const splitFrame = Number(frameValue)
        if (!clip || !Number.isSafeInteger(splitFrame)) {
          return { ok: false, message: 'Usage: /split-clip @clip-id <sequence-frame>' }
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
          const mentionAsset = commandMentionAssets.find((candidate) =>
            candidate.cellAddress.toLowerCase() === source?.toLowerCase())
          const asset = mentionAsset ?? assets.find((candidate) =>
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
      const command = selectCommandForInput(commands, commandToken, resolvedRest)
      if (!command) return { ok: false, message: `Unknown command: ${commandToken}` }
      if (command.uiAction === 'switch_book') {
        const slug = command.command.slice(1)
        const target = books.find((book) => book.slug === slug)
        if (!target) return { ok: false, message: `Book not found: ${slug}` }
        const result = await chooseBook(target.bookId)
        return result.ok
          ? { ok: true, message: `Opened ${slug}` }
          : { ok: false, message: result.error }
      }
      if (command.uiAction === 'open_projects') {
        const result = await openBookMenu()
        return result.ok
          ? { ok: true, message: 'Project selector opened' }
          : { ok: false, message: result.error }
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
      if (command.mcpTool.tool === 'download_video' && !notebook) {
        return { ok: false, message: 'Open a notebook before downloading media.' }
      }
      const parsed = parseCommandArgs(resolvedRest, command.params)
      const renameAssetId = command.mcpTool.tool === 'rename_asset'
        ? parseCommandArgs(rest, command.params).asset_id
        : undefined
      const adapted = adaptCommandArgs(command.mcpTool.adapter, command.mcpTool.tool, parsed)
      const args: CommandToolArgs = {
        ...adapted,
        ...(command.mcpTool.injectParams ?? {}),
      }
      if (command.mcpTool.autoInject?.includes('book_id')) args.book_id = bookId
      const result = await call(command.mcpTool.tool, args)
      if (command.mcpTool.tool === 'download_video' && notebook) {
        return await completeVideoDownload(result, asString(args.url) ?? '')
      }
      const renamePlan = command.mcpTool.tool === 'rename_asset' && notebook
        ? notebookCellRenamePlan(
            renameAssetId,
            result,
            notebook.cells,
            commandMentionAssets,
          )
        : null
      if (
        renamePlan
        && notebook
        && !renamePlan.conflict
        && renamePlan.previousSlug !== renamePlan.nextSlug
      ) {
        await call('update_notebook_cell', {
          book_id: bookId,
          notebook_id: notebook.id,
          cell_id: renamePlan.cellId,
          cell: { slug: renamePlan.nextSlug },
        })
      }
      await refreshBookData(bookId, notebook?.id)
      if (command.mcpTool.tool === 'rename_asset') {
        const renamed = record(result)
        const oldAssetId = asString(renamed?.old_asset_id)
        const newAssetId = asString(renamed?.new_asset_id)
        if (oldAssetId && newAssetId) {
          if (renamePlan?.conflict) {
            return {
              ok: true,
              message: `Renamed asset @${oldAssetId} to @${newAssetId}; cell @${renamePlan.previousSlug} kept because @${newAssetId} is already in use`,
            }
          }
          return {
            ok: true,
            message: `Renamed @${renamePlan?.previousSlug ?? oldAssetId} to @${newAssetId}`,
          }
        }
      }
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
        setNotice(error instanceof Error ? error.message : String(error), 'error')
      })
    }
  }

  const mediaSlotContextValue: MediaSlotContextValue = {
    states: mediaSlotStates,
    onFile: (cellId, file) => void uploadMediaSlotFile(cellId, file),
    onFileError: setMediaSlotError,
    onOpenLibrary: openMediaLibrary,
  }
  const mediaLibraryCell = mediaLibraryPicker
    ? notebook?.cells.find((cell) => cell.id === mediaLibraryPicker.cellId)
    : undefined
  const mediaLibraryKind = mediaLibraryCell
    ? passiveMediaKind(mediaLibraryCell.type)
    : null
  const updateMediaLibraryDraft = (query: string) => {
    setMediaLibraryPicker((current) => current ? { ...current, draftQuery: query } : current)
  }
  const changeMediaLibraryMode = (mode: MediaSearchMode) => {
    if (!mediaLibraryPicker || mediaLibraryPicker.mode === mode) return
    const cellId = mediaLibraryPicker.cellId
    void releaseSearchReference(mediaLibraryPicker.reference)
    setMediaLibraryPicker((current) => current && current.cellId === cellId
      ? {
          ...current,
          mode,
          reference: null,
          referenceStartSeconds: '0',
          referenceDurationSeconds: '',
          preparingReference: false,
          page: mode === 'text'
            ? current.page
            : {
                ...emptyLibraryPage,
                total: current.assets.length,
              },
          error: null,
        }
      : current)
    if (mode === 'text') {
      void loadMediaLibrary(
        cellId,
        mediaLibraryPicker.draftQuery,
        0,
        false,
        {
          mode,
          reference: null,
          referenceStartSeconds: '0',
          referenceDurationSeconds: '',
        },
      )
    }
  }
  const prepareMediaLibraryFile = async (file: File) => {
    if (!mediaLibraryPicker || mediaLibraryPicker.mode === 'text' || !bookId) return
    const picker = mediaLibraryPicker
    const mode = picker.mode as ReverseSearchMode
    setMediaLibraryPicker((current) => current && current.cellId === picker.cellId
      ? { ...current, preparingReference: true, error: null }
      : current)
    try {
      const reference = await uploadSearchReference(
        file,
        bookId,
        referenceKind(mode),
      )
      await releaseSearchReference(picker.reference)
      const criteria: MediaLibrarySearchCriteria = {
        mode,
        reference,
        referenceStartSeconds: '0',
        referenceDurationSeconds: '',
      }
      setMediaLibraryPicker((current) => current && current.cellId === picker.cellId
        ? {
            ...current,
            ...criteria,
            preparingReference: false,
          }
        : current)
      await loadMediaLibrary(picker.cellId, '', 0, false, criteria)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setMediaLibraryPicker((current) => current && current.cellId === picker.cellId
        ? {
            ...current,
            preparingReference: false,
            error: message,
          }
        : current)
      setNotice(message, 'error')
    }
  }
  const prepareMediaLibrarySimilar = async (asset: LibraryAssetRecord) => {
    if (!mediaLibraryPicker) return
    const picker = mediaLibraryPicker
    const mode: ReverseSearchMode = asset.type === 'image'
      ? 'image-reverse'
      : 'video-reverse'
    setMediaLibraryPicker((current) => current && current.cellId === picker.cellId
      ? {
          ...current,
          mode,
          preparingReference: true,
          error: null,
        }
      : current)
    try {
      const value = await call('prepare_search_reference', {
        source_book_id: asset.owningBookId,
        source_artifact_id: asset.artifactId,
        kind: referenceKind(mode),
      })
      const reference = asSearchReferenceDescriptor(
        value,
        mode === 'image-reverse'
          ? asset.thumbnailUrl ?? asset.mediaUrl
          : asset.mediaUrl,
      )
      await releaseSearchReference(picker.reference)
      const criteria: MediaLibrarySearchCriteria = {
        mode,
        reference,
        referenceStartSeconds: '0',
        referenceDurationSeconds: '',
      }
      setMediaLibraryPicker((current) => current && current.cellId === picker.cellId
        ? {
            ...current,
            ...criteria,
            preparingReference: false,
          }
        : current)
      await loadMediaLibrary(picker.cellId, '', 0, false, criteria)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setMediaLibraryPicker((current) => current && current.cellId === picker.cellId
        ? {
            ...current,
            preparingReference: false,
            error: message,
          }
        : current)
      setNotice(message, 'error')
    }
  }
  const clearMediaLibraryReference = () => {
    if (!mediaLibraryPicker) return
    void releaseSearchReference(mediaLibraryPicker.reference)
    setMediaLibraryPicker((current) => current
      ? {
          ...current,
          reference: null,
          referenceStartSeconds: '0',
          referenceDurationSeconds: '',
          error: null,
        }
      : current)
  }
  const searchMediaLibrary = () => {
    if (!mediaLibraryPicker) return
    void loadMediaLibrary(
      mediaLibraryPicker.cellId,
      mediaLibraryPicker.draftQuery,
      0,
      false,
    )
  }
  const loadMoreMediaLibrary = () => {
    if (!mediaLibraryPicker) return
    void loadMediaLibrary(
      mediaLibraryPicker.cellId,
      mediaLibraryPicker.query,
      mediaLibraryPicker.page.offset + mediaLibraryPicker.page.limit,
      true,
    )
  }

  return (
    <main className={`app-shell app-screen-${screen} ${inspectorOpen ? 'inspector-visible' : 'inspector-hidden'} ${fullscreenCell && fullscreenNode?.data.asset ? 'media-fullscreen-open' : ''}`}>
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
              <BookProjectSelector
                activeBook={activeBook}
                books={books}
                disabled={busy || mcp.state !== 'ready'}
                error={bookMenuError}
                loading={bookMenuLoading}
                open={bookMenuOpen}
                onCreate={createBookProject}
                onDelete={deleteBookProject}
                onOpenChange={handleBookMenuOpenChange}
                onRefresh={refreshOpenBookMenu}
                onRename={renameBookProject}
                onSelect={chooseBook}
              />
            </div>
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
                {notebook && (
                  <div className="canvas-add-panel">
                    <details className="canvas-add-menu">
                      <summary><Plus size={15} />Add cell</summary>
                      <div>
                        {cellPaletteGroups.map((group) => (
                          <section key={group} className="canvas-add-group">
                            <span>{group}</span>
                            {cellPalette.filter((item) => item.group === group).map((item) => {
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
                          </section>
                        ))}
                      </div>
                    </details>
                  </div>
                )}
                {notebook && (
                  <div className="canvas-zoom-panel" aria-label="Notebook zoom controls">
                    <button
                      type="button"
                      aria-label="Zoom out"
                      disabled={notebookView.zoom <= notebookGrid.minimumZoom}
                      onClick={() => adjustNotebookZoom(-notebookGrid.zoomStep)}
                    >
                      <ZoomOut size={15} />
                    </button>
                    <button
                      type="button"
                      className="canvas-zoom-level"
                      aria-label="Reset zoom"
                      onClick={resetNotebookZoom}
                    >
                      {Math.round(notebookView.zoom * 100)}%
                    </button>
                    <button
                      type="button"
                      aria-label="Zoom in"
                      disabled={notebookView.zoom >= notebookGrid.maximumZoom}
                      onClick={() => adjustNotebookZoom(notebookGrid.zoomStep)}
                    >
                      <ZoomIn size={15} />
                    </button>
                  </div>
                )}
                {!notebook ? (
                  <div className="canvas-empty-state">
                    <strong>No notebook available</strong>
                    <button type="button" onClick={() => void loadBooks(bookId)}>Reload book</button>
                  </div>
                ) : (
                  <div
                    className="notebook-horizontal-scroll"
                    ref={notebookScrollRef}
                    tabIndex={0}
                    aria-label="Notebook canvas"
                  >
                    <div
                      className="notebook-flow-frame"
                      style={notebookFlowStyle}
                    >
                      <MediaSlotContext.Provider value={mediaSlotContextValue}>
                        <CellRunContext.Provider value={runCell}>
                          <ReactFlow<CanvasNode, NotebookFlowEdge>
                          className="notebook-flow"
                      nodes={presentedNodes}
                      edges={focusedEdges}
                      nodeTypes={nodeTypes}
                      edgeTypes={edgeTypes}
                      viewport={notebookViewport}
                      onViewportChange={updateNotebookViewport}
                      onInit={(instance) => {
                        flowRef.current = instance
                      }}
                      onNodesChange={(changes) => setNodes((current) => {
                        let next = applyNodeChanges(changes, current)
                        for (const change of changes) {
                          if (
                            change.type !== 'position'
                            || !change.dragging
                            || !change.position
                          ) continue
                          next = snapNotebookGridMove(
                            next,
                            change.id,
                            notebookGridSlot(change.position),
                          )
                        }
                        return next
                      })}
                      onEdgesChange={(changes) => {
                        setEdges((current) => applyEdgeChanges(changes, current))
                        const removed = changes.filter((change) => change.type === 'remove').map((change) => change.id)
                        if (removed.length > 0) void removeEdges(removed)
                      }}
                      onNodeClick={(_event, node) => {
                        setSelectedCellId(node.id)
                        setSourceViewCellId(null)
                        setInspectorOpen(true)
                      }}
                      onPaneClick={() => {
                        setSelectedCellId(null)
                        setSourceViewCellId(null)
                      }}
                      onNodeDrag={(_event, node) => {
                        setPreviewSlot(notebookGridSlot(node.position))
                      }}
                      onNodeDragStop={(_event, node, draggedNodes) => {
                        const nextNodes = resolveNotebookGridGroupMove(
                          nodes,
                          node.id,
                          draggedNodes.map((draggedNode) => draggedNode.id),
                          notebookGridSlot(node.position),
                        )
                        const movedNodes = changedNotebookGridNodes(nodes, nextNodes)
                        setNodes(nextNodes)
                        setPreviewSlot(null)
                        if (movedNodes.length > 0) void persistSlots(movedNodes)
                      }}
                      onConnect={(connection) => void connectCells(connection)}
                      onDrop={(event) => {
                        event.preventDefault()
                        if (event.dataTransfer.types.includes('Files')) {
                          setPreviewSlot(null)
                          return
                        }
                        const raw = event.dataTransfer.getData('application/x-videobook-cell')
                        if (!cellPalette.some((item) => item.type === raw)) return
                        const point = flowRef.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY })
                        setPreviewSlot(null)
                        void createCell(raw as NotebookCellType, point)
                      }}
                      onDragOver={(event) => {
                        event.preventDefault()
                        if (event.dataTransfer.types.includes('Files')) {
                          setPreviewSlot(null)
                          return
                        }
                        const point = flowRef.current?.screenToFlowPosition({
                          x: event.clientX,
                          y: event.clientY,
                        })
                        if (point) {
                          setPreviewSlot(notebookGridDropSlot(point, notebookBaseMetrics))
                        }
                      }}
                      minZoom={notebookGrid.minimumZoom}
                      maxZoom={notebookGrid.maximumZoom}
                      panOnDrag={notebookPanOnDragButtons}
                      selectionOnDrag
                      selectionMode={SelectionMode.Partial}
                      panOnScroll={false}
                      zoomOnScroll={false}
                      zoomOnPinch
                      zoomActivationKeyCode={notebookZoomActivationKeys}
                      zoomOnDoubleClick={false}
                      preventScrolling={false}
                      deleteKeyCode={null}
                      proOptions={flowProOptions}
                    >
                            <NotebookGridBoard
                              metrics={notebookMetrics}
                              previewSlot={previewSlot}
                            />
                          </ReactFlow>
                        </CellRunContext.Provider>
                      </MediaSlotContext.Provider>
                    </div>
                  </div>
                )}
                {notebook && nodes.length === 0 && (
                  <div className="canvas-welcome">
                    <div className="canvas-welcome-mark"><Sparkles size={22} /></div>
                    <span>EMPTY NOTEBOOK</span>
                    <strong>Build your first notebook path.</strong>
                    <p>Connect media, analysis, generation, and edit cells as the story takes shape.</p>
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
              <aside
                className={[
                  'inspector',
                  inspectorOpen ? '' : 'inspector-closed',
                  deletingCellId === selectedCell?.id ? 'inspector-deleting' : '',
                ].filter(Boolean).join(' ')}
              >
                <header>
                  {selectedCell ? (
                    <span
                      key={selectedCell.id}
                      className="inspector-cell-title"
                      title={cellTypeLabel(selectedCell.data.kind)}
                    >
                      <CellIcon kind={selectedCell.data.kind} />
                      <strong>{cellTypeLabel(selectedCell.data.kind)}</strong>
                    </span>
                  ) : (
                    <span>INSPECTOR</span>
                  )}
                  <div className="inspector-header-actions">
                    {selectedCell && (
                      <button
                        type="button"
                        className={sourceViewCellId === selectedCell.id
                          ? 'inspector-source-toggle active'
                          : 'inspector-source-toggle'}
                        title={sourceViewCellId === selectedCell.id
                          ? 'View cell'
                          : 'View source'}
                        aria-label={sourceViewCellId === selectedCell.id
                          ? 'View cell'
                          : 'View source'}
                        aria-pressed={sourceViewCellId === selectedCell.id}
                        onClick={() => setSourceViewCellId((current) =>
                          current === selectedCell.id ? null : selectedCell.id)}
                      >
                        <Braces size={15} />
                      </button>
                    )}
                    <button type="button" aria-label="Close inspector" onClick={() => setInspectorOpen(false)}>
                      <PanelRightClose size={16} />
                    </button>
                  </div>
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
                ) : selectedNotebookCell ? (
                  <NotebookCellInspector
                    key={selectedNotebookCell.id}
                    notebookId={notebook?.id ?? ''}
                    cell={selectedNotebookCell}
                    cells={notebook?.cells ?? []}
                    edges={notebook?.edges ?? []}
                    asset={selectedCell.data.asset}
                    cellAssets={notebookCellAssets}
                    versionAssets={selectedCellVersionAssets}
                    status={selectedCell.data.status}
                    error={selectedCellError}
                    generationActions={generationActions}
                    busy={busy || Boolean(selectedMediaSlotState?.operation)}
                    deleting={deletingCellId === selectedNotebookCell.id}
                    clearing={selectedMediaSlotState?.operation === 'clear'}
                    sourceVisible={sourceViewCellId === selectedNotebookCell.id}
                    onUpdate={updateCell}
                    onSetInput={setSelectedCellInput}
                    onRun={runCell}
                    onDelete={deleteSelectedCell}
                    onClearSlot={clearSelectedCellSlot}
                    onOpenFullscreen={() => setFullscreenCellId(selectedNotebookCell.id)}
                    onPreviewPayload={previewGenerationPayload}
                  />
                ) : null}
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
                ref={momentSearchRef}
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
                    {(asset.type === 'image'
                      || asset.type === 'video'
                      || asset.type === 'final') && (
                      <button
                        type="button"
                        className="asset-similar-button"
                        disabled={busy}
                        onClick={() => momentSearchRef.current?.searchSimilar(asset)}
                      >
                        <Search size={13} />Similar
                      </button>
                    )}
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
                      <RefreshCw size={13} />
                      {processingArtifactId === asset.artifactId
                        ? 'Processing…'
                        : 'Retry processing'}
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
                  .then((outcome) => setNotice(outcome.message, outcome.ok ? 'info' : 'error'))
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
                    setNotice('Choose a source and a valid insertion frame', 'error')
                    return
                  }
                  void prepareSequenceEdit({
                    kind: 'insert',
                    artifact_id: timelineInsertAssetId,
                    timeline_start_frame: startFrame,
                    ...(Number.isSafeInteger(durationFrames) && durationFrames > 0
                      ? { duration_frames: durationFrames }
                      : {}),
                  }, 'ui').then((outcome) => setNotice(outcome.message, outcome.ok ? 'info' : 'error'))
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
                    setNotice('Select a sequence clip first', 'error')
                    return
                  }
                  void prepareSequenceEdit({
                    kind: 'trim',
                    clip_id: selectedSequenceClip.clipId,
                    timeline_start_frame: Number(timelineSelectionStart),
                    duration_frames: Number(timelineSelectionDuration),
                  }, 'ui').then((outcome) => setNotice(outcome.message, outcome.ok ? 'info' : 'error'))
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
                    setNotice('Select an audio clip and enter a valid gain', 'error')
                    return
                  }
                  void prepareSequenceEdit({
                    kind: 'volume',
                    clip_id: selectedSequenceClip.clipId,
                    gain_db: gainDb,
                    muted: timelineMuted,
                    fade_in_frames: Number(timelineFadeIn),
                    fade_out_frames: Number(timelineFadeOut),
                  }, 'ui').then((outcome) => setNotice(outcome.message, outcome.ok ? 'info' : 'error'))
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
                      }, 'ui').then((outcome) => setNotice(outcome.message, outcome.ok ? 'info' : 'error'))
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
                  }, 'ui').then((outcome) => setNotice(outcome.message, outcome.ok ? 'info' : 'error'))
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
                        }, 'ui').then((outcome) => setNotice(outcome.message, outcome.ok ? 'info' : 'error'))
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
                        }, 'ui').then((outcome) => setNotice(outcome.message, outcome.ok ? 'info' : 'error'))
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
                        }, 'ui').then((outcome) => setNotice(outcome.message, outcome.ok ? 'info' : 'error'))
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
                        }, 'ui').then((outcome) => setNotice(outcome.message, outcome.ok ? 'info' : 'error'))
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
                        }, 'ui').then((outcome) => setNotice(outcome.message, outcome.ok ? 'info' : 'error'))
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
                        }, 'ui').then((outcome) => setNotice(outcome.message, outcome.ok ? 'info' : 'error'))
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
                  }, 'ui').then((outcome) => setNotice(outcome.message, outcome.ok ? 'info' : 'error'))
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
                        .then((outcome) => setNotice(outcome.message, outcome.ok ? 'info' : 'error'))
                        .catch((error: unknown) => setNotice(
                          error instanceof Error ? error.message : String(error),
                          'error',
                        ))
                    }}
                  >
                    Generate from transcript
                  </button>
                  <button
                    type="button"
                    disabled={busy || !sequence || sequence.captions.length === 0}
                    onClick={() => void prepareRoughCut('ui')
                      .then((outcome) => setNotice(outcome.message, outcome.ok ? 'info' : 'error'))}
                  >
                    Suggest rough cut
                  </button>
                  <button
                    type="button"
                    disabled={busy || !audioNotebook.transcript}
                    onClick={() => void prepareNotebookCleanup('ui')
                      .then((outcome) => setNotice(outcome.message, outcome.ok ? 'info' : 'error'))}
                  >
                    Suggest cleanup
                  </button>
                  <button
                    type="button"
                    disabled={busy || !sequence || sequence.captions.length === 0}
                    onClick={() => void prepareSoundEffects('ui')
                      .then((outcome) => setNotice(outcome.message, outcome.ok ? 'info' : 'error'))}
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
                      setNotice(
                        errors.join(' · ') || 'Export validation failed',
                        'error',
                      )
                      return
                    }
                    return previewCommandPlan(asCommandPlan(value))
                      .then((outcome) => setNotice(outcome.message, outcome.ok ? 'info' : 'error'))
                  }).catch((error: unknown) => {
                    setNotice(error instanceof Error ? error.message : String(error), 'error')
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
                              .then((outcome) => setNotice(outcome.message, outcome.ok ? 'info' : 'error'))}
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
              <div className="settings-sections"><div className="settings-grid">{providers.map((provider) => <article className="provider-card" key={provider.envKey}><span className={`provider-dot provider-${provider.keyStatus}`} /><div><strong>{provider.label}</strong><p>{provider.keyStatus}{provider.maskedKey ? ` · ${provider.maskedKey}` : ''}</p></div></article>)}</div><div className="settings-diagnostics"><div className="workspace-section-heading"><h2>Selected book storage</h2><p>Catalog and object publication status from videobook-engine {enginePackage.version} schema v{SCHEMA_VERSION}.</p></div><div className="settings-diagnostics-grid"><article className="record-card"><pre>{storage ? JSON.stringify(storage, null, 2) : 'Refresh settings to inspect storage.'}</pre></article></div></div></div>
            </section>
          )}
      </>

      {mediaLibraryPicker && mediaLibraryKind && (
        <MediaLibraryDialog
          state={mediaLibraryPicker}
          kind={mediaLibraryKind}
          targetBookId={bookId}
          onClose={closeMediaLibrary}
          onMode={changeMediaLibraryMode}
          onDraftQuery={updateMediaLibraryDraft}
          onSearch={searchMediaLibrary}
          onLoadMore={loadMoreMediaLibrary}
          onAttach={(asset) => void attachLibraryAsset(asset)}
          onReferenceFile={(file) => void prepareMediaLibraryFile(file)}
          onClearReference={clearMediaLibraryReference}
          onReferenceStart={(value) => setMediaLibraryPicker((current) =>
            current ? { ...current, referenceStartSeconds: value } : current)}
          onReferenceDuration={(value) => setMediaLibraryPicker((current) =>
            current ? { ...current, referenceDurationSeconds: value } : current)}
          onSimilar={(asset) => void prepareMediaLibrarySimilar(asset)}
        />
      )}

      {fullscreenCell && fullscreenNode?.data.asset && (
        <NotebookMediaFullscreen
          asset={fullscreenNode.data.asset}
          slug={notebookGridAddress(fullscreenCell.slot)}
          onClose={closeMediaFullscreen}
        />
      )}

      <CommandComposer
        commands={commands}
        cells={notebook?.cells ?? []}
        bookId={bookId}
        callTool={call}
        chatModels={chatModelCatalog.models}
        disabled={busy || !bookId || mcp.state !== 'ready'}
        modelSelectionDisabled={!bookId || mcp.state !== 'ready'}
        connectionLabel={mcp.state === 'ready' ? 'Load a book to begin' : 'Connecting to MCP…'}
        mcpActivity={mcpActivity}
        promptSession={null}
        selectedModel={chatModel}
        pendingInput={pendingChatAction?.kind === 'generation'
          ? '/apply '
          : pendingCommandPlan || pendingChatAction
            ? '/apply'
            : undefined}
        notice={notice
          ? { message: notice.text, tone: notice.tone }
          : null}
        onEnsureCatalog={refreshComposerCatalog}
        onDismissNotice={() => setNoticeState(null)}
        onDismissPanel={pendingCommandPlan || pendingChatAction
          ? dismissPendingCommandPlan
          : undefined}
        onExecute={executeCommand}
        onModelChange={changeChatModel}
        onSuccessfulExecute={revealLatestNotebookResult}
      >
        {pendingCommandPlan && (
          <aside
            className="command-plan-drawer"
            aria-label="Command plan review"
            aria-keyshortcuts="Escape"
            onKeyDown={(event) => {
              if (event.key !== 'Escape' || busy) return
              event.preventDefault()
              event.stopPropagation()
              dismissPendingCommandPlan()
            }}
          >
            <header>
              <div className="command-plan-heading">
                <span className="section-label">
                  COMMANDPLAN · {pendingCommandPlan.plan.sourceSurface.toUpperCase()}
                </span>
                <h2>{pendingCommandPlan.plan.summary}</h2>
              </div>
              <div className="command-plan-primary-actions">
                <button
                  type="submit"
                  form={COMMAND_COMPOSER_FORM_ID}
                  className="command-plan-apply"
                  disabled={
                    busy
                    || (
                      pendingCommandPlan.plan.suggestions?.every(
                        (suggestion) => !suggestion.included,
                      ) ?? false
                    )
                    || Object.values(pendingCommandPlan.previews).some(
                      (preview) => !preview.valid,
                    )
                  }
                >
                  <Check size={14} />Apply
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={dismissPendingCommandPlan}
                >
                  Cancel
                </button>
              </div>
            </header>
            <details className="command-plan-details">
              <summary>
                Review {pendingCommandPlan.plan.stages.length} planned stage
                {pendingCommandPlan.plan.stages.length === 1 ? '' : 's'}
              </summary>
              <div className="command-plan-content">
              <div className="command-plan-context">
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
                          onChange={() => void toggleCommandSuggestion(
                            suggestion.suggestionId,
                          )}
                        />
                        <span>
                          <strong>{suggestion.label}</strong>
                          {suggestion.detail && <small>{suggestion.detail}</small>}
                        </span>
                      </label>
                    ))}
                  </fieldset>
                )}
              </div>
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
              </div>
              {lastEditActionId && (
                <div className="command-plan-secondary-actions">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void restoreLastCommandPlan()}
                  >
                    <Undo2 size={14} />Restore last edit
                  </button>
                </div>
              )}
            </details>
          </aside>
        )}
        {pendingChatAction?.kind === 'generation' && (
          <GenerationChatReview
            actions={pendingGenerationActionOptions}
            applyFormId={COMMAND_COMPOSER_FORM_ID}
            busy={busy}
            draft={pendingChatAction.draft}
            modes={pendingGenerationModeOptions}
            preview={pendingChatAction.preview}
            previewError={pendingChatAction.previewError}
            previewLoading={pendingChatAction.previewLoading}
            previewStale={pendingChatAction.previewStale}
            sources={pendingGenerationSources}
            summary={pendingChatAction.summary}
            onActionChange={updatePendingGenerationAction}
            onCancel={dismissPendingCommandPlan}
            onModeChange={updatePendingGenerationMode}
            onPromptChange={updatePendingGenerationPrompt}
            onRefreshPreview={refreshPendingGenerationPreview}
            onSelectSource={selectPendingGenerationSource}
            onSettingChange={updatePendingGenerationSetting}
          />
        )}
        {pendingChatAction && pendingChatAction.kind !== 'generation' && (
          <aside
            className="command-plan-drawer"
            aria-label="Chat action review"
            aria-keyshortcuts="Escape"
          >
            <header>
              <div className="command-plan-heading">
                <span className="section-label">ACTION · CHAT</span>
                <h2>{pendingChatAction.kind === 'routed'
                  || pendingChatAction.kind === 'notebook'
                  ? pendingChatAction.plan.summary
                  : pendingChatAction.summary}</h2>
              </div>
              <div className="command-plan-primary-actions">
                <button
                  type="submit"
                  form={COMMAND_COMPOSER_FORM_ID}
                  className="command-plan-apply"
                  disabled={busy}
                >
                  <Check size={14} />Apply
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={dismissPendingCommandPlan}
                >
                  <X size={14} />Cancel
                </button>
              </div>
            </header>
            <div className="command-plan-details command-plan-details-open">
              <div className="command-plan-content command-plan-content-single">
                <div className="command-plan-context">
                  <p>{pendingChatAction.kind === 'routed'
                    ? pendingChatAction.plan.confirmation.reason
                    : pendingChatAction.kind === 'notebook'
                      ? pendingChatAction.plan.reason
                      : pendingChatAction.reason}</p>
                </div>
                <ol className="command-plan-stages">
                  <li>
                    <span>{pendingChatAction.kind.toUpperCase()}</span>
                    <strong>{pendingChatAction.kind === 'routed'
                      ? pendingRoutedActionReview?.title
                        ?? pendingChatAction.plan.routedTool
                      : pendingChatAction.kind === 'notebook'
                        ? `${pendingChatAction.plan.action.kind} notebook cell`
                        : pendingChatAction.kind === 'split'
                          ? 'Split video'
                          : `Extract ${pendingChatAction.command.frameMode} frame`}</strong>
                    {pendingChatAction.kind === 'routed' && (
                      <>
                        <small>{pendingChatAction.plan.routedTool}</small>
                        <dl
                          className="routed-action-settings"
                          aria-label="Action settings"
                        >
                          {pendingRoutedActionReview?.settings.map((setting) => (
                            <div
                              key={setting.label}
                              className={setting.tone === 'warning'
                                ? 'routed-action-setting-warning'
                                : undefined}
                            >
                              <dt>{setting.label}</dt>
                              <dd>{setting.value}</dd>
                            </div>
                          ))}
                        </dl>
                      </>
                    )}
                  </li>
                </ol>
              </div>
            </div>
          </aside>
        )}
      </CommandComposer>
    </main>
  )
}

export default App
