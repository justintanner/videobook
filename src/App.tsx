import {
  createContext,
  lazy,
  Suspense,
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
  useUpdateNodeInternals,
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
  Ellipsis,
  Film,
  History,
  Image,
  Layers2,
  Library,
  Mic,
  Network,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  RefreshCw,
  Scissors,
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
  NotebookCellExecution,
  NotebookCellReference,
  NotebookCellType,
  NotebookDocument,
  PinnedSearchResult,
  Sequence,
  TimedSequenceClip,
} from 'videobook-engine'
import { SCHEMA_VERSION } from 'videobook-engine/catalog-metadata'
import enginePackage from 'videobook-engine/package.json'
import { normalizeNotebookReference } from 'videobook-engine/notebook-mentions'
import { resolveGeneratedVideoArtifact } from 'videobook-engine/notebook-media-artifact'
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
import { BusyIndicator } from '@/components/videobook/BusyIndicator'
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
import {
  NotebookCellInspector,
  type CellGenerationAttempt,
  type NotebookCellInspectorAsset,
} from '@/components/videobook/NotebookCellInspector'
import { MediaLibraryAssetPreview } from '@/components/videobook/MediaLibraryAssetPreview'
import {
  GenerationChatReview,
  type GenerationReviewSource,
} from '@/components/videobook/GenerationChatReview'
import { ReverseSearchReference } from '@/components/videobook/ReverseSearchReference'
import {
  NotebookMediaFullscreen,
  type ImageReplacementCandidate,
  type ImageSubjectEditInput,
} from '@/components/videobook/NotebookMediaFullscreen'
import type { WatermarkReviewState } from '@/components/videobook/WatermarkChatReview'
import { materializeNotebookSpeakCommand } from './videobook/notebook-speak-command'
import { useElevenLabsVoices } from './videobook/use-elevenlabs-voices'
import {
  persistSpeakVoiceId,
  readStoredSpeakVoiceId,
  resolveSpeakPreviewAction,
  resolveSpeakVoiceId,
} from './videobook/speak-preview'
import { resolveWatermarkTarget } from './videobook/watermark-target'
import {
  clampHandlePadding,
  clampHandleRounding,
  clampHandleVerticalPercent,
  clampWatermarkOpacity,
  DEFAULT_HANDLE_PADDING,
  DEFAULT_HANDLE_ROUNDING,
  DEFAULT_HANDLE_VERTICAL_PERCENT,
  DEFAULT_WATERMARK_OPACITY,
  isWatermarkPosition,
} from './videobook/watermark-review'
import {
  NotebookCellContextMenu,
  type NotebookCellContextAction,
} from '@/components/videobook/NotebookCellContextMenu'
import { BookProjectMenu } from '@/components/videobook/BookProjectMenu'
import {
  NotebookCellAddMenu,
} from '@/components/videobook/NotebookCellAddMenu'
import { isNotebookCellAddType } from '@/videobook/notebook-cell-add-menu'
import { VideoSegmentSplit } from '@/components/videobook/VideoSegmentSplit'
import { SpeedChangePreview } from '@/components/videobook/SpeedChangePreview'
import { PostToXChatPreview } from '@/components/videobook/PostToXChatPreview'
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
  abbreviateGenerationPhrases,
  asNotebookGenerationActions,
  compatibleGenerationActions,
  compatibleGenerationModes,
  type GenerationControlValue,
  type GenerationPreviewDraft,
  type NotebookGenerationAction,
} from '@/videobook/notebook-generation-actions'
import {
  notebookCellRequiresCloudGenerationConsent,
  notebookCellSupportsGenerateCellCommand,
} from '@/videobook/notebook-generation-policy'
import {
  startNotebookCellRun,
} from '@/videobook/notebook-cell-actions'
import {
  prepareExistingSearchReference,
  referenceKind,
  searchReferenceRange,
  uploadSearchReference,
  type ReverseSearchMode,
  type SearchReferenceDescriptor,
} from '@/videobook/search-reference'
import {
  type SearchReferenceLifecycleState,
  type SearchReferenceMode,
} from '@/videobook/search-reference-lifecycle'
import { useSearchReferenceLifecycle } from '@/videobook/useSearchReferenceLifecycle'
import {
  validateCommandPlan,
  type CommandPlan,
  type EditCommandStage,
} from '@/videobook/command-plan'
import { useLastWorkSlot } from '@/videobook/last-work-slot'
import {
  changedNotebookGridNodes,
  nextNotebookCreationSlot,
  normalizeNotebookGridZoom,
  parseNotebookGridAddress,
  notebookGrid,
  notebookGridAddress,
  notebookGridDropSlot,
  notebookGridFrameSize,
  notebookGridMetrics,
  notebookGridSlot,
  notebookGridSquareAt,
  notebookGridTag,
  notebookGridViewport,
  resolveNotebookGridGroupMove,
  snapNotebookGridMove,
  type NotebookGridSlot,
} from '@/videobook/notebook-grid'
import {
  planNotebookArrangement,
  revealNotebookArrangement,
} from '@/videobook/notebook-auto-arrange'
import {
  planVideoAxisArrangement,
  type NotebookVideoAxis,
} from '@/videobook/notebook-video-axis-arrange'
import {
  notebookSourcePortId,
  notebookSourcePortOffsets,
  type NotebookSourceSide,
} from '@/videobook/notebook-routing'
import {
  formatMediaAspectRatio,
  formatMediaTime,
  notebookAudioPresentation,
  isImageVideoGenerationResultCell,
  notebookCellActionPresentation,
  notebookCellExecutionObservation,
  notebookCellInspectorActionLabel,
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
  mediaAssetWatchStep,
  downloadVideoCellInput,
} from '@/videobook/notebook-download'
import { routedMediaCellInputs } from '@/videobook/notebook-routed-action'
import {
  enqueueNotebookAudioCommand,
  type NotebookAudioCommand,
} from '@/videobook/notebook-audio-command'
import {
  enqueueNotebookFrameCommand,
  type NotebookFrameCommand,
} from '@/videobook/notebook-frame-command'
import {
  enqueueNotebookSplitCommand,
  notebookSplitCellBudget,
  notebookSplitCutPoints,
  notebookSplitPieces,
  notebookSplitSummary,
  parseNotebookSplitCommand,
  planNotebookSplitCommand,
  type NotebookSplitCommand,
  type NotebookSplitOutputMode,
  type NotebookSplitRun,
} from '@/videobook/notebook-split-command'
import { resolveNotebookVideoSourceCell } from '@/videobook/notebook-video-source'
import { durationTargetsToCutPoints } from '@/videobook/video-split-segments'
import {
  generationCellTypeForRoutedTool,
  materializeNotebookChatGeneration,
  notebookChatGenerationConnectedInputs,
  notebookChatGenerationParameterReferences,
  notebookChatGenerationReferences,
  notebookChatGenerationSettings,
  notebookChatGenerationSourceOptions,
  planNotebookChatGeneration,
  reviseNotebookChatGenerationAction,
  reviseNotebookChatGenerationMode,
  reviseNotebookChatGenerationPrompt,
  reviseNotebookChatGenerationSetting,
  reviseNotebookChatGenerationSources,
  validateNotebookChatGenerationPromptSources,
  type NotebookChatGenerationCommand,
  type NotebookChatGenerationDraft,
} from '@/videobook/notebook-chat-generation'
import {
  providerPayloadPreviewReferenceError,
} from '@/videobook/provider-payload-preview'
import { notebookMediaWorkState } from '@/videobook/notebook-media-work'
import { isNotebookGenerationCellType } from '@/videobook/notebook-cell-types'
import {
  mediaFileAccept,
  mediaKindForFile,
  type PassiveMediaKind,
} from '@/videobook/notebook-media-drop'
import {
  selectPreferredBook,
  type InitialWorkspacePayload,
} from '@/videobook/initial-workspace'
import {
  asChatModelCatalog,
  fallbackChatModelCatalog,
  resolveChatModelSelection,
  type ChatModelCatalog,
} from '@/videobook/chat-models'
import { routedActionReview } from '@/videobook/chat-action-review'
import {
  handleModalDialogKeyDown,
  scheduleModalDialogFocusRestoration,
  shouldDismissModalDialogFromBackdrop,
} from '@/videobook/modal-dialog-interactions'
import {
  idleMcpActivity,
  shouldNotifyMcpActivity,
  type McpActivity,
} from '@/videobook/mcp-activity'
import { useMcpConnection } from '@/videobook/useMcpConnection'
import type {
  BookProjectMutationResult,
  BookProjectSummary,
} from '@/videobook/book-project-catalog'
import {
  notebookMentionAssets,
  resolveNotebookMentionAliases,
  restoreNotebookMentionAliases,
  restoreSelectedNotebookMentionAliases,
} from '@/videobook/mention-suggestions'
import { restoreCommandComposerFocus } from '@/videobook/command-composer-focus'
import { parsePendingApplyCommand } from '@/videobook/command-composer-outcome'
import { revealNotebookResult } from '@/videobook/notebook-result-reveal'
import {
  notebookAddressExpectationsAreStale,
  type NotebookAddressExpectation,
  type NotebookCoordinateActionPlan,
} from '@/videobook/notebook-coordinate-actions'
import { notebookCellAtSlot } from '@/videobook/notebook-addressing'
import { recordValue } from '@/videobook/value-decoders'
import {
  asImageSubjectMap,
  type ImageSubjectMap,
} from '@/videobook/image-subject-map'
import { pollImageSubjectMap } from '@/videobook/image-subject-map-poll'
import {
  asMediaTranscriptSources,
  asMediaVisionAnalysis,
  idleMediaInsightWork,
  mediaInsightIsRunning,
  mediaInsightRunningPatch,
  type MediaInsightKind,
  type MediaInsightWork,
  type MediaTranscriptSources,
  type MediaVisionAnalysis,
  type TranscriptSidecarSource,
} from '@/videobook/media-insights'
import {
  mediaInsightWatchStep,
  type MediaInsightWatchStep,
} from '@/videobook/media-insight-watch'
import { guardedAsyncResult } from '@/videobook/async-request-guard'

const WatermarkChatReview = lazy(async () => {
  const module = await import('@/components/videobook/WatermarkChatReview')
  return { default: module.WatermarkChatReview }
})

type Screen = 'notebook' | 'library' | 'timeline' | 'jobs' | 'settings'

type ToolResponse = {
  content?: Array<{ type: string; text?: string }>
  isError?: boolean
}

type AssetRecord = {
  id: string
  artifactId: string
  objectHash: string | null
  type: string
  createdAt: string
  mediaUrl: string | null
  thumbnailUrl: string | null
  status: string
  prompt: string | null
  width: number | null
  height: number | null
  duration: number | null
  fps: number | null
  audioInfo: NotebookAudioInfo | null
  analysisInfo: NotebookAnalysisInfo | null
  transcript: MediaTranscriptSources | null
  visionAnalysis: MediaVisionAnalysis | null
}

type MediaFullscreenSession = {
  key: string
  bookId: string
  notebookId: string
  cellId: string
  address: string
  asset: NotebookCellInspectorAsset
  returnFocus: HTMLElement | null
  subjectMap: ImageSubjectMap | null
  subjectMapLoading: boolean
}

type MediaSearchMode = SearchReferenceMode

type MediaSlotOperation = 'attach' | 'upload'

type MediaSlotState = {
  operation: MediaSlotOperation | null
  error: string | null
}

type LibraryAssetRecord = AssetRecord & {
  owningBookId: string
  owningBookName: string
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
  query: string
  draftQuery: string
  assets: LibraryAssetRecord[]
  page: LibrarySearchPage
  booksWithErrors: Array<{ bookId: string; message: string }>
  loading: boolean
  loadingMore: boolean
  error: string | null
  activeArtifactId: string | null
}

type MediaLibraryDialogState = MediaLibraryPickerState & {
  mode: MediaSearchMode
  reference: SearchReferenceDescriptor | null
  referenceStartSeconds: string
  referenceDurationSeconds: string
  preparingReference: boolean
}

type MediaLibrarySearchCriteria = {
  mode: MediaSearchMode
  reference: SearchReferenceDescriptor | null
  referenceStartSeconds: string
  referenceDurationSeconds: string
}

function mediaLibrarySearchCriteria(
  state: SearchReferenceLifecycleState,
): MediaLibrarySearchCriteria {
  return {
    mode: state.mode,
    reference: state.reference,
    referenceStartSeconds: state.startSeconds,
    referenceDurationSeconds: state.durationSeconds,
  }
}

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
    required: boolean
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
      sourceDurationSeconds: number
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
  result: Record<string, unknown> | null
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
  'open_watermark',
  'speak_preview',
])

const CLOUD_GENERATION_CONSENT_KEY = 'videobook.cloud-generation-consent'

function acceptCloudGenerationConsent(stage: {
  provider?: string | null
  model?: string | null
  tool: string
}): boolean {
  if (window.localStorage.getItem(CLOUD_GENERATION_CONSENT_KEY) === 'accepted') {
    return true
  }
  const accepted = window.confirm(
    `Cloud generation disclosure\n\nProvider/model: ${stage.provider ?? 'unknown'} · ${stage.model ?? stage.tool}\n`
    + 'Payload class: prompt text and connected media references.\n'
    + 'Your local source files are sent only when required by the selected model.\n\n'
    + 'Continue and remember this choice on this device?',
  )
  if (!accepted) return false
  window.localStorage.setItem(CLOUD_GENERATION_CONSENT_KEY, 'accepted')
  return true
}

interface CanvasCellData extends NotebookCellData {
  asset?: AssetRecord
  deleting?: boolean
  revealing?: boolean
  videoAspectRatio?: string
  videoDurationSeconds?: number
  splitFrames?: {
    first: { artifactId: string | null; asset?: AssetRecord }
    last: { artifactId: string | null; asset?: AssetRecord }
  }
}

type CanvasNode = Node<CanvasCellData>

type CellContextMenuState = {
  cellId: string
  position: { x: number; y: number }
  returnFocus: HTMLElement | null
}

type CellContextMenuContextValue = {
  openCellId: string | null
  open: (
    cellId: string,
    position: { x: number; y: number },
    returnFocus: HTMLElement | null,
  ) => void
}

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
const PrimaryCellContext = createContext<string | null>(null)
const GenerationTitlesContext = createContext<ReadonlyMap<string, string>>(
  new Map(),
)
const CellContextMenuContext = createContext<CellContextMenuContextValue>({
  openCellId: null,
  open: () => undefined,
})

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
const mediaInsightWatchIntervalMs = 3_000
const mediaInsightWatchTimeoutMs = 20 * 60_000
const mediaProcessWatchIntervalMs = 750
const mediaAssetWatchTimeoutMs = 45 * 60_000
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

const notebookCellTypes = new Set<string>([
  'audio',
  'image',
  'video',
  'extract_audio',
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

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function assetHasInsight(
  asset: AssetRecord | undefined,
  insight: MediaInsightKind,
): boolean {
  return Boolean(insight === 'transcript'
    ? asset?.transcript
    : asset?.visionAnalysis)
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
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
  const item = recordValue(value)
  if (!item) return fallback
  for (const key of ['message', 'job_id', 'notebook_id', 'address', 'bookId']) {
    const candidate = asString(item[key])
    if (candidate) return `${fallback}: ${candidate}`
  }
  return fallback
}

function isDownloadVideoResult(value: unknown): boolean {
  const item = recordValue(value)
  return asString(item?.artifact_id) !== null
    && asString(item?.assetId) !== null
    && asString(item?.job_id)?.startsWith('download-') === true
}

function asChatActionPlan(value: unknown): ChatActionPlan {
  const item = recordValue(value)
  const params = recordValue(item?.params)
  const confirmation = recordValue(item?.confirmation)
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
  const required = confirmation?.required
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
    || typeof required !== 'boolean'
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
    confirmation: { required, reason },
  }
}

function generationMediaKind(
  cellType: NotebookChatGenerationCommand['cellType'],
): NotebookChatGenerationCommand['mediaKind'] {
  if (cellType === 'generate_audio') return 'audio'
  if (cellType === 'generate_image') return 'image'
  return 'video'
}

type ContextMenuGenerationCellType = Extract<
  NotebookChatGenerationCommand['cellType'],
  'generate_image' | 'generate_video'
>

function planContextMenuGeneration(input: {
  actions: readonly NotebookGenerationAction[]
  cellId: string
  cellType: ContextMenuGenerationCellType
  document: NotebookDocument
  lastWorkSlot: NotebookGridSlot | null
  sourceCellId: string
}): NotebookChatGenerationDraft {
  const source = input.document.cells.find((cell) =>
    cell.id === input.sourceCellId)
  if (!source) throw new Error('The source asset cell is no longer available')
  return planNotebookChatGeneration({
    actions: input.actions,
    cellId: input.cellId,
    command: {
      cellType: input.cellType,
      mediaKind: generationMediaKind(input.cellType),
      prompt: '',
      sourceReferences: [notebookGridTag(source.slot)],
    },
    document: input.document,
    fallbackSlot: nextNotebookCreationSlot(
      input.cellType,
      input.document.cells,
      input.lastWorkSlot,
    ),
    lastWorkSlot: input.lastWorkSlot,
  })
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
    const item = recordValue(entry)
    const bookId = item && asString(item.bookId)
    const name = item && asString(item.name)
    const createdAt = item && asNumber(item.createdAt)
    if (!item || !bookId || !name || createdAt === null) return []
    return [{
      bookId,
      name,
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
  const item = recordValue(value)
  const id = item && asString(item.id)
  const type = item && asString(item.type)
  const label = item && asString(item.label)
  const slot = item && recordValue(item.slot)
  const row = slot && asNumber(slot.row)
  const column = slot && asNumber(slot.column)
  if (
    !item
    || !id
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
  const inputs = recordValue(item.inputs)
  const references = Array.isArray(item.references)
    ? item.references as NotebookCellReference[]
    : undefined
  const pinnedResults = Array.isArray(item.pinned_results ?? item.pinnedResults)
    ? (item.pinned_results ?? item.pinnedResults) as PinnedSearchResult[]
    : undefined
  return {
    id,
    type: type as NotebookCellType,
    ...(label ? { label } : {}),
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
  const item = recordValue(value)
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
      const parsed = recordValue(edge)
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
    ...(recordValue(item.fixture)
      ? { fixture: recordValue(item.fixture)! as NotebookDocument['fixture'] }
      : {}),
    ...(recordValue(item.execution)
      ? { execution: recordValue(item.execution)! as NonNullable<NotebookDocument['execution']> }
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
  const item = recordValue(value)
  const id = item && asString(item.id)
  const artifactId = item && asString(item.artifact_id ?? item.artifactId)
  const type = item && asString(item.type)
  if (!item || !id || !artifactId || !type) return null
  const audio = recordValue(item.audio_info)
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
  const analysis = recordValue(item.analysis_info ?? item.analysisInfo)
  const sourceDurationSeconds = analysis
    && asNumber(analysis.source_duration_seconds ?? analysis.sourceDurationSeconds)
  const analysisShots = Array.isArray(analysis?.shots)
    ? analysis.shots.flatMap((value) => {
        const shot = recordValue(value)
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
        const exchange = recordValue(value)
        const provider = exchange && asString(exchange.provider)
        const model = exchange && asString(exchange.model)
        const stage = exchange && asString(exchange.stage)
        const responseFormatValue = exchange
          && recordValue(exchange.response_format ?? exchange.responseFormat)
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
    objectHash: asString(item.object_hash ?? item.objectHash),
    type,
    createdAt: asString(item.created_at ?? item.createdAt) ?? '',
    mediaUrl: asString(item.media_url ?? item.mediaUrl),
    thumbnailUrl: asString(item.thumbnail_url ?? item.thumbnailUrl),
    status: asString(item.status) ?? 'ready',
    prompt: asString(item.prompt),
    width: asNumber(item.width),
    height: asNumber(item.height),
    duration: asNumber(item.duration),
    fps: asNumber(item.fps),
    audioInfo,
    analysisInfo,
    transcript: asMediaTranscriptSources(item.transcript),
    visionAnalysis: asMediaVisionAnalysis(
      item.vision_analysis ?? item.visionAnalysis,
    ),
  }
}

function asAssets(value: unknown): AssetRecord[] {
  const container = recordValue(value)
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

function imageSubjectMapForSession(
  session: MediaFullscreenSession,
  value: unknown,
): ImageSubjectMap {
  const subjectMap = asImageSubjectMap(value)
  if (
    subjectMap.artifactId
    && subjectMap.artifactId !== session.asset.artifactId
  ) {
    throw new Error('The subject map belongs to another image artifact')
  }
  if (
    subjectMap.objectHash
    && subjectMap.objectHash !== session.asset.objectHash
  ) {
    throw new Error('The image changed before subject analysis finished')
  }
  return {
    ...subjectMap,
    artifactId: subjectMap.artifactId ?? session.asset.artifactId,
    objectHash: subjectMap.objectHash ?? session.asset.objectHash ?? null,
    width: subjectMap.width ?? session.asset.width,
    height: subjectMap.height ?? session.asset.height,
  }
}

function failedImageSubjectMap(
  session: MediaFullscreenSession,
  error: unknown,
  subjectMap: ImageSubjectMap | null = session.subjectMap,
): ImageSubjectMap {
  return {
    status: 'failed',
    artifactId: session.asset.artifactId,
    objectHash: session.asset.objectHash ?? null,
    width: session.asset.width,
    height: session.asset.height,
    baseUrl: subjectMap?.baseUrl ?? null,
    jobId: subjectMap?.jobId ?? null,
    startedAt: subjectMap?.startedAt ?? null,
    error: error instanceof Error ? error.message : String(error),
    subjects: subjectMap?.subjects ?? [],
  }
}

function asLibrarySearchResult(value: unknown): LibrarySearchResult {
  const container = recordValue(value)
  const source = Array.isArray(container?.assets) ? container.assets : []
  const pageValue = recordValue(container?.page)
  const offset = asNumber(pageValue?.offset) ?? 0
  const limit = asNumber(pageValue?.limit) ?? 24
  const total = asNumber(pageValue?.total) ?? 0
  const errors = Array.isArray(container?.books_with_errors)
    ? container.books_with_errors
    : []
  return {
    assets: source.flatMap((entry) => {
      const item = recordValue(entry)
      const asset = asAsset(item)
      const owningBookId = item && asString(item.owning_book_id)
      const owningBookName = item && asString(item.owning_book_name)
      return asset && owningBookId && owningBookName
        ? [{ ...asset, owningBookId, owningBookName }]
        : []
    }),
    page: {
      offset,
      limit,
      total,
      hasMore: pageValue?.hasMore === true,
    },
    booksWithErrors: errors.flatMap((entry) => {
      const item = recordValue(entry)
      const errorBookId = item && asString(item.book_id)
      const message = item && asString(item.message)
      return errorBookId && message ? [{ bookId: errorBookId, message }] : []
    }),
  }
}

function asIngestStatuses(value: unknown): IngestStatus[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const item = recordValue(entry)
    const artifactId = item && asString(item.artifactId)
    const state = item && asString(item.state)
    const phases = item && recordValue(item.phases)
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

function asSequence(value: unknown): Sequence | null {
  const item = recordValue(value)
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
  const item = recordValue(value)
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
  const token = normalizeNotebookReference(value)
  const matches = sequence.clips.filter((clip) =>
    clip.clipId.toLowerCase().startsWith(token))
  return matches.length === 1 ? matches[0] : null
}

function sequenceTrackReference(sequence: Sequence | null, value: string | undefined) {
  if (!sequence || !value) return null
  const token = normalizeNotebookReference(value)
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
    const item = recordValue(entry)
    const id = item && asNumber(item.id)
    const type = item && asString(item.type)
    const state = item && asString(item.state)
    const operationId = item && asString(item.operationId ?? item.operation_id)
    if (!item || id === null || !type || !state || !operationId) return []
    const error = recordValue(item.error)
    const payloadValue = item.payload
    const payload = payloadValue && typeof payloadValue === 'object'
      && !Array.isArray(payloadValue)
      ? payloadValue as Record<string, unknown>
      : null
    const result = recordValue(item.result)
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
      result,
      enqueuedAt: asNumber(item.enqueuedAt ?? item.enqueued_at) ?? 0,
      startedAt: asNumber(item.startedAt ?? item.started_at),
      finishedAt: asNumber(item.finishedAt ?? item.finished_at),
    }]
  })
}

function asGenerationPlans(value: unknown): GenerationPlanRecord[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const item = recordValue(entry)
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
      const item = recordValue(entry)
      const uiAction = item && asString(item.uiAction)
      return item !== null
        && typeof item.command === 'string'
        && typeof item.description === 'string'
        && (!uiAction || supportedUiActions.has(uiAction))
    })
    : []
}

function asProviders(value: unknown): ProviderRecord[] {
  const item = recordValue(value)
  if (!Array.isArray(item?.providers)) return []
  return item.providers.flatMap((entry) => {
    const provider = recordValue(entry)
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

const emptyLibraryPage: LibrarySearchPage = {
  offset: 0,
  limit: 24,
  total: 0,
  hasMore: false,
}

function passiveMediaKind(kind: NotebookCellType): PassiveMediaKind | null {
  return kind === 'audio' || kind === 'image' || kind === 'video' ? kind : null
}

function passiveMediaKindForAsset(type: string): PassiveMediaKind | null {
  if (type === 'final') return 'video'
  return type === 'audio' || type === 'image' || type === 'video' ? type : null
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

function dataTransferHasFiles(
  dataTransfer: Pick<DataTransfer, 'types'>,
): boolean {
  return dataTransfer.types.includes('Files')
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
  const execution = recordValue(document.execution)
  const item = execution && recordValue(execution[cellId])
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
  const execution = recordValue(document.execution)
  const item = execution && recordValue(execution[cellId])
  return asString(item?.startedAt) ?? asString(item?.updatedAt) ?? undefined
}

function cellExecutionError(
  document: NotebookDocument,
  cellId: string,
): string | undefined {
  const execution = recordValue(document.execution)
  const item = execution && recordValue(execution[cellId])
  return asString(item?.error) ?? undefined
}

function positiveMediaSetting(value: unknown): number | null {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value)
      : Number.NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function videoCanvasMetadata(
  document: NotebookDocument,
  cellId: string,
  asset: AssetRecord | undefined,
): { aspectRatio: string | null; durationSeconds: number | null } {
  const cell = document.cells.find((candidate) => candidate.id === cellId)
  const producerCellId = asString(cell?.inputs?.producerCellId)
    ?? document.edges.find((edge) =>
      edge.target === cellId && edge.targetInput === 'media')?.source
    ?? null
  const producer = producerCellId
    ? document.cells.find((candidate) => candidate.id === producerCellId)
    : undefined
  const generationSettings = producer?.type === 'generate_video'
    ? recordValue(producer.inputs?.generationSettings)
    : null
  const configuredAspectRatio = asString(
    cell?.inputs?.aspectRatio ?? cell?.inputs?.aspect_ratio,
  ) ?? asString(generationSettings?.aspect_ratio)
  const aspectRatio = configuredAspectRatio
    && configuredAspectRatio !== 'adaptive'
    && configuredAspectRatio !== 'auto'
    ? configuredAspectRatio
    : formatMediaAspectRatio(asset?.width ?? null, asset?.height ?? null)
  const actualDuration = positiveMediaSetting(asset?.duration)
  const configuredDuration = positiveMediaSetting(
    cell?.inputs?.durationSeconds
      ?? cell?.inputs?.duration_seconds
      ?? generationSettings?.duration
      ?? generationSettings?.duration_seconds,
  )
  return {
    aspectRatio,
    durationSeconds: actualDuration ?? configuredDuration,
  }
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
    const videoMetadata = node.data.kind === 'video'
      ? videoCanvasMetadata(document, node.id, asset)
      : null
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
        ...(videoMetadata?.aspectRatio
          ? { videoAspectRatio: videoMetadata.aspectRatio }
          : {}),
        ...(videoMetadata?.durationSeconds
          ? { videoDurationSeconds: videoMetadata.durationSeconds }
          : {}),
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
  if (kind === 'image' || kind === 'generate_image') {
    return <Image size={14} />
  }
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
  return kind.replace(/^generate_/, 'gen_').replaceAll('_', ' ').toUpperCase()
}

function compactCellTypeLabel(kind: NotebookCellType): string {
  if (kind === 'generate_video') return 'GEN VID'
  if (kind === 'generate_image') return 'GEN IMG'
  if (kind === 'generate_audio') return 'GEN AUD'
  return cellTypeLabel(kind)
}

function cellContextMenuId(cellId: string): string {
  return `cell-context-menu-${cellId}`
}

function emptyCellLabel(data: CanvasCellData): string {
  if (isNotebookGenerationCellType(data.kind)) {
    return data.tool ?? data.model ?? data.operation ?? 'Choose a generation action'
  }
  if (data.kind === 'video' || data.kind === 'image' || data.kind === 'audio') {
    return `Select ${data.kind} media`
  }
  if (data.kind === 'character') return 'Select a character'
  if (data.kind === 'extract_audio') return 'Connect a video to extract audio'
  if (data.kind === 'analysis') return 'Run the connected Analyze cell'
  if (data.kind === 'split_video') return 'Configure a video range'
  if (data.kind === 'concat') return 'Connect clip:0 and clip:1'
  if (data.kind === 'splice') return 'Connect first and second'
  return data.prompt || notebookGridTag(data.slot)
}

type ImageCardMetadataBadgesProps = {
  width: number | null
  height: number | null
  tool: string | null
  model: string | null
  prompt: string | null
  provenance?: string | null
}

export function ImageCardMetadataBadges({
  width,
  height,
  tool,
  model,
  prompt,
  provenance = null,
}: ImageCardMetadataBadgesProps) {
  const dimensions = width !== null
    && height !== null
    && Number.isFinite(width)
    && Number.isFinite(height)
    && width > 0
    && height > 0
    ? `${width}×${height}`
    : null
  const aspectRatio = formatMediaAspectRatio(width, height)
  const generator = tool ?? model
  const generatorLabel = generator
    ? abbreviateGenerationPhrases(generator)
    : null

  if (!dimensions && !aspectRatio && !generatorLabel && !provenance) return null

  const ariaLabel = [
    'Image metadata',
    dimensions ? `Dimensions ${dimensions}` : null,
    aspectRatio ? `Aspect ratio ${aspectRatio}` : null,
    generatorLabel ? `Generator ${generatorLabel}` : null,
    provenance ? `Extracted from ${provenance}` : null,
    prompt ? `Prompt: ${prompt}` : null,
  ].filter(Boolean).join('. ')

  return (
    <div
      className="cell-image-metadata"
      role="group"
      aria-label={ariaLabel}
    >
      {dimensions && (
        <span className="cell-image-metadata-badge" title="Dimensions">
          {dimensions}
        </span>
      )}
      {aspectRatio && (
        <span className="cell-image-metadata-badge" title="Aspect ratio">
          {aspectRatio}
        </span>
      )}
      {generatorLabel && (
        <span
          className="cell-image-metadata-badge cell-image-metadata-generator"
          title={generatorLabel}
        >
          {generatorLabel}
        </span>
      )}
      {provenance && (
        <span
          className="cell-image-metadata-badge cell-image-metadata-generator"
          title={`Extracted from ${provenance}`}
        >
          {provenance}
        </span>
      )}
    </div>
  )
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

  return (
    <section
      className={`cell-media-slot nodrag nowheel${dragging ? ' cell-media-slot-dragging' : ''}`}
      aria-label={`Empty ${kind} media slot`}
      onDragEnter={(event) => {
        if (!dataTransferHasFiles(event.dataTransfer)) return
        event.preventDefault()
        event.stopPropagation()
        setDragging(true)
      }}
      onDragLeave={(event) => {
        if (!dataTransferHasFiles(event.dataTransfer)) return
        event.preventDefault()
        event.stopPropagation()
        setDragging(false)
      }}
      onDragOver={(event) => {
        if (!dataTransferHasFiles(event.dataTransfer)) return
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = 'copy'
      }}
      onDrop={(event) => {
        if (!dataTransferHasFiles(event.dataTransfer)) return
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
        {busy ? <BusyIndicator size={24} /> : <Upload size={24} />}
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
  state: MediaLibraryDialogState
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
        if (shouldDismissModalDialogFromBackdrop(
          event.currentTarget,
          event.target,
          busy,
        )) onClose()
      }}
    >
      <section
        ref={dialogRef}
        className="media-library-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="media-library-title"
        aria-describedby="media-library-description"
        onKeyDown={(event) => handleModalDialogKeyDown(event, {
          busy,
          container: dialogRef.current,
          onClose,
        })}
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
              <BusyIndicator size={24} />Loading recent media…
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
                        {asset.owningBookName}
                        {asset.owningBookId === targetBookId ? ' · this book' : ' · copy'}
                      </small>
                    </span>
                    {active && (
                      <span className="media-library-asset-busy">
                        <BusyIndicator size={16} />Attaching…
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
                        aria-label={`Use @${asset.id} from ${asset.owningBookName}`}
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
              {state.loadingMore ? <BusyIndicator size={14} /> : <Plus size={14} />}
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
  const primaryCellId = useContext(PrimaryCellContext)
  const generationTitles = useContext(GenerationTitlesContext)
  const contextMenu = useContext(CellContextMenuContext)
  const updateNodeInternals = useUpdateNodeInternals()
  const primarySelected = selected && primaryCellId === id
  const mediaUrl = data.asset?.mediaUrl
  const thumbnailUrl = data.asset?.thumbnailUrl
  const targetInputs = data.targetInputs?.length ? data.targetInputs : ['input']
  const targetConnectionCount = data.targetConnectionCount ?? 0
  const targetInputConnectionCounts = data.targetInputConnectionCounts ?? {}
  const slotKind = passiveMediaKind(data.kind)
  const emptyMediaSlot = slotKind !== null && isEmptyPassiveMediaSlot(
    data.kind,
    data.outputArtifactId,
    targetConnectionCount,
  )
  const playableVideo = data.asset?.type === 'video' || data.asset?.type === 'final'
  const playableAudio = data.asset?.type === 'audio'
  const audioCell = data.kind === 'audio'
    || data.kind === 'extract_audio'
  const visualMediaCell = data.kind === 'video'
    || data.kind === 'image'
  const imageMediaCell = !playableVideo && data.kind === 'image'
  const textCell = data.kind === 'prompt' || data.kind === 'analyze'
  const isTopRow = data.slot.row === 0
  const handleLayoutSignature = [
    isTopRow ? 'top' : 'lower',
    ...targetInputs,
    '|',
    ...(data.sourcePorts ?? []),
  ].join('\u0000')
  useEffect(() => {
    updateNodeInternals(id)
  }, [handleLayoutSignature, id, updateNodeInternals])
  const action = notebookCellActionPresentation({
    type: data.kind,
    model: data.model,
    operation: data.operation,
    outputArtifactId: data.outputArtifactId,
    tool: data.tool,
  }, data.status)
  const statusLabel = notebookCellStatusLabel(data.kind, data.status)
  const generationCell = isNotebookGenerationCellType(data.kind)
  const toolTitle = generationCell && data.tool
    ? generationTitles.get(data.tool) ?? null
    : null
  const generationModelTitle = generationCell
    ? toolTitle ?? data.model ?? data.tool ?? null
    : null
  const generationMode = generationCell
    ? asString(data.inputs?.generationMode)
    : null
  const modeAbbreviation = generationMode && /^[a-z]2[a-z]$/i.test(generationMode)
    ? generationMode.toUpperCase()
    : null
  const modelLine = generationModelTitle
    ? (() => {
      const abbreviated = abbreviateGenerationPhrases(generationModelTitle)
      return modeAbbreviation
        && !abbreviated.toUpperCase().includes(modeAbbreviation)
        ? `${abbreviated} · ${modeAbbreviation}`
        : abbreviated
    })()
    : null
  const generationSettings = generationCell
    ? recordValue(data.inputs?.generationSettings)
    : null
  const aspectRatio = generationSettings
    ? asString(generationSettings.aspect_ratio)
    : null
  const generationDuration = generationSettings
    ? asString(generationSettings.duration)
      ?? asString(generationSettings.duration_seconds)
      ?? (typeof generationSettings.duration === 'number'
        ? String(generationSettings.duration)
        : null)
    : null
  const typeLabel = cellTypeLabel(data.kind)
  const denseGenerationHeader = generationCell
    && generationDuration !== null
    && aspectRatio !== null
  const visibleTypeLabel = denseGenerationHeader
    ? compactCellTypeLabel(data.kind)
    : typeLabel
  const resolvedPrompt = asString(data.inputs?.resolvedPrompt) ?? data.prompt
  const imagePrompt = imageMediaCell
    ? resolvedPrompt ?? data.asset?.prompt ?? null
    : null
  const imageToolTitle = imageMediaCell && data.tool
    ? generationTitles.get(data.tool) ?? null
    : null
  const promptCell = textCell || (generationCell && Boolean(data.prompt))
  const videoDurationLabel = data.kind === 'video'
    && data.videoDurationSeconds !== undefined
    ? formatMediaTime(data.videoDurationSeconds)
    : null
  const videoHeaderMetadata = data.kind === 'video'
    && Boolean(data.videoAspectRatio || videoDurationLabel)
  const running = notebookCellIsActiveStatus(data.status)
  const failed = data.status === 'error'
  const outputVersions = notebookOutputVersionArtifactIds(
    data.inputs,
    data.outputArtifactId,
  )
  const versionedOutput = (
    data.kind === 'audio'
    || data.kind === 'analysis'
    || data.kind === 'extract_audio'
    || (
      (data.kind === 'image' || data.kind === 'video')
      && !isImageVideoGenerationResultCell({
        type: data.kind,
        inputs: data.inputs,
      })
    )
  ) && outputVersions.length > 1
  const activeOutputVersion = Math.max(
    1,
    outputVersions.indexOf(data.outputArtifactId ?? '') + 1,
  )
  const contextMenuId = cellContextMenuId(id)
  const openContextMenu = (
    x: number,
    y: number,
    returnFocus: HTMLElement | null,
  ) => {
    contextMenu.open(id, { x, y }, returnFocus)
  }

  return (
    <article
      className={[
        'cell-node',
        `cell-kind-${data.kind}`,
        selected ? 'cell-node-selected' : '',
        primarySelected ? 'cell-node-primary' : '',
        running ? 'cell-node-running' : '',
        data.status === 'queued' ? 'cell-node-queued' : '',
        failed ? 'cell-node-error' : '',
        versionedOutput ? 'cell-node-version-stack' : '',
        data.deleting ? 'cell-node-deleting' : '',
        data.revealing ? 'cell-node-created' : '',
      ].filter(Boolean).join(' ')}
      aria-busy={running}
      data-selection={primarySelected ? 'primary' : selected ? 'selected' : undefined}
      data-version-count={outputVersions.length}
      data-cell-status={data.status}
      data-context-menu-open={contextMenu.openCellId === id ? 'true' : undefined}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
        openContextMenu(
          event.clientX,
          event.clientY,
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null,
        )
      }}
      onKeyDown={(event) => {
        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
        event.preventDefault()
        event.stopPropagation()
        const bounds = event.currentTarget.getBoundingClientRect()
        openContextMenu(
          bounds.left + Math.min(bounds.width - 12, 40),
          bounds.top + 40,
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null,
        )
      }}
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
      {targetInputs.map((input, index) => {
        const inputConnectionCount = targetInputConnectionCounts[input] ?? 0
        if (inputConnectionCount < 2) return null
        return (
          <span
            key={`${input}-count`}
            className="cell-target-connection-count"
            aria-label={`${inputConnectionCount} connections into ${input}`}
            data-connection-count={inputConnectionCount}
            style={{ left: `${((index + 1) / (targetInputs.length + 1)) * 100}%` }}
          >
            {inputConnectionCount}
          </span>
        )
      })}
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
          <span
            className="cell-node-type"
            aria-label={typeLabel}
            title={denseGenerationHeader ? typeLabel : undefined}
          >
            <CellIcon kind={data.kind} />
            <span className="cell-node-type-label" aria-hidden="true">
              {visibleTypeLabel}
            </span>
          </span>
          {generationCell && (
            <span className="cell-generation-chips">
              {generationDuration && (
                <span className="cell-aspect-ratio" title="Duration">
                  {generationDuration}
                  {/^\d+(\.\d+)?$/.test(generationDuration) ? 's' : ''}
                </span>
              )}
              {aspectRatio && (
                <span className="cell-aspect-ratio" title="Aspect ratio">
                  {aspectRatio}
                </span>
              )}
            </span>
          )}
          {videoHeaderMetadata && (
            <span className="cell-media-chips" aria-label="Video metadata">
              {videoDurationLabel && (
                <time
                  className="cell-aspect-ratio"
                  dateTime={`PT${data.videoDurationSeconds}S`}
                  title="Duration"
                >
                  {videoDurationLabel}
                </time>
              )}
              {data.videoAspectRatio && (
                <span className="cell-aspect-ratio" title="Aspect ratio">
                  {data.videoAspectRatio}
                </span>
              )}
            </span>
          )}
          {action && !generationCell && (
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
          {!action && !videoHeaderMetadata && versionedOutput && (
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
              || (data.kind === 'extract_audio' && data.outputArtifactId)
              ? <AudioCellSummary data={data} />
              : <span>{emptyCellLabel(data)}</span>}
          </div>
        ) : visualMediaCell && (mediaUrl || thumbnailUrl) ? (
          <div className="cell-media" title={imagePrompt ?? undefined}>
            {playableVideo && mediaUrl ? (
              <video src={mediaUrl} poster={thumbnailUrl ?? undefined} muted playsInline preload="metadata" />
            ) : (
              <img src={thumbnailUrl ?? mediaUrl ?? ''} alt={data.label ?? notebookGridTag(data.slot)} />
            )}
            {imageMediaCell ? (
              <ImageCardMetadataBadges
                width={data.asset?.width ?? null}
                height={data.asset?.height ?? null}
                tool={imageToolTitle}
                model={data.model ?? data.tool ?? null}
                prompt={imagePrompt}
                provenance={data.frameProvenance
                  ? [
                      data.frameProvenance.sourceAddress,
                      data.frameProvenance.atSeconds === null
                        ? null
                        : formatMediaTime(data.frameProvenance.atSeconds),
                    ].filter(Boolean).join(' · ') || null
                  : null}
              />
            ) : data.kind !== 'video' && (
              <NotebookMediaMetadata
                className="cell-media-metadata"
                width={data.asset?.width ?? null}
                height={data.asset?.height ?? null}
                durationSeconds={playableVideo ? data.asset?.duration ?? null : null}
              />
            )}
          </div>
        ) : (
          <div className={`cell-copy ${promptCell ? 'cell-copy-text' : ''}`}>
            {modelLine && <span className="cell-model-line">{modelLine}</span>}
            {promptCell ? <p>{data.prompt || emptyCellLabel(data)}</p> : <Sparkles size={28} />}
            {!promptCell && (
              <span>{modelLine ? 'Add a prompt' : emptyCellLabel(data)}</span>
            )}
          </div>
        )}
        <footer className="cell-node-footer">
          <strong>{notebookGridTag(data.slot)}</strong>
          <span className="cell-node-footer-actions">
            <CellStatusBadge status={statusLabel} />
            <button
              type="button"
              className="cell-context-menu-trigger nodrag"
              aria-label={`Open ${notebookGridTag(data.slot)} cell menu`}
              aria-haspopup="menu"
              aria-expanded={contextMenu.openCellId === id}
              aria-controls={contextMenuId}
              title="Cell actions"
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                const bounds = event.currentTarget.getBoundingClientRect()
                openContextMenu(
                  bounds.right - 4,
                  bounds.bottom + 4,
                  event.currentTarget,
                )
              }}
            >
              <Ellipsis size={16} aria-hidden="true" />
            </button>
          </span>
        </footer>
        <CellStateOverlay
          kind={data.kind}
          address={notebookGridAddress(data.slot)}
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
const notebookDefaultEdgeOptions = { selectable: false }
const notebookMultiSelectionKeys = ['Shift', 'Control', 'Meta']
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
    reconnectDelayMs: 3000,
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
  const generationTitleByTool = useMemo(
    () => new Map(generationActions.map((action) => [action.tool, action.title])),
    [generationActions],
  )
  const [providers, setProviders] = useState<ProviderRecord[]>([])
  const [storage, setStorage] = useState<unknown>(null)
  const { lastWorkSlot, rememberLastWorkSlot } = useLastWorkSlot(
    bookId,
    notebook?.id ?? null,
  )
  const [selectedCellId, setSelectedCellId] = useState<string | null>(null)
  const [selectedCellIds, setSelectedCellIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  )
  const [cellContextMenu, setCellContextMenu] = useState<CellContextMenuState | null>(null)
  const [queuedCellIds, setQueuedCellIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  )
  const [revealingCellIds, setRevealingCellIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  )
  const [deletingCellIds, setDeletingCellIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  )
  const [mediaSlotStates, setMediaSlotStates] = useState<Record<string, MediaSlotState>>({})
  const [mediaInsightWork, setMediaInsightWork] = useState<
    Record<string, MediaInsightWork>
  >({})
  const [cellRunErrors, setCellRunErrors] = useState<Record<string, string>>({})
  const [mediaLibraryPicker, setMediaLibraryPicker] = useState<MediaLibraryPickerState | null>(null)
  const mediaLibraryReference = useSearchReferenceLifecycle()
  const [pendingWatermarkReview, setPendingWatermarkReview] =
    useState<WatermarkReviewState | null>(null)
  const momentSearchRef = useRef<MomentSearchHandle | null>(null)
  const [mediaFullscreen, setMediaFullscreen] = useState<MediaFullscreenSession | null>(null)
  const [mediaFullscreenComposerTarget, setMediaFullscreenComposerTarget] =
    useState<HTMLDivElement | null>(null)
  const [mediaFullscreenSelectedSubjectIds, setMediaFullscreenSelectedSubjectIds] =
    useState<readonly string[]>([])
  const [mediaFullscreenComposerSending, setMediaFullscreenComposerSending] =
    useState(false)
  const [mediaFullscreenSidebarEditing, setMediaFullscreenSidebarEditing] =
    useState(false)
  const [previewSlot, setPreviewSlot] = useState<NotebookGridSlot | null>(null)
  const [mediaDropActive, setMediaDropActive] = useState(false)
  const [mediaDropSlot, setMediaDropSlot] = useState<NotebookGridSlot | null>(null)
  const [notebookView, setNotebookView] = useState({ y: 0, zoom: 1 })
  const [notebookSurface, setNotebookSurface] = useState({ width: 0, height: 0 })
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [sourceViewCellId, setSourceViewCellId] = useState<string | null>(null)
  const [generationsViewCellId, setGenerationsViewCellId] = useState<string | null>(null)
  const [generationsState, setGenerationsState] = useState<{
    cellId: string
    loading: boolean
    error: string | null
    attempts: CellGenerationAttempt[]
    currentExecution: NotebookCellExecution | null
  } | null>(null)
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
  const [importUrl, setImportUrl] = useState('')
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
  const mediaLibraryRequestRef = useRef(0)
  const imageSubjectMapRequestRef = useRef(0)
  const bookDataRequestRef = useRef(0)
  const mediaLibraryOpenerRef = useRef<HTMLElement | null>(null)
  const activeWatchesRef = useRef(new Map<string, string>())
  const activeMcpCallsRef = useRef(new Map<number, { tool: string; startedAt: number }>())
  const mcpActivitySequenceRef = useRef(0)
  const mcpActivityTimerRef = useRef(0)
  const selectedCellIdsRef = useRef<ReadonlySet<string>>(new Set())
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
  const pendingChangeSpeedPreview = useMemo(() => {
    if (pendingChatAction?.kind !== 'routed') return null
    const plan = pendingChatAction.plan
    if (plan.routedTool !== 'change_video_speed') return null
    const assetId = asString(plan.params.asset_id)
    const mention = assetId
      ? commandMentionAssets.find((candidate) => candidate.artifactId === assetId)
      : undefined
    const asset = assetId ? assetById.get(assetId) : undefined
    const sourceDuration = asNumber(asset?.duration) ?? asNumber(mention?.duration)
    const requestedSpeed = asNumber(plan.params.speed)
    const targetDuration = asNumber(plan.params.target_duration_seconds)
    const effectiveSpeed = requestedSpeed
      ?? (sourceDuration && targetDuration && targetDuration > 0
        ? sourceDuration / targetDuration
        : null)
    const mediaUrl = asset?.mediaUrl ?? null
    const mediaType = asset?.type ?? mention?.type ?? null
    return {
      mediaUrl,
      thumbnailUrl: asset?.thumbnailUrl ?? null,
      unavailableReason: mediaType !== null && mediaType !== 'video'
        ? 'the selected source is not a video'
        : mediaUrl === null
          ? 'the source media is not loaded yet'
          : null,
      sourceDurationSeconds: sourceDuration && sourceDuration > 0 ? sourceDuration : null,
      effectiveSpeed: effectiveSpeed && effectiveSpeed > 0 ? effectiveSpeed : null,
    }
  }, [assetById, commandMentionAssets, pendingChatAction])
  const pendingRoutedActionReview = pendingChatAction?.kind === 'routed'
    ? routedActionReview({
        input: pendingChatAction.plan.prompt,
        params: pendingChatAction.plan.params,
        tool: pendingChatAction.plan.routedTool,
        sourceDurationSeconds: pendingChangeSpeedPreview?.sourceDurationSeconds ?? null,
      })
    : null
  const pendingXPostPreview = useMemo(() => {
    if (pendingChatAction?.kind !== 'routed') return null
    const plan = pendingChatAction.plan
    if (plan.tool !== 'post' && plan.routedTool !== 'post') return null
    const rawReference = asString(plan.params.asset_id)?.trim() ?? ''
    const reference = rawReference.replace(/^@/, '')
    const mention = commandMentionAssets.find((candidate) =>
      candidate.artifactId === reference
      || candidate.cellAddress.toLowerCase() === reference.toLowerCase())
    const asset = assetById.get(mention?.artifactId ?? reference) ?? mention ?? null
    return {
      asset,
      postText: pendingRoutedActionReview?.postText ?? '',
      sourceLabel: mention
        ? `@${mention.cellAddress}`
        : rawReference.startsWith('@')
          ? rawReference
          : reference
            ? `@${reference}`
            : 'Selected media',
    }
  }, [assetById, commandMentionAssets, pendingChatAction, pendingRoutedActionReview])
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
            address: notebookGridAddress(cell.slot),
            type: cell.type,
            asset: cell.outputArtifactId
              ? assetById.get(cell.outputArtifactId) ?? null
              : null,
          }]
        })
      : [],
    [assetById, notebook, pendingGenerationDraft],
  )
  const pendingGenerationSourceOptions = useMemo<GenerationReviewSource[]>(
    () => pendingGenerationDraft && notebook
      ? notebookChatGenerationSourceOptions(
          notebook,
          pendingGenerationDraft.sourceCellIds,
        ).map(({ cell }) => ({
          cellId: cell.id,
          address: notebookGridAddress(cell.slot),
          type: cell.type,
          asset: cell.outputArtifactId
            ? assetById.get(cell.outputArtifactId) ?? null
            : null,
        }))
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
  const generationPlans = useMemo(
    () => asGenerationPlans(notebook?.generationPlans),
    [notebook],
  )
  const activeSequenceRange = useMemo(() => {
    const startFrame = Number(timelineSelectionStart)
    const durationFrames = Number(timelineSelectionDuration)
    return Number.isSafeInteger(startFrame)
      && startFrame >= 0
      && Number.isSafeInteger(durationFrames)
      && durationFrames > 0
      ? { startFrame, durationFrames }
      : null
  }, [timelineSelectionDuration, timelineSelectionStart])
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

  const updateSelectedCellIds = useCallback((next: ReadonlySet<string>) => {
    const current = selectedCellIdsRef.current
    if (
      current.size === next.size
      && [...next].every((cellId) => current.has(cellId))
    ) return
    selectedCellIdsRef.current = next
    setSelectedCellIds(next)
  }, [])

  const selectCanvasCell = useCallback((cellId: string | null) => {
    setSelectedCellId(cellId)
    updateSelectedCellIds(cellId ? new Set([cellId]) : new Set())
    if (!cellId) return
    const fromNotebook = notebook?.cells.find((cell) => cell.id === cellId)
    if (fromNotebook) {
      rememberLastWorkSlot(fromNotebook.slot)
      return
    }
    const fromNode = nodes.find((node) => node.id === cellId)
    if (fromNode) rememberLastWorkSlot(fromNode.data.slot)
  }, [notebook, nodes, rememberLastWorkSlot, updateSelectedCellIds])

  const closeCellContextMenu = useCallback(() => {
    setCellContextMenu(null)
  }, [])

  const openCellContextMenu = useCallback((
    cellId: string,
    position: { x: number; y: number },
    returnFocus: HTMLElement | null,
  ) => {
    selectCanvasCell(cellId)
    setCellContextMenu({ cellId, position, returnFocus })
  }, [selectCanvasCell])

  const cellContextMenuContextValue = useMemo<CellContextMenuContextValue>(() => ({
    openCellId: cellContextMenu?.cellId ?? null,
    open: openCellContextMenu,
  }), [cellContextMenu?.cellId, openCellContextMenu])

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
    updateSelectedCellIds(new Set(
      [...selectedCellIdsRef.current].filter((cellId) => cellIds.has(cellId)),
    ))
    setMediaLibraryPicker((current) =>
      current && cellIds.has(current.cellId) ? current : null)
    setCellContextMenu((current) =>
      current && cellIds.has(current.cellId) ? current : null)
    setNodes((current) =>
      reconcileCanvasNodes(current, canvasNodes(next, nextAssets, nextJobs)))
    setEdges((current) => reconcileFlowEdges(current, notebookEdges(next)))
    setSelectedCellId((current) =>
      current && next.cells.some((cell) => cell.id === current) ? current : null)
    setSourceViewCellId((current) =>
      current && cellIds.has(current) ? current : null)
  }, [updateSelectedCellIds])

  const watchNotebookRun = useCallback(async (params: {
    bookId: string
    notebookId: string
    cellId: string
    address: string
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
            address: params.address,
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
                `Lost contact with the server while watching @${params.address}: ${detail}`,
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
    address: string
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
        setNotice(`@${params.address} generated`)
        setCellRunError(params.cellId, null)
        return
      }
      if (outcome.kind === 'failed') {
        const message = outcome.message ?? `@${params.address} failed`
        setCellRunError(params.cellId, message)
        setNotice(message, 'error')
        return
      }
      if (outcome.kind === 'timeout') {
        setNotice(
          `@${params.address} is still running — check the Jobs screen`,
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

  const watchMediaAsset = useCallback(async (params: {
    bookId: string
    notebookId: string
    cellId: string
    address: string
    artifactId: string
    intervalMs?: number
    tokenPrefix?: string
    completedNotice?: string
    stillWorkingNotice?: string
  }) => {
    const intervalMs = params.intervalMs ?? downloadWatchIntervalMs
    const token = `${params.tokenPrefix ?? 'media'}:${params.artifactId}`
    activeWatchesRef.current.set(params.cellId, token)
    let watchedArtifactId = params.artifactId
    let consecutiveFailures = 0
    const deadline = Date.now() + mediaAssetWatchTimeoutMs
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
          if (!cell || cell.outputArtifactId !== watchedArtifactId) return
          const nextAssets = asAssets(assetValue)
          const nextJobs = asJobs(jobValue)
          if (fetchedAt >= watchSnapshotClockRef.current) {
            watchSnapshotClockRef.current = fetchedAt
            setAssets((current) =>
              jsonEqual(current, nextAssets) ? current : nextAssets)
            applyJobsSnapshot(nextJobs)
            applyNotebook(nextNotebook, nextAssets, nextJobs)
          }
          const step = mediaAssetWatchStep(
            watchedArtifactId,
            nextAssets.find((asset) => asset.artifactId === watchedArtifactId),
            nextJobs,
          )
          if (step.kind === 'redirected') {
            const replacement = nextAssets.find((asset) =>
              asset.artifactId === step.artifactId)
            const replacementKind = replacement
              ? passiveMediaKindForAsset(replacement.type)
              : null
            if (!replacement || !replacementKind) {
              await delay(intervalMs)
              continue
            }
            await callRef.current('update_notebook_cell', {
              book_id: params.bookId,
              notebook_id: params.notebookId,
              cell_id: params.cellId,
              cell: {
                type: replacementKind,
                output_artifact_id: replacement.artifactId,
              },
            }, { background: true })
            watchedArtifactId = replacement.artifactId
            setCellRunError(params.cellId, null)
            continue
          }
          if (step.kind === 'completed') {
            setCellRunError(params.cellId, null)
            if (params.completedNotice) setNotice(params.completedNotice)
            return
          }
          if (step.kind === 'failed') {
            setCellRunError(params.cellId, step.message)
            setNotice(step.message, 'error')
            return
          }
          await delay(intervalMs)
        } catch (error) {
          consecutiveFailures += 1
          if (consecutiveFailures >= 10) {
            const detail = error instanceof Error ? error.message : String(error)
            setNotice(
              `Stopped watching @${params.address}: ${detail}. Check the Jobs screen.`,
              'error',
            )
            return
          }
          await delay(intervalMs)
        }
      }
      setNotice(
        params.stillWorkingNotice
          ?? `@${params.address} is still processing — check the Jobs screen`,
      )
    } finally {
      if (activeWatchesRef.current.get(params.cellId) === token) {
        activeWatchesRef.current.delete(params.cellId)
      }
    }
  }, [applyJobsSnapshot, applyNotebook, setCellRunError, setNotice])

  const watchDownloadedAsset = useCallback(async (params: {
    bookId: string
    notebookId: string
    cellId: string
    address: string
    artifactId: string
  }) => {
    await watchMediaAsset({
      ...params,
      tokenPrefix: 'download',
      intervalMs: downloadWatchIntervalMs,
      completedNotice: `@${params.address} downloaded`,
      stillWorkingNotice:
        `@${params.address} is still downloading — check the Jobs screen`,
    })
  }, [watchMediaAsset])

  const watchUploadedMediaAsset = useCallback(async (params: {
    bookId: string
    notebookId: string
    cellId: string
    address: string
    artifactId: string
  }) => {
    await watchMediaAsset({
      ...params,
      tokenPrefix: 'process',
      intervalMs: mediaProcessWatchIntervalMs,
      stillWorkingNotice:
        `@${params.address} is still processing — check the Jobs screen`,
    })
  }, [watchMediaAsset])

  const resumeMediaProcessingWatches = useCallback((
    targetBookId: string,
    document: NotebookDocument,
    nextAssets: AssetRecord[],
  ) => {
    const byArtifactId = new Map(
      nextAssets.map((asset) => [asset.artifactId, asset]),
    )
    for (const cell of document.cells) {
      if (!passiveMediaKind(cell.type) || !cell.outputArtifactId) continue
      const asset = byArtifactId.get(cell.outputArtifactId)
      if (!asset || asset.status === 'ready' || asset.status === 'error') continue
      if (activeWatchesRef.current.has(cell.id)) continue
      void watchUploadedMediaAsset({
        bookId: targetBookId,
        notebookId: document.id,
        cellId: cell.id,
        address: notebookGridAddress(cell.slot),
        artifactId: cell.outputArtifactId,
      })
    }
  }, [watchUploadedMediaAsset])

  const mediaResumeSeedRef = useRef(false)
  useEffect(() => {
    if (mediaResumeSeedRef.current || !bookId || !notebook) return
    mediaResumeSeedRef.current = true
    resumeMediaProcessingWatches(bookId, notebook, assets)
  }, [assets, bookId, notebook, resumeMediaProcessingWatches])

  const runCell = useCallback(async (
    cellId: string,
    providedNotebook?: NotebookSnapshot,
  ) => {
    if (!bookId || !notebook) return
    let generationWatchStarted = false
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
      const requiresCloudConsent = notebookCellRequiresCloudGenerationConsent(cell)
      if (requiresCloudConsent && !online) {
        throw new Error(
          'Offline: cloud generation is unavailable. '
          + 'Local search, editing, playback, and export remain available.',
        )
      }
      if (requiresCloudConsent) {
        if (notebookCellSupportsGenerateCellCommand(cell)) {
          const plan = await createGenerationPlan(cellId, 'ui')
          const stage = plan.stages.find((candidate) =>
            candidate.kind === 'queued'
            && candidate.jobType === 'generation'
            && candidate.tool === 'run_notebook_cell'
            && candidate.input.cell_id === cellId)
          if (stage?.kind !== 'queued') {
            throw new Error('The generation plan is missing its notebook cell')
          }
          const plannedNotebookId = asString(stage.input.notebook_id)
          if (plannedNotebookId !== currentNotebook.id) {
            throw new Error('The generation plan belongs to another notebook')
          }
          if (!acceptCloudGenerationConsent(stage)) {
            throw new Error('Cloud generation cancelled before sending data')
          }
          setPendingChatAction(null)
          setPendingCommandPlan(null)
          const accepted = await startNotebookCellRun({
            start: () => call('run_notebook_cell', {
              book_id: bookId,
              notebook_id: plannedNotebookId,
              cell_id: cellId,
              plan,
              actor: 'videobook-user',
            }),
            onStarting: () => setCellQueued(cellId, true),
            onAccepted: () => setCellQueued(cellId, false),
            onRejected: () => setCellQueued(cellId, false),
          })
          const acceptedRecord = recordValue(accepted)
          const runId = asString(acceptedRecord?.run_id)
          const jobOperationId = asString(acceptedRecord?.job_id)
          const outputCellId = asString(acceptedRecord?.output_cell_id)
          if (!runId || !jobOperationId) {
            setCellQueued(cellId, false)
            throw new Error('The server did not return a notebook run')
          }
          generationWatchStarted = true
          const watchCellId = outputCellId ?? cellId
          let address = notebookGridAddress(cell.slot)
          if (outputCellId) {
            const notebookValue = await call('get_notebook', {
              book_id: bookId,
              notebook_id: plannedNotebookId,
            }, { background: true })
            const nextNotebook = asNotebook(notebookValue)
            if (nextNotebook) {
              applyNotebook(nextNotebook, assets, jobs)
              const output = nextNotebook.cells.find((candidate) =>
                candidate.id === outputCellId)
              if (output) address = notebookGridAddress(output.slot)
            }
            revealCells([outputCellId])
            setCellQueued(outputCellId, true)
            if (selectedCellIdsRef.current.has(cellId)) {
              selectCanvasCell(outputCellId)
            }
          }
          setNotice(`${notebookGridTag(cell.slot)} queued`)
          void watchGenerationRun({
            bookId,
            notebookId: plannedNotebookId,
            cellId: watchCellId,
            address,
            runId,
            jobOperationId,
          })
          return {
            ok: true,
            message: `${notebookGridTag(cell.slot)} queued`,
          }
        }
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
      const runId = asString(recordValue(accepted)?.run_id)
      const jobOperationId = asString(recordValue(accepted)?.job_id)
      if (!runId || !jobOperationId) {
        throw new Error('The server did not return a notebook run')
      }
      setNotice(`${notebookGridTag(cell.slot)} queued`)
      const outcome = await watchNotebookRun({
        bookId,
        notebookId: currentNotebook.id,
        cellId,
        address: notebookGridAddress(cell.slot),
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
      if (!generationWatchStarted) setCellQueued(cellId, false)
      setBusy(false)
    }
  }, [
    applyNotebook,
    assets,
    bookId,
    call,
    createGenerationPlan,
    jobs,
    notebook,
    online,
    prepareGenerationPlan,
    revealCells,
    selectCanvasCell,
    setCellQueued,
    setCellRunError,
    setNotice,
    watchGenerationRun,
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
  const canvasPresentationNodes = useMemo(() => presentedNodes.map((node) => {
    const selected = selectedCellIds.has(node.id)
    return node.selected === selected ? node : { ...node, selected }
  }), [presentedNodes, selectedCellIds])
  const focusedEdges = useMemo(
    () => notebookEdgesWithCellFocus(edges, selectedCellId),
    [edges, selectedCellId],
  )
  const notebookOccupiedSlots = useMemo(
    () => nodes.map((node) => node.data.slot),
    [nodes],
  )
  const notebookBaseMetrics = useMemo(
    () => notebookGridMetrics(
      notebookOccupiedSlots,
      {
        viewportWidth: notebookSurface.width,
        viewportHeight: notebookSurface.height,
        zoom: notebookView.zoom,
      },
    ),
    [
      notebookOccupiedSlots,
      notebookSurface.height,
      notebookSurface.width,
      notebookView.zoom,
    ],
  )
  const notebookMetrics = useMemo(
    () => previewSlot
      ? notebookGridMetrics(
          notebookOccupiedSlots,
          {
            preview: previewSlot,
            viewportWidth: notebookSurface.width,
            viewportHeight: notebookSurface.height,
            zoom: notebookView.zoom,
          },
        )
      : notebookBaseMetrics,
    [
      notebookOccupiedSlots,
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
    setPendingWatermarkReview(null)
    focusCommandComposer()
  }, [focusCommandComposer])
  const updatePendingSplitSelection = useCallback((next: {
    cutPointsSeconds: number[]
    outputMode: NotebookSplitOutputMode
    selectedIndex: number
  }) => {
    setPendingChatAction((current) => {
      if (current?.kind !== 'split') return current
      const sourceAddress = current.expectations[0]?.address ?? 'video'
      const command: NotebookSplitCommand = {
        ...current.command,
        cutPointsSeconds: next.cutPointsSeconds,
        outputMode: next.outputMode,
        selectedChunkIndexes: [next.selectedIndex],
      }
      return {
        ...current,
        command,
        summary: notebookSplitSummary({
          cutPointsSeconds: command.cutPointsSeconds,
          outputMode: command.outputMode,
          selectedChunkIndexes: command.selectedChunkIndexes,
          sourceAddress,
          sourceDurationSeconds: current.sourceDurationSeconds,
        }),
      }
    })
  }, [])
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
        ...(draft.cell.label === undefined ? {} : { label: draft.cell.label }),
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
    selectCanvasCell(cellId)
    setInspectorOpen(true)
  }, [selectCanvasCell])
  const updatePendingGenerationSources = useCallback((sourceCellIds: string[]) => {
    if (!pendingGenerationDraft || !notebook) return
    let next: NotebookChatGenerationDraft
    try {
      next = reviseNotebookChatGenerationSources({
        actions: generationActions,
        draft: pendingGenerationDraft,
        document: notebook,
        sourceCellIds,
      })
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error), 'error')
      return
    }
    const expectations: NotebookAddressExpectation[] = [
      ...next.sourceCellIds.flatMap((cellId) => {
        const cell = notebook.cells.find((candidate) => candidate.id === cellId)
        return cell ? [{ address: notebookGridTag(cell.slot), cellId: cell.id }] : []
      }),
      { address: notebookGridTag(next.cell.slot), cellId: null },
    ]
    const references = next.sourceAddresses.length > 0
      ? ` from ${next.sourceAddresses.join(', ')}`
      : ''
    setPendingChatAction((current) => current?.kind === 'generation'
      && current.draft.cell.id === next.cell.id
      ? {
          ...current,
          draft: next,
          expectations,
          previewError: null,
          previewLoading: false,
          previewStale: true,
          summary: `Generate ${generationMediaKind(
            next.cell.type as NotebookChatGenerationCommand['cellType'],
          )} as ${notebookGridTag(next.cell.slot)}${references}`,
        }
      : current)
    requestPendingGenerationPreview(next, notebook)
  }, [
    generationActions,
    notebook,
    pendingGenerationDraft,
    requestPendingGenerationPreview,
    setNotice,
  ])
  const addPendingGenerationSource = useCallback((cellId: string) => {
    if (!pendingGenerationDraft) return
    updatePendingGenerationSources([...pendingGenerationDraft.sourceCellIds, cellId])
  }, [pendingGenerationDraft, updatePendingGenerationSources])
  const removePendingGenerationSource = useCallback((cellId: string) => {
    if (!pendingGenerationDraft) return
    updatePendingGenerationSources(
      pendingGenerationDraft.sourceCellIds.filter((id) => id !== cellId),
    )
  }, [pendingGenerationDraft, updatePendingGenerationSources])

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
  const selectedNotebookCells = useMemo(() => (notebook?.cells ?? [])
    .filter((cell) => selectedCellIds.has(cell.id))
    .sort((left, right) =>
      left.slot.row - right.slot.row || left.slot.column - right.slot.column), [
    notebook,
    selectedCellIds,
  ])
  const notebookCellAssets = useMemo(
    () => new Map((notebook?.cells ?? []).flatMap((cell) => {
      const cellAsset = artifactForCell(assetById, cell.outputArtifactId)
      return cellAsset ? [[cell.id, cellAsset] as const] : []
    })),
    [assetById, notebook],
  )
  const notebookVideoCellIds = useMemo(
    () => new Set([...notebookCellAssets].flatMap(([cellId, cellAsset]) =>
      cellAsset.type === 'video' || cellAsset.type === 'final' ? [cellId] : [])),
    [notebookCellAssets],
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
        && selectedNotebookCell.type !== 'video'
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
  const selectedSplitSource = useMemo(() => {
    if (!notebook || !selectedNotebookCell) return null
    try {
      const source = resolveNotebookVideoSourceCell(notebook, selectedNotebookCell.id)
      const artifactId = resolveGeneratedVideoArtifact(notebook, source)
      const asset = artifactId ? assetById.get(artifactId) : undefined
      const duration = asset?.duration ?? asNumber(source.inputs?.durationSeconds)
      if (!asset?.mediaUrl || !duration || duration < 1) return null
      return { source, asset, duration }
    } catch {
      return null
    }
  }, [assetById, notebook, selectedNotebookCell])
  const pendingSplitReview = useMemo(() => {
    if (!notebook || pendingChatAction?.kind !== 'split') return null
    try {
      const source = resolveNotebookVideoSourceCell(
        notebook,
        pendingChatAction.command.sourceReference,
      )
      const artifactId = resolveGeneratedVideoArtifact(notebook, source)
      const asset = artifactId ? assetById.get(artifactId) : undefined
      const duration = asset?.duration ?? asNumber(source.inputs?.durationSeconds)
      if (!asset?.mediaUrl || !duration || duration < 1) return null
      const maximumCellCount = notebookGrid.maximumRowCount
        * notebookGrid.columnCount
      return {
        availableEmptyCells: Math.max(0, maximumCellCount - notebook.cells.length),
        cutPointsSeconds: pendingChatAction.command.cutPointsSeconds,
        mediaUrl: asset.mediaUrl,
        outputMode: pendingChatAction.command.outputMode ?? 'all',
        selectedIndex: pendingChatAction.command.selectedChunkIndexes?.[0] ?? 0,
        sourceDurationSeconds: duration,
        sourceFps: asset.fps,
        sourceLabel: notebookGridTag(source.slot),
      }
    } catch {
      return null
    }
  }, [assetById, notebook, pendingChatAction])
  const selectedMediaSlotState = selectedNotebookCell
    ? mediaSlotStates[selectedNotebookCell.id]
    : undefined
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

  const loadGenerationPayload = useCallback(async (assetId: string) => {
    if (!bookId) throw new Error('Book is not ready')
    const value = await call('inspect_generation_request', {
      book_id: bookId,
      asset_id: assetId,
    }, { background: true })
    const data = value as { payload?: unknown }
    if (data.payload == null) {
      throw new Error('No generation payload recorded for this attempt')
    }
    return data.payload
  }, [bookId, call])

  const updateMediaInsightWork = useCallback((
    artifactId: string,
    patch: Partial<MediaInsightWork>,
  ) => {
    setMediaInsightWork((current) => ({
      ...current,
      [artifactId]: {
        ...(current[artifactId] ?? idleMediaInsightWork),
        ...patch,
      },
    }))
  }, [])

  const watchAssetInsight = useCallback(async (params: {
    bookId: string
    notebookId: string
    artifactId: string
    insight: MediaInsightKind
    since: number
    hadInsight: boolean
  }): Promise<MediaInsightWatchStep> => {
    const deadline = Date.now() + mediaInsightWatchTimeoutMs
    while (Date.now() < deadline) {
      await delay(mediaInsightWatchIntervalMs)
      const scope = watchScopeRef.current
      if (
        scope.bookId !== params.bookId
        || scope.notebookId !== params.notebookId
      ) {
        return { kind: 'continue' }
      }
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
      const nextNotebook = asNotebook(notebookValue)
      const nextAssets = asAssets(assetValue)
      const nextJobs = asJobs(jobValue)
      if (nextNotebook && fetchedAt >= watchSnapshotClockRef.current) {
        watchSnapshotClockRef.current = fetchedAt
        setAssets((current) =>
          jsonEqual(current, nextAssets) ? current : nextAssets)
        applyJobsSnapshot(nextJobs)
        applyNotebook(nextNotebook, nextAssets, nextJobs)
      }
      const asset = nextAssets.find((candidate) =>
        candidate.artifactId === params.artifactId)
      const step = mediaInsightWatchStep({
        insight: params.insight,
        artifactId: params.artifactId,
        since: params.since,
        hasInsight: assetHasInsight(asset, params.insight),
        hadInsight: params.hadInsight,
        jobs: nextJobs,
      })
      if (step.kind !== 'continue') return step
    }
    return {
      kind: 'failed',
      message: params.insight === 'transcript'
        ? 'Transcription did not finish in time. Check the jobs screen.'
        : 'Video analysis did not finish in time. Check the jobs screen.',
    }
  }, [applyJobsSnapshot, applyNotebook])

  const runAssetInsight = useCallback(async (
    artifactId: string,
    insight: MediaInsightKind,
  ) => {
    const notebookId = notebook?.id
    if (!bookId || !notebookId) return
    const work = mediaInsightWork[artifactId] ?? idleMediaInsightWork
    if (mediaInsightIsRunning(work, insight)) return
    const hadInsight = assetHasInsight(
      watchScopeRef.current.assets.find((candidate) =>
        candidate.artifactId === artifactId),
      insight,
    )
    const since = Date.now()
    updateMediaInsightWork(artifactId, {
      ...mediaInsightRunningPatch(insight, true),
      error: null,
    })
    try {
      await call(
        insight === 'transcript' ? 'transcribe' : 'analyze_video',
        insight === 'transcript'
          ? { book_id: bookId, asset_id: artifactId }
          : { book_id: bookId, asset_id: artifactId, force: hadInsight },
        { background: true },
      )
      const step = await watchAssetInsight({
        bookId,
        notebookId,
        artifactId,
        insight,
        since,
        hadInsight,
      })
      updateMediaInsightWork(artifactId, {
        ...mediaInsightRunningPatch(insight, false),
        error: step.kind === 'failed' ? step.message : null,
      })
    } catch (error) {
      updateMediaInsightWork(artifactId, {
        ...mediaInsightRunningPatch(insight, false),
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }, [
    bookId,
    call,
    mediaInsightWork,
    notebook,
    updateMediaInsightWork,
    watchAssetInsight,
  ])

  const transcribeAsset = useCallback((artifactId: string) => {
    void runAssetInsight(artifactId, 'transcript')
  }, [runAssetInsight])

  const loadTranscriptJson = useCallback(async (
    artifactId: string,
    source: TranscriptSidecarSource,
  ) => {
    if (!bookId) throw new Error('Book is not ready')
    const value = await call('read_transcript', {
      book_id: bookId,
      asset_id: artifactId,
      raw: true,
      source,
    }, { background: true })
    const item = recordValue(value)
    const text = typeof item?.text === 'string' ? item.text : null
    const file = asString(item?.file)
    if (!text || !file) throw new Error('No transcript sidecar for this asset')
    return { text, file }
  }, [bookId, call])

  const exportTranscriptSrt = useCallback((artifactId: string) => {
    if (!bookId) return
    void call('export_transcript_srt', {
      book_id: bookId,
      asset_id: artifactId,
    }).then((value) => {
      const item = recordValue(value)
      const path = asString(item?.path)
      setNotice(path ? `Saved ${path}` : 'Saved SRT to Downloads')
    }).catch((error: unknown) => {
      setNotice(error instanceof Error ? error.message : String(error), 'error')
    })
  }, [bookId, call, setNotice])

  const refreshNotebook = useCallback(async (targetBookId: string, notebookId: string) => {
    const value = await call('get_notebook', {
      book_id: targetBookId,
      notebook_id: notebookId,
    })
    const next = asNotebook(value)
    if (!next) throw new Error('The server returned an invalid notebook')
    applyNotebook(next, assets, jobs)
    return next
  }, [applyNotebook, assets, call, jobs])

  const refreshBookData = useCallback(async (targetBookId: string, preferredNotebookId?: string) => {
    const requestId = bookDataRequestRef.current + 1
    bookDataRequestRef.current = requestId
    const response = await guardedAsyncResult(
      async () => await Promise.all([
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
      ]),
      () => bookDataRequestRef.current === requestId,
    )
    if (response.kind === 'stale') return
    if (response.kind === 'error') throw response.error
    const [
      notebookValue,
      assetValue,
      sequenceValue,
      jobValue,
      ingestStatusValue,
      actionValue,
    ] = response.value
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
      setNodes([])
      setEdges([])
      return
    }
    saveValue(`videobook.active-notebook:${targetBookId}`, nextNotebook.id)
    applyNotebook(nextNotebook, nextAssets, nextJobs)
    resumeMediaProcessingWatches(targetBookId, nextNotebook, nextAssets)
  }, [applyNotebook, call, resumeMediaProcessingWatches])

  const updateFullscreenSubjectMap = useCallback((
    key: string,
    subjectMap: ImageSubjectMap,
    subjectMapLoading = false,
  ) => {
    setMediaFullscreen((current) => current?.key === key
      ? { ...current, subjectMap, subjectMapLoading }
      : current)
  }, [])

  const watchImageSubjectMap = useCallback(async (
    session: MediaFullscreenSession,
    requestId: number,
    initialMap: ImageSubjectMap,
  ) => {
    const result = await pollImageSubjectMap({
      initialMap,
      read: async () => imageSubjectMapForSession(
        session,
        await call('get_image_subject_map', {
          book_id: session.bookId,
          artifact_id: session.asset.artifactId,
          object_hash: session.asset.objectHash,
        }, { background: true }),
      ),
      publish: (subjectMap) => updateFullscreenSubjectMap(session.key, subjectMap),
      isCurrent: () => imageSubjectMapRequestRef.current === requestId,
    })
    if (
      result.kind === 'stale'
      || result.kind === 'terminal'
      || imageSubjectMapRequestRef.current !== requestId
    ) return
    updateFullscreenSubjectMap(
      session.key,
      failedImageSubjectMap(
        session,
        result.kind === 'timeout'
          ? new Error(
              'Subject analysis did not finish within 27 minutes. Retry to check or restart it.',
            )
          : result.error,
        result.map,
      ),
    )
  }, [call, updateFullscreenSubjectMap])

  const openMediaFullscreen = useCallback((
    cell: NotebookDocument['cells'][number],
    asset: NotebookCellInspectorAsset,
    returnFocus?: HTMLElement | null,
  ) => {
    if (!bookId || !notebook) return
    const session: MediaFullscreenSession = {
      key: [bookId, notebook.id, cell.id, asset.artifactId, asset.objectHash].join(':'),
      bookId,
      notebookId: notebook.id,
      cellId: cell.id,
      address: notebookGridAddress(cell.slot),
      asset,
      returnFocus: returnFocus
        ?? (document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null),
      subjectMap: null,
      subjectMapLoading: asset.type === 'image' && Boolean(asset.objectHash),
    }
    const requestId = imageSubjectMapRequestRef.current + 1
    imageSubjectMapRequestRef.current = requestId
    setMediaFullscreenComposerTarget(null)
    setMediaFullscreenSelectedSubjectIds([])
    setMediaFullscreenComposerSending(false)
    setMediaFullscreenSidebarEditing(false)
    setMediaFullscreen(session)
    if (asset.type !== 'image' || !asset.objectHash) return
    void call('get_image_subject_map', {
      book_id: bookId,
      artifact_id: asset.artifactId,
      object_hash: asset.objectHash,
    }, { background: true })
      .then((value) => {
        if (imageSubjectMapRequestRef.current !== requestId) return
        const subjectMap = imageSubjectMapForSession(session, value)
        updateFullscreenSubjectMap(session.key, subjectMap)
        if (subjectMap.status === 'analyzing') {
          void watchImageSubjectMap(session, requestId, subjectMap)
        }
      })
      .catch((error: unknown) => {
        if (imageSubjectMapRequestRef.current !== requestId) return
        updateFullscreenSubjectMap(
          session.key,
          failedImageSubjectMap(session, error),
        )
      })
  }, [bookId, call, notebook, updateFullscreenSubjectMap, watchImageSubjectMap])

  const closeMediaFullscreen = useCallback(() => {
    imageSubjectMapRequestRef.current += 1
    setMediaFullscreenComposerTarget(null)
    setMediaFullscreenSelectedSubjectIds([])
    setMediaFullscreenComposerSending(false)
    setMediaFullscreenSidebarEditing(false)
    setMediaFullscreen(null)
  }, [])

  const updateMediaFullscreenSelectedSubjectIds = useCallback((
    subjectIds: readonly string[],
  ) => {
    setMediaFullscreenSelectedSubjectIds((current) => (
      current.length === subjectIds.length
      && current.every((subjectId, index) => subjectId === subjectIds[index])
        ? current
        : [...subjectIds]
    ))
  }, [])

  const captureFullscreenFrame = async (
    session: MediaFullscreenSession,
    timestampSeconds: number,
  ): Promise<string> => {
    const accepted = recordValue(await call('extract_notebook_frame', {
      book_id: session.bookId,
      notebook_id: session.notebookId,
      source_cell_id: session.cellId,
      frame_mode: 'time',
      timestamp_seconds: Math.round(timestampSeconds * 1_000) / 1_000,
    }))
    const cellId = asString(accepted?.cell_id)
    const addressTag = asString(accepted?.address)
    const runId = asString(accepted?.run_id)
    const jobId = asString(accepted?.job_id)
    if (!cellId || !addressTag || !runId || !jobId) {
      throw new Error('The server did not return the frame extraction cell')
    }
    setCellRunError(cellId, null)
    setCellQueued(cellId, true)
    void watchNotebookRun({
      bookId: session.bookId,
      notebookId: session.notebookId,
      cellId,
      address: addressTag.replace(/^@/, ''),
      runId,
      jobOperationId: jobId,
      intervalMs: notebookRunPollIntervalMs,
      timeoutMs: notebookRunPollTimeoutMs,
      maxPollFailures: 1,
    }).then((outcome) => {
      if (outcome.kind === 'failed' || outcome.kind === 'timeout') {
        const message = outcome.message
          ?? `Frame extraction into ${addressTag} failed`
        setCellRunError(cellId, message)
        setNotice(message, 'error')
      }
    }).finally(() => {
      setCellQueued(cellId, false)
    })
    return addressTag
  }

  const analyzeFullscreenSubjects = useCallback(async (
    session: MediaFullscreenSession,
    force = false,
  ) => {
    if (!session.asset.objectHash) {
      throw new Error('This image does not expose an immutable object hash')
    }
    if (!acceptCloudGenerationConsent({
      provider: 'kie',
      model: 'seedream/5-pro-layer-decomposition',
      tool: 'analyze_image_subjects',
    })) return
    const requestId = imageSubjectMapRequestRef.current + 1
    imageSubjectMapRequestRef.current = requestId
    updateFullscreenSubjectMap(session.key, {
      status: 'analyzing',
      artifactId: session.asset.artifactId,
      objectHash: session.asset.objectHash,
      width: session.asset.width,
      height: session.asset.height,
      baseUrl: session.subjectMap?.baseUrl ?? null,
      jobId: null,
      startedAt: new Date().toISOString(),
      error: null,
      subjects: session.subjectMap?.subjects ?? [],
    }, true)
    try {
      const value = await call('analyze_image_subjects', {
        book_id: session.bookId,
        artifact_id: session.asset.artifactId,
        object_hash: session.asset.objectHash,
        ...(force ? { force: true } : {}),
      })
      if (imageSubjectMapRequestRef.current !== requestId) return
      const subjectMap = imageSubjectMapForSession(session, value)
      updateFullscreenSubjectMap(session.key, subjectMap)
      if (subjectMap.status === 'analyzing') {
        void watchImageSubjectMap(session, requestId, subjectMap)
      }
    } catch (error) {
      if (imageSubjectMapRequestRef.current === requestId) {
        updateFullscreenSubjectMap(
          session.key,
          failedImageSubjectMap(session, error),
        )
      }
      throw error
    }
  }, [call, updateFullscreenSubjectMap, watchImageSubjectMap])

  const editFullscreenSubjects = useCallback(async (
    session: MediaFullscreenSession,
    input: ImageSubjectEditInput,
  ) => {
    if (!session.asset.objectHash) {
      throw new Error('This image does not expose an immutable object hash')
    }
    if (bookId !== session.bookId) {
      throw new Error('The active book changed while the image editor was open')
    }
    if (watchScopeRef.current.notebookId !== session.notebookId) {
      throw new Error('The active notebook changed while the image editor was open')
    }
    if (
      (input.operation === 'edit' || input.operation === 'replace')
      && !acceptCloudGenerationConsent({
        provider: 'kie',
        model: 'seedream/5-pro-image-to-image',
        tool: 'edit_image_subjects',
      })
    ) return false
    const requestId = imageSubjectMapRequestRef.current
    const response = await guardedAsyncResult(
      async () => await call('edit_image_subjects', {
        book_id: session.bookId,
        notebook_id: session.notebookId,
        source_cell_id: session.cellId,
        artifact_id: session.asset.artifactId,
        object_hash: session.asset.objectHash,
        ...(input.subjectIds.length > 0 ? { subject_ids: input.subjectIds } : {}),
        operation: input.operation,
        ...(input.prompt ? { prompt: input.prompt } : {}),
        ...(input.regions && input.regions.length > 0
          ? {
              regions: input.regions.map((region) => ({
                replacement_artifact_id: region.replacementArtifactId,
                ...(region.box ? { box: region.box } : {}),
                ...(region.subjectId ? { subject_id: region.subjectId } : {}),
                ...(region.note ? { note: region.note } : {}),
              })),
            }
          : {}),
      }),
      () => {
        const scope = watchScopeRef.current
        return imageSubjectMapRequestRef.current === requestId
          && scope.bookId === session.bookId
          && scope.notebookId === session.notebookId
      },
    )
    if (response.kind === 'stale') return false
    if (response.kind === 'error') throw response.error
    const result = response.value
    const status = asString(recordValue(result)?.status) ?? 'queued'
    setNotice(
      input.operation === 'remove'
        ? `Subject removal ${status}`
        : input.operation === 'replace'
          ? `Region replacement ${status}`
          : `Subject edit ${status}`,
    )
    await refreshBookData(session.bookId, session.notebookId).catch(() => undefined)
    return true
  }, [bookId, call, refreshBookData, setNotice])

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
      const target = selectPreferredBook(nextBooks, preferredBookId ?? bookId)
      if (target) {
        await refreshBookData(target.bookId)
        setNotice(`Loaded ${target.name}`)
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
      setNotice(next ? `Opened ${next.name}` : 'Book opened')
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
    name: string,
  ): Promise<BookProjectMutationResult> => {
    setBusy(true)
    try {
      const created = asBook(await call('create_book', { name }))
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
        ? `Created ${created.name}; commands could not refresh: ${commandError}`
        : `Created ${created.name}`)
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
    name: string,
  ): Promise<BookProjectMutationResult> => {
    setBusy(true)
    try {
      const renamed = asBook(await call('rename_book', {
        book_id: targetBookId,
        name,
      }))
      if (!renamed) throw new Error('The server returned an invalid project')
      setBooks((current) => current.map((book) =>
        book.bookId === targetBookId ? renamed : book))
      const commandError = await refreshBookCommandsAfterMutation()
      setNotice(commandError
        ? `Renamed to ${renamed.name}; commands could not refresh: ${commandError}`
        : `Renamed to ${renamed.name}`)
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
    confirmName: string,
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
        confirm_name: confirmName,
      })
      setBooks((current) => current.filter((book) => book.bookId !== targetBookId))
      if (targetBookId === bookId) {
        await refreshBookData(fallback.bookId)
        setScreen('notebook')
        handleBookMenuOpenChange(false)
      }
      const commandError = await refreshBookCommandsAfterMutation()
      setNotice(commandError
        ? `Deleted ${target.name}; commands could not refresh: ${commandError}`
        : `Deleted ${target.name}`)
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
      : nextNotebookCreationSlot(type, notebook.cells, lastWorkSlot)
    if (
      position
      && nodes.some((node) =>
        node.data.slot.row === slot.row
        && node.data.slot.column === slot.column)
    ) {
      setNotice('Choose an empty grid square for the new cell', 'error')
      return
    }
    setBusy(true)
    try {
      await call('create_notebook_cell', {
        book_id: bookId,
        notebook_id: notebook.id,
        cell: {
          type,
          slot,
          ...(type === 'prompt'
            || type === 'analyze'
            || isNotebookGenerationCellType(type)
            ? { prompt: '' }
            : {}),
        },
      })
      await refreshBookData(bookId, notebook.id)
      rememberLastWorkSlot(slot)
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
      rememberLastWorkSlot(selectedCell.data.slot)
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
    const replacing = notebook.edges.some((edge) =>
      edge.target === selectedNotebookCell.id
      && edge.targetInput === targetInput)
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
      setNotice(sourceCellId
        ? replacing ? 'Input source replaced' : 'Input source attached'
        : 'Input source cleared')
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : String(error),
        'error',
      )
    } finally {
      setBusy(false)
    }
  }

  const deleteNotebookCells = async (
    cells: readonly NotebookDocument['cells'][number][],
  ) => {
    if (!bookId || !notebook || cells.length === 0) return
    const uniqueCells = [...new Map(cells.map((cell) => [cell.id, cell])).values()]
    const cellIds = new Set(uniqueCells.map((cell) => cell.id))
    const addresses = uniqueCells.map((cell) => notebookGridTag(cell.slot))
    const count = uniqueCells.length
    const confirmed = window.confirm(count === 1
      ? `Delete ${addresses[0]}?\n\nThis removes the cell and its connections. This cannot be undone.`
      : `Delete ${count} selected cells?\n\n${addresses.join(', ')}\n\nThis removes the cells and their connections. This cannot be undone.`)
    if (!confirmed) return

    const deletedIds = new Set<string>()
    const reconcileDeletedSelection = () => {
      const fallbackCellId = selectedNotebookCells
        .map((cell) => cell.id)
        .filter((cellId) => !deletedIds.has(cellId))
        .at(-1) ?? null
      updateSelectedCellIds(new Set(
        [...selectedCellIdsRef.current].filter((cellId) => !deletedIds.has(cellId)),
      ))
      setSelectedCellId((current) =>
        current && !deletedIds.has(current) ? current : fallbackCellId)
      setSourceViewCellId((current) =>
        current && deletedIds.has(current) ? null : current)
    }

    setDeletingCellIds(cellIds)
    setNodes((current) => current.map((node) => cellIds.has(node.id)
      ? { ...node, data: { ...node.data, deleting: true } }
      : node))
    setBusy(true)
    try {
      await delay(180)
      for (const cell of uniqueCells) {
        await call('delete_notebook_cell', {
          book_id: bookId,
          notebook_id: notebook.id,
          cell_id: cell.id,
        })
        deletedIds.add(cell.id)
      }
      if (mediaFullscreen && deletedIds.has(mediaFullscreen.cellId)) {
        closeMediaFullscreen()
      }
      await refreshBookData(bookId, notebook.id)
      reconcileDeletedSelection()
      setNotice(count === 1 ? `${addresses[0]} deleted` : `${count} cells deleted`)
    } catch (error) {
      if (mediaFullscreen && deletedIds.has(mediaFullscreen.cellId)) {
        closeMediaFullscreen()
      }
      await refreshBookData(bookId, notebook.id).catch(() => undefined)
      reconcileDeletedSelection()
      const message = error instanceof Error ? error.message : String(error)
      setNotice(
        deletedIds.size > 0
          ? `Deleted ${deletedIds.size} of ${count} cells. ${message}`
          : message,
        'error',
      )
    } finally {
      setNodes((current) => current.map((node) => cellIds.has(node.id)
        ? { ...node, data: { ...node.data, deleting: false } }
        : node))
      setDeletingCellIds(new Set())
      setBusy(false)
    }
  }

  const deleteSelectedCell = async () => {
    if (!selectedNotebookCell) return
    await deleteNotebookCells([selectedNotebookCell])
  }

  const deleteSelectedCells = async () => {
    await deleteNotebookCells(selectedNotebookCells)
  }

  const handleNotebookCanvasKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Backspace' && event.key !== 'Delete') return
    const target = event.target
    if (
      target instanceof HTMLElement
      && target.closest('input, textarea, select, button, a, [contenteditable="true"]')
    ) return
    if (busy || selectedNotebookCells.length === 0) return
    event.preventDefault()
    event.stopPropagation()
    void deleteSelectedCells()
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

  const autoArrangeNotebook = async () => {
    if (!bookId || !notebook || notebook.cells.length === 0) return
    const planned = planNotebookArrangement(notebook)
    if (!planned.ok) {
      setNotice(planned.message, 'error')
      return
    }
    const currentSlots = new Map(notebook.cells.map((cell) => [cell.id, cell.slot]))
    const changed = planned.slots.some((slot) => {
      const current = currentSlots.get(slot.id)
      return current?.row !== slot.row || current?.column !== slot.column
    })
    const reveal = () => revealNotebookArrangement(
      () => notebookScrollRef.current,
    )
    if (!changed) {
      setNotice('Notebook is already auto-arranged')
      reveal()
      return
    }

    const revision = asString(recordValue(notebook)?.revision)
    setBusy(true)
    try {
      await call('move_notebook_cells', {
        book_id: bookId,
        notebook_id: notebook.id,
        ...(revision ? { expected_revision: revision } : {}),
        slots: planned.slots,
      })
      await refreshNotebook(bookId, notebook.id)
      const selectedSlot = selectedCellId
        ? planned.slots.find((slot) => slot.id === selectedCellId)
        : undefined
      if (selectedSlot) {
        rememberLastWorkSlot({
          row: selectedSlot.row,
          column: selectedSlot.column,
        })
      }
      setNotice(
        `Auto-arranged ${planned.slots.length} ${planned.slots.length === 1 ? 'tile' : 'tiles'}`,
      )
      reveal()
    } catch (error) {
      await refreshNotebook(bookId, notebook.id).catch(() => undefined)
      setNotice(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  const arrangeVideoCellsOnAxis = async (
    axis: NotebookVideoAxis,
    anchor: NotebookGridSlot,
  ): Promise<{ ok: boolean; message: string }> => {
    if (!bookId || !notebook) {
      return { ok: false, message: 'No notebook is open' }
    }
    const planned = planVideoAxisArrangement(
      notebook,
      notebookVideoCellIds,
      anchor,
      axis,
    )
    if (!planned.ok) {
      setNotice(planned.message, 'error')
      return { ok: false, message: planned.message }
    }
    const axisLabel = axis === 'column'
      ? `column ${anchor.column + 1}`
      : `row ${String.fromCharCode(97 + anchor.row)}`
    if (planned.movedCount === 0) {
      const message = `Videos are already arranged in ${axisLabel}`
      setNotice(message)
      return { ok: true, message }
    }

    const revision = asString(recordValue(notebook)?.revision)
    setBusy(true)
    try {
      await call('move_notebook_cells', {
        book_id: bookId,
        notebook_id: notebook.id,
        ...(revision ? { expected_revision: revision } : {}),
        slots: planned.slots,
      })
      await refreshNotebook(bookId, notebook.id)
      rememberLastWorkSlot({ row: anchor.row, column: anchor.column })
      const videoCount = planned.slots.length - planned.displacedCount
      const message = `Arranged ${videoCount} ${videoCount === 1 ? 'video' : 'videos'} in ${axisLabel}`
      setNotice(message)
      return { ok: true, message }
    } catch (error) {
      await refreshNotebook(bookId, notebook.id).catch(() => undefined)
      const message = error instanceof Error ? error.message : String(error)
      setNotice(message, 'error')
      return { ok: false, message }
    } finally {
      setBusy(false)
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

  const resolveMediaFileArtifact = async (
    file: File,
    kind: PassiveMediaKind,
  ): Promise<{ artifactRef: string; reusedExisting: boolean }> => {
    if (!bookId) throw new Error('Choose a book before uploading media')
    const objectHash = await fileObjectHash(file)
    const duplicateValue = recordValue(await call('check_duplicate_bytes', {
      book_id: bookId,
      object_hash: objectHash,
    }))
    const matches = Array.isArray(duplicateValue?.matches)
      ? duplicateValue.matches
      : []
    const duplicate = matches
      .map((value) => recordValue(value))
      .find((value) => {
        const duplicateKind = value && asString(value.kind)
        return duplicateKind !== null && isCompatibleLibraryAsset(kind, duplicateKind)
      })
    const existingArtifactRef = duplicate && asString(duplicate.artifact_id)
    if (existingArtifactRef) {
      return { artifactRef: existingArtifactRef, reusedExisting: true }
    }

    const response = await fetch(
      `/api/books/${encodeURIComponent(bookId)}/upload?filename=${encodeURIComponent(file.name)}`,
      { method: 'POST', body: file },
    )
    const payload = recordValue(await response.json())
    if (!response.ok) {
      throw new Error(asString(payload?.error) ?? `Upload failed: ${file.name}`)
    }
    const artifactRef = asString(payload?.assetId)
    if (!artifactRef) throw new Error('Upload did not return an asset id')
    return { artifactRef, reusedExisting: false }
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
      setMediaSlotError(cellId, 'This media slot already contains media.')
      return
    }
    const fileKind = mediaKindForFile(file)
    if (fileKind !== kind) {
      setMediaSlotError(cellId, `Choose one ${kind} file for this slot.`)
      return
    }

    setMediaSlotOperation(cellId, 'upload')
    try {
      const { artifactRef, reusedExisting } = await resolveMediaFileArtifact(file, kind)
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
      void watchUploadedMediaAsset({
        bookId,
        notebookId: notebook.id,
        cellId,
        address: notebookGridAddress(cell.slot),
        artifactId: artifactRef,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setMediaSlotError(cellId, message)
      setNotice(message, 'error')
    }
  }

  const createMediaCellFromFile = async (
    slot: NotebookGridSlot,
    file: File,
  ) => {
    if (!bookId || !notebook) return
    if (busy) {
      setNotice('Wait for the current operation to finish', 'error')
      return
    }
    const kind = mediaKindForFile(file)
    if (!kind) {
      setNotice('Drop an image, video, or audio file on an open square', 'error')
      return
    }
    if (notebook.cells.some((cell) =>
      cell.slot.row === slot.row && cell.slot.column === slot.column)) {
      setNotice('Choose an empty grid square for the media file', 'error')
      return
    }

    const address = notebookGridTag(slot)
    let createdCellId: string | null = null
    let attached = false
    setBusy(true)
    try {
      const { artifactRef, reusedExisting } = await resolveMediaFileArtifact(file, kind)
      const created = recordValue(await call('create_notebook_cell', {
        book_id: bookId,
        notebook_id: notebook.id,
        cell: {
          type: kind,
          slot,
        },
      }))
      createdCellId = created && asString(created.id)
      if (!createdCellId) throw new Error('The server did not return the new media cell')
      await call('set_notebook_media_slot', {
        book_id: bookId,
        notebook_id: notebook.id,
        cell_id: createdCellId,
        artifact_ref: artifactRef,
      })
      attached = true
      rememberLastWorkSlot(slot)
      await refreshBookData(bookId, notebook.id)
      setNotice(reusedExisting
        ? `Reused @${artifactRef} at ${address}`
        : `Uploaded and attached @${artifactRef} at ${address}`)
      void watchUploadedMediaAsset({
        bookId,
        notebookId: notebook.id,
        cellId: createdCellId,
        address: notebookGridAddress(slot),
        artifactId: artifactRef,
      })
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error)
      if (createdCellId && !attached) {
        try {
          await call('delete_notebook_cell', {
            book_id: bookId,
            notebook_id: notebook.id,
            cell_id: createdCellId,
          })
        } catch (rollbackError) {
          const detail = rollbackError instanceof Error
            ? rollbackError.message
            : String(rollbackError)
          message = `${message}. The empty ${address} cell could not be removed: ${detail}`
        }
      }
      await refreshBookData(bookId, notebook.id).catch(() => undefined)
      setNotice(message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const closeMediaLibrary = () => {
    mediaLibraryRequestRef.current += 1
    mediaLibraryReference.lifecycle.close()
    setMediaLibraryPicker(null)
    const opener = mediaLibraryOpenerRef.current
    mediaLibraryOpenerRef.current = null
    scheduleModalDialogFocusRestoration(
      opener,
      (callback) => window.setTimeout(callback, 0),
    )
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
        ? mediaLibrarySearchCriteria(mediaLibraryReference.state)
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
      let referenceRange
      try {
        referenceRange = activeCriteria.mode === 'video-reverse'
          && activeCriteria.reference
          ? searchReferenceRange(
              activeCriteria.referenceStartSeconds,
              activeCriteria.referenceDurationSeconds,
              activeCriteria.reference,
            )
          : undefined
      } catch (error) {
        const message = mediaLibraryReference.lifecycle.getState().reference
          === activeCriteria.reference
          ? mediaLibraryReference.lifecycle.resetInvalidRange(error)
          : error instanceof Error ? error.message : String(error)
        throw new Error(message)
      }
      const result = asLibrarySearchResult(await call('search_library_assets', {
        ...(activeCriteria.mode === 'text' && query.trim()
          ? { query: query.trim() }
          : {}),
        ...(activeCriteria.mode !== 'text' && activeCriteria.reference
          ? { reference_id: activeCriteria.reference.referenceId }
          : {}),
        ...(referenceRange
          ? { reference_range: referenceRange }
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
    mediaLibraryReference.lifecycle.close()
    setMediaSlotOperation(cellId, null)
    setMediaLibraryPicker({
      cellId,
      query: '',
      draftQuery: '',
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
        : `Copied and attached @${asset.id} from ${asset.owningBookName}`)
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

  const elevenLabsVoices = useElevenLabsVoices({
    callTool: call,
    ready: mcp.state === 'ready',
  })

  const runSpeakGeneration = async (
    text: string,
    voiceId: string,
  ): Promise<ComposerOutcome> => {
    if (!bookId || !notebook) {
      return { ok: false, message: 'Open a notebook before speaking.' }
    }
    let materialized: {
      cellId: string
      cellAddress: string
      outputCellId: string
    } | null = null
    let runAccepted = false
    try {
      if (!online) {
        throw new Error(
          'Offline: cloud generation is unavailable. '
          + 'Local search, editing, playback, and export remain available.',
        )
      }
      const currentNotebook = asNotebook(await call('get_notebook', {
        book_id: bookId,
        notebook_id: notebook.id,
      }))
      if (!currentNotebook) {
        throw new Error('The server returned an invalid notebook')
      }
      const created = await materializeNotebookSpeakCommand({
        bookId,
        callTool: call,
        document: currentNotebook,
        lastWorkSlot,
        text,
        voiceId,
        ...(currentNotebook.revision
          ? { expectedRevision: currentNotebook.revision }
          : {}),
      })
      materialized = created
      const spokenSlot = parseNotebookGridAddress(created.cellAddress)
      if (spokenSlot) rememberLastWorkSlot(spokenSlot)
      const plan = await createGenerationPlan(created.cellId, 'slash')
      const stage = plan.stages.find((candidate) =>
        candidate.kind === 'queued'
        && candidate.jobType === 'generation'
        && candidate.tool === 'run_notebook_cell'
        && candidate.input.cell_id === created.cellId)
      if (stage?.kind !== 'queued') {
        throw new Error('The generation plan is missing its notebook cell')
      }
      const plannedNotebookId = asString(stage.input.notebook_id)
      if (plannedNotebookId !== currentNotebook.id) {
        throw new Error('The generation plan belongs to another notebook')
      }
      if (!acceptCloudGenerationConsent(stage)) {
        throw new Error('Cloud generation cancelled before sending data')
      }
      setPendingChatAction(null)
      setPendingCommandPlan(null)
      const accepted = await startNotebookCellRun({
        start: () => call('run_notebook_cell', {
          book_id: bookId,
          notebook_id: plannedNotebookId,
          cell_id: created.cellId,
          plan,
          actor: 'videobook-user',
        }),
        onStarting: () => setCellQueued(created.cellId, true),
        onRejected: () => setCellQueued(created.cellId, false),
      })
      const runId = asString(recordValue(accepted)?.run_id)
      const jobOperationId = asString(recordValue(accepted)?.job_id)
      if (!runId || !jobOperationId) {
        setCellQueued(created.cellId, false)
        throw new Error('The server did not return a notebook run')
      }
      runAccepted = true
      persistSpeakVoiceId(voiceId)
      setNotice(`${created.cellAddress} queued`)
      void watchGenerationRun({
        bookId,
        notebookId: plannedNotebookId,
        cellId: created.cellId,
        address: created.cellAddress.replace(/^@/, ''),
        runId,
        jobOperationId,
      })
      await refreshBookData(bookId, notebook.id).catch(() => undefined)
      return { ok: true, message: `${created.cellAddress} queued` }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (materialized && !runAccepted) {
        await call('delete_notebook_cell', {
          book_id: bookId,
          notebook_id: notebook.id,
          cell_id: materialized.cellId,
        }).catch(() => undefined)
        await call('delete_notebook_cell', {
          book_id: bookId,
          notebook_id: notebook.id,
          cell_id: materialized.outputCellId,
        }).catch(() => undefined)
        return { ok: false, message }
      }
      if (runAccepted) {
        setNotice(message, 'error')
        return { ok: false, message }
      }
      return { ok: false, message }
    }
  }

  const openWatermarkReview = (
    assetId: string,
    targetLabel: string,
    initial: {
      handle?: string
      url?: string
      includeQr?: boolean
      position?: WatermarkReviewState['position']
      handleVerticalPercent?: number
      includeXIcon?: boolean
      includeHandleBorder?: boolean
      handlePadding?: number
      handleRounding?: number
      qrOpacity?: number
      handleOpacity?: number
      qrStartSeconds?: number
      qrEndSeconds?: number | null
      handleStartSeconds?: number
      handleEndSeconds?: number | null
      saveDefault?: boolean
    } = {},
  ) => {
    const targetAsset = assets.find((asset) => asset.artifactId === assetId)
    setPendingCommandPlan(null)
    setPendingChatAction(null)
    setPendingWatermarkReview({
      assetId,
      targetLabel,
      mediaUrl: targetAsset?.mediaUrl ?? null,
      thumbnailUrl: targetAsset?.thumbnailUrl ?? null,
      width: targetAsset?.width ?? null,
      height: targetAsset?.height ?? null,
      durationSeconds: targetAsset?.duration ?? null,
      handle: initial.handle?.replace(/^@/, '') ?? '',
      url: initial.url ?? '',
      includeQr: initial.includeQr ?? true,
      position: initial.position ?? 'auto',
      handleVerticalPercent: initial.handleVerticalPercent === undefined
        ? DEFAULT_HANDLE_VERTICAL_PERCENT
        : clampHandleVerticalPercent(initial.handleVerticalPercent),
      includeXIcon: initial.includeXIcon ?? true,
      includeHandleBorder: initial.includeHandleBorder ?? true,
      handlePadding: initial.handlePadding === undefined
        ? DEFAULT_HANDLE_PADDING
        : clampHandlePadding(initial.handlePadding),
      handleRounding: initial.handleRounding === undefined
        ? DEFAULT_HANDLE_ROUNDING
        : clampHandleRounding(initial.handleRounding),
      qrOpacity: initial.qrOpacity === undefined
        ? DEFAULT_WATERMARK_OPACITY
        : clampWatermarkOpacity(initial.qrOpacity),
      handleOpacity: initial.handleOpacity === undefined
        ? DEFAULT_WATERMARK_OPACITY
        : clampWatermarkOpacity(initial.handleOpacity),
      qrStartSeconds: initial.qrStartSeconds ?? 0,
      qrEndSeconds: initial.qrEndSeconds ?? null,
      handleStartSeconds: initial.handleStartSeconds ?? 0,
      handleEndSeconds: initial.handleEndSeconds ?? null,
      saveDefault: initial.saveDefault ?? false,
      recent: [],
      loadingConfig: true,
      error: null,
    })
    void (async () => {
      try {
        const config = recordValue(await call('get_watermark_config', {}, { background: true }))
        const savedHandle = asString(config?.savedHandle)
        const authenticatedHandle = asString(config?.authenticatedHandle)
        const recent = Array.isArray(config?.recent)
          ? config.recent.filter((entry): entry is string => typeof entry === 'string')
          : []
        setPendingWatermarkReview((current) =>
          current && current.assetId === assetId
            ? {
                ...current,
                handle: current.handle || (savedHandle ?? authenticatedHandle ?? recent[0] ?? ''),
                recent,
                loadingConfig: false,
              }
            : current)
      } catch {
        setPendingWatermarkReview((current) =>
          current && current.assetId === assetId
            ? { ...current, loadingConfig: false }
            : current)
      }
    })()
  }

  const submitWatermark = async (): Promise<ComposerOutcome> => {
    if (!bookId || !pendingWatermarkReview) {
      return { ok: false, message: 'There is no pending watermark to apply.' }
    }
    const {
      assetId,
      handle,
      url,
      includeQr,
      position,
      handleVerticalPercent,
      includeXIcon,
      includeHandleBorder,
      handlePadding,
      handleRounding,
      qrOpacity,
      handleOpacity,
      qrStartSeconds,
      qrEndSeconds,
      handleStartSeconds,
      handleEndSeconds,
      saveDefault,
    } = pendingWatermarkReview
    const trimmedHandle = handle.replace(/^@/, '').trim()
    if (!trimmedHandle) {
      return {
        ok: false,
        message: 'Enter an X handle before applying the watermark.',
        nextInput: '/apply',
        selectInput: false,
      }
    }
    setPendingWatermarkReview((current) =>
      current && current.assetId === assetId
        ? { ...current, error: null }
        : current)
    setBusy(true)
    try {
      const result = recordValue(await call('apply_watermark', {
        book_id: bookId,
        asset_id: assetId,
        handle: trimmedHandle,
        include_qr: includeQr,
        position,
        handle_vertical_percent: handleVerticalPercent,
        include_x_icon: includeXIcon,
        include_handle_border: includeHandleBorder,
        handle_padding: handlePadding,
        handle_rounding: handleRounding,
        handle_opacity: handleOpacity,
        ...(includeQr && url.trim() ? { url: url.trim() } : {}),
        ...(includeQr ? { qr_opacity: qrOpacity } : {}),
        ...(includeQr && qrStartSeconds > 0
          ? { qr_start_seconds: qrStartSeconds }
          : {}),
        ...(includeQr && qrEndSeconds !== null
          ? { qr_end_seconds: qrEndSeconds }
          : {}),
        ...(handleStartSeconds > 0
          ? { handle_start_seconds: handleStartSeconds }
          : {}),
        ...(handleEndSeconds !== null
          ? { handle_end_seconds: handleEndSeconds }
          : {}),
        ...(saveDefault ? { save_default: true } : {}),
      }))
      const source = asString(result?.placement_source)
      const corner = asString(result?.position)
      const frameAware = source === 'vision' || source === 'cached' ? ' (frame-aware)' : ''
      const handlePosition = ` · handle ${handleVerticalPercent}% from top at ${Math.round(handleOpacity * 100)}%`
      const qrAppearance = includeQr ? ` · QR ${Math.round(qrOpacity * 100)}%` : ''
      await refreshBookData(bookId, notebook?.id)
      const message = includeQr && corner
        ? `QR + @${trimmedHandle} watermarks burned in — QR ${corner}${frameAware}${qrAppearance}${handlePosition}.`
        : `@${trimmedHandle} watermark burned in${handlePosition}.`
      setNotice(message)
      setPendingWatermarkReview(null)
      return { ok: true, message }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setPendingWatermarkReview((current) =>
        current && current.assetId === assetId
          ? { ...current, error: message }
          : current)
      setNotice(message, 'error')
      return {
        ok: false,
        message,
        nextInput: '/apply',
        selectInput: false,
      }
    } finally {
      setBusy(false)
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
        const duplicateValue = recordValue(await call('check_duplicate_bytes', {
          book_id: bookId,
          object_hash: objectHash,
        }))
        const matches = Array.isArray(duplicateValue?.matches)
          ? duplicateValue.matches
          : []
        if (matches.length > 0) {
          const first = recordValue(matches[0])
          const existing = asString(first?.label)
            ?? asString(first?.artifact_id)
            ?? 'existing source'
          const importAgain = window.confirm(
            `${file.name} has the same bytes as ${existing}.\n\n`
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
      const result = recordValue(await call('retry_ingest', {
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
      const result = recordValue(value)
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

  const selectTimelineRange = (
    startOverride?: number,
    durationOverride?: number,
  ) => {
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
    setTimelineSelectionStart(String(startFrame))
    setTimelineSelectionDuration(String(durationFrames))
    setNotice(
      `Selected ${durationFrames} frames from frame ${startFrame}`,
    )
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
        const queued = recordValue(await call('enqueue_notebook_run', {
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
          const committed = recordValue(await call('commit_edit_intent', {
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
            onAccepted: () => setCellQueued(cellId, false),
            onRejected: () => setCellQueued(cellId, false),
          })
          const acceptedRecord = recordValue(accepted)
          const runId = asString(acceptedRecord?.run_id)
          const jobOperationId = asString(acceptedRecord?.job_id)
          const outputCellId = asString(acceptedRecord?.output_cell_id)
          if (!runId || !jobOperationId) {
            setCellQueued(cellId, false)
            throw new Error('The server did not return a notebook run')
          }
          const watchCellId = outputCellId ?? cellId
          const watchedCell = notebook?.cells.find((cell) => cell.id === cellId)
          let address = watchedCell
            ? notebookGridAddress(watchedCell.slot)
            : cellId.slice(0, 8)
          if (outputCellId) {
            const notebookValue = await call('get_notebook', {
              book_id: bookId,
              notebook_id: notebookId,
            }, { background: true })
            const nextNotebook = asNotebook(notebookValue)
            if (nextNotebook) {
              applyNotebook(nextNotebook, assets, jobs)
              const output = nextNotebook.cells.find((candidate) =>
                candidate.id === outputCellId)
              if (output) address = notebookGridAddress(output.slot)
            }
            revealCells([outputCellId])
            setCellQueued(outputCellId, true)
          }
          void watchGenerationRun({
            bookId,
            notebookId,
            cellId: watchCellId,
            address,
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
      const action = recordValue(await call('get_edit_action', {
        book_id: bookId,
        action_id: lastEditActionId,
      }))
      const targetRevision = asString(action?.baseRevision)
      if (!targetRevision) throw new Error('The edit audit has no base revision')
      const restored = recordValue(await call('restore_edit_action', {
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
        message: 'Add captions first so narration beats have exact timing.',
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
      const result = recordValue(value)
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
        message: 'Add captions first so sound suggestions have exact timing.',
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
      const result = recordValue(value)
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
      selectTimelineRange(start, duration)
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
      nextNotebookCreationSlot('video', notebook.cells, lastWorkSlot),
    )
    let createdCellId: string
    try {
      const created = recordValue(await call('create_notebook_cell', {
        book_id: bookId,
        notebook_id: notebook.id,
        cell,
      }))
      const nextCellId = asString(created?.id)
      if (!nextCellId) {
        throw new Error('The server did not return the new notebook cell')
      }
      createdCellId = nextCellId
      selectCanvasCell(nextCellId)
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
      address: notebookGridAddress(cell.slot),
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
        address: input.actionAddress.slice(1),
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
    selectCanvasCell(input.run.outputs.at(-1)?.outputCellId ?? null)
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
      const source = resolveNotebookVideoSourceCell(
        currentNotebook,
        command.sourceReference,
      )
      const sourceAddress = notebookGridTag(source.slot)
      const sourceArtifactId = resolveGeneratedVideoArtifact(
        currentNotebook,
        source,
      )
      const sourceDuration = currentAssets.find((asset) =>
        asset.artifactId === sourceArtifactId)?.duration
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
      selectCanvasCell(draft.outputs[0].outputCell.id)
      setNotice(`Splitting ${sourceAddress} into ${draft.outputs.length} chunks`)
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
        message: `Splitting ${sourceAddress} into ${outputAddresses.join(', ')}`,
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
      const source = resolveNotebookVideoSourceCell(
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
      selectCanvasCell(run.outputCellId ?? actionCellId)
      setNotice(`Frame extraction queued for ${sourceAddress}`)
      const outcome = await watchNotebookRun({
        bookId,
        notebookId: currentNotebook.id,
        cellId: actionCellId,
        address: notebookGridAddress(source.slot),
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
      selectCanvasCell(run.outputCellId ?? actionCellId)
      const successMessage = command.frameMode === 'time'
        ? `Extracted the frame at ${command.timestampSeconds ?? 0}s of ${sourceAddress}`
        : `Extracted the ${command.frameMode} frame of ${sourceAddress}`
      return {
        ok: true,
        message: successMessage,
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

  const executeNotebookAudioCommand = async (
    command: NotebookAudioCommand,
    currentNotebook: NotebookSnapshot,
  ): Promise<ComposerOutcome> => {
    if (!bookId || !notebook) {
      return { ok: false, message: 'Open a notebook before extracting audio.' }
    }
    let actionCellId: string | null = null
    setBusy(true)
    try {
      const source = resolveNotebookVideoSourceCell(
        currentNotebook,
        command.sourceReference,
      )
      const sourceAddress = notebookGridTag(source.slot)
      const run = await enqueueNotebookAudioCommand({
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
      selectCanvasCell(run.outputCellId ?? actionCellId)
      setNotice(`Audio extraction queued for ${sourceAddress}`)
      const outcome = await watchNotebookRun({
        bookId,
        notebookId: currentNotebook.id,
        cellId: actionCellId,
        address: notebookGridAddress(source.slot),
        runId: run.runId,
        jobOperationId: run.jobId,
        intervalMs: notebookRunPollIntervalMs,
        timeoutMs: notebookRunPollTimeoutMs,
        maxPollFailures: 1,
      })
      if (outcome.kind === 'failed') {
        throw new Error(outcome.message ?? `Audio extraction for ${sourceAddress} failed`)
      }
      if (outcome.kind === 'timeout') {
        throw new Error('Audio extraction did not finish within five minutes')
      }
      if (outcome.kind === 'superseded') {
        throw new Error(`Audio extraction for ${sourceAddress} was superseded by a newer run`)
      }
      selectCanvasCell(run.outputCellId ?? actionCellId)
      return {
        ok: true,
        message: `Extracted audio from ${sourceAddress}`,
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

  const runNotebookAudioCommandNow = async (
    command: NotebookAudioCommand,
  ): Promise<ComposerOutcome> => {
    if (!bookId || !notebook) {
      return { ok: false, message: 'Open a notebook before extracting audio.' }
    }
    try {
      const currentNotebook = asNotebook(await call('get_notebook', {
        book_id: bookId,
        notebook_id: notebook.id,
      }))
      if (!currentNotebook) {
        throw new Error('The server returned an invalid notebook')
      }
      resolveNotebookVideoSourceCell(
        currentNotebook,
        command.sourceReference,
      )
      setPendingCommandPlan(null)
      setPendingChatAction(null)
      return await executeNotebookAudioCommand(command, currentNotebook)
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  const runNotebookFrameCommandNow = async (
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
      resolveNotebookVideoSourceCell(
        currentNotebook,
        command.sourceReference,
      )
      setPendingCommandPlan(null)
      setPendingChatAction(null)
      return await executeNotebookFrameCommand(command, currentNotebook)
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }
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
      const source = resolveNotebookVideoSourceCell(
        currentNotebook,
        command.sourceReference,
      )
      const frameSummary = command.frameMode === 'time'
        ? `Extract the frame at ${command.timestampSeconds ?? 0}s from ${notebookGridTag(source.slot)}`
        : `Extract the ${command.frameMode} frame from ${notebookGridTag(source.slot)}`
      setPendingCommandPlan(null)
      setPendingChatAction({
        kind: 'frame',
        command,
        expectations: [{
          address: notebookGridTag(source.slot),
          cellId: source.id,
        }],
        notebookId: currentNotebook.id,
        reason: 'This request extracts a frame into a new image cell',
        summary: frameSummary,
      })
      return applyReadyOutcome('Frame extraction ready to apply')
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
      const source = resolveNotebookVideoSourceCell(
        currentNotebook,
        command.sourceReference,
      )
      const sourceArtifactId = resolveGeneratedVideoArtifact(
        currentNotebook,
        source,
      )
      const asset = sourceArtifactId ? assetById.get(sourceArtifactId) : undefined
      const sourceDurationSeconds = asset?.duration
        ?? asNumber(source.inputs?.durationSeconds)
      if (!asset?.mediaUrl) {
        throw new Error(`${notebookGridTag(source.slot)} does not have playable video yet`)
      }
      const maximumCellCount = notebookGrid.maximumRowCount
        * notebookGrid.columnCount
      const outputMode = command.outputMode ?? 'all'
      const requestedCutPoints = command.cutPointsSeconds.filter((cutPoint) =>
        sourceDurationSeconds === null
        || Math.abs(cutPoint - sourceDurationSeconds) > 0.001)
      const cutPointsSeconds = outputMode === 'all'
        ? notebookSplitCutPoints({
            cutPointsSeconds: requestedCutPoints,
            sourceDurationSeconds: sourceDurationSeconds ?? Number.NaN,
          })
        : notebookSplitPieces({
            cutPointsSeconds: requestedCutPoints,
            sourceDurationSeconds: sourceDurationSeconds ?? Number.NaN,
          }).slice(0, -1).map((piece) => piece.endSeconds)
      const preparedCommand: NotebookSplitCommand = {
        ...command,
        cutPointsSeconds,
        outputMode,
        selectedChunkIndexes: command.selectedChunkIndexes
          ?? (outputMode === 'all' ? [0] : command.selectedChunkIndexes ?? [0]),
      }
      const pieceCount = notebookSplitPieces({
        cutPointsSeconds,
        sourceDurationSeconds: sourceDurationSeconds ?? Number.NaN,
      }).length
      const neededCells = notebookSplitCellBudget(outputMode, pieceCount)
      if (maximumCellCount - currentNotebook.cells.length < neededCells) {
        throw new Error(
          `The notebook needs ${neededCells} empty cells to split a video`,
        )
      }
      setPendingCommandPlan(null)
      setPendingChatAction({
        kind: 'split',
        command: preparedCommand,
        expectations: [{
          address: notebookGridTag(source.slot),
          cellId: source.id,
        }],
        notebookId: currentNotebook.id,
        reason: 'This request creates and runs a Split Video workflow',
        sourceDurationSeconds: sourceDurationSeconds ?? Number.NaN,
        summary: notebookSplitSummary({
          cutPointsSeconds,
          outputMode,
          selectedChunkIndexes: preparedCommand.selectedChunkIndexes,
          sourceAddress: notebookGridTag(source.slot),
          sourceDurationSeconds: sourceDurationSeconds ?? Number.NaN,
        }),
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
      let draft = planNotebookChatGeneration({
        actions: generationActions,
        cellId: uuidv7(),
        command,
        document: currentNotebook,
        fallbackSlot: nextNotebookCreationSlot(
          command.cellType,
          currentNotebook.cells,
          lastWorkSlot,
        ),
        lastWorkSlot,
        ...(options?.preferredTool
          ? { preferredTool: options.preferredTool }
          : {}),
        ...(options?.routedParams
          ? { routedParams: options.routedParams }
          : {}),
      })
      const selectedSourceCells = draft.sourceCellIds.flatMap((cellId) => {
        const cell = currentNotebook.cells.find((candidate) => candidate.id === cellId)
        return cell ? [cell] : []
      })
      draft = reviseNotebookChatGenerationPrompt(
        draft,
        restoreSelectedNotebookMentionAliases(
          command.prompt,
          commandMentionAssets,
          selectedSourceCells,
        ),
      )
      if (
        draft.cell.type === 'generate_audio'
        && draft.action.controls.some((control) => control.name === 'voice_id')
        && typeof notebookChatGenerationSettings(draft).voice_id !== 'string'
      ) {
        const seededVoiceId = resolveSpeakVoiceId(
          elevenLabsVoices.voices,
          readStoredSpeakVoiceId(),
        )
        if (seededVoiceId) {
          draft = reviseNotebookChatGenerationSetting(
            draft,
            'voice_id',
            seededVoiceId,
          )
        }
      }
      validateNotebookChatGenerationPromptSources(draft, currentNotebook)
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

  const executeRoutedChatActionNow = async (
    plan: ChatActionPlan,
  ): Promise<ComposerOutcome> => {
    if (!bookId) return { ok: false, message: 'Load or create a book first.' }
    setPendingCommandPlan(null)
    setBusy(true)
    let applied = false
    try {
      const result = await call('chat', {
        book_id: bookId,
        action_plan: plan,
      })
      applied = true
      setPendingChatAction(null)
      if (isDownloadVideoResult(result)) {
        const outcome = await completeVideoDownload(
          result,
          urlFromText(plan.prompt),
        )
        setNotice(outcome.message, outcome.ok ? 'info' : 'error')
        return outcome.ok
          ? outcome
          : { ...outcome, nextInput: '', selectInput: false }
      }
      const routedCells = notebook
        ? routedMediaCellInputs(plan.tool, result, notebook.cells, lastWorkSlot)
        : []
      if (notebook && routedCells.length > 0) {
        const placements: string[] = []
        let firstCellId: string | null = null
        for (const cell of routedCells) {
          const created = recordValue(await call('create_notebook_cell', {
            book_id: bookId,
            notebook_id: notebook.id,
            cell,
          }))
          const cellId = asString(created?.id)
          if (!cellId) {
            throw new Error('The server did not return the new notebook cell')
          }
          firstCellId ??= cellId
          placements.push(notebookGridTag(cell.slot))
        }
        selectCanvasCell(firstCellId)
        await refreshBookData(bookId, notebook.id)
        const message = `Created ${placements.join(' and ')}`
        setNotice(message)
        return { ok: true, message }
      }
      const resultRecord = recordValue(result)
      const createdCellId = asString(resultRecord?.cell_id)
      await refreshBookData(bookId, notebook?.id)
      if (createdCellId) selectCanvasCell(createdCellId)
      const message = messageFor(result, plan.message || 'Action applied')
      setNotice(message)
      return { ok: true, message }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const message = applied
        ? `Action completed, but its notebook result could not be shown: ${detail}`
        : detail
      if (applied) {
        await refreshBookData(bookId, notebook?.id).catch(() => undefined)
      }
      setNotice(message, 'error')
      return {
        ok: false,
        message,
        nextInput: applied ? '' : '/apply',
        selectInput: !applied,
      }
    } finally {
      setBusy(false)
    }
  }

  const previewRoutedChatAction = async (
    plan: ChatActionPlan,
    originalInput: string,
  ): Promise<ComposerOutcome> => {
    const routedAssetReference = (value: unknown): string | null => {
      const assetId = asString(value)
      if (!assetId) return null
      return notebookChatGenerationReferences(restoreNotebookMentionAliases(
        assetId.startsWith('@') ? assetId : `@${assetId}`,
        commandMentionAssets,
      ))[0] ?? null
    }
    if (plan.tool === 'apply_watermark' || plan.routedTool === 'apply_watermark') {
      const rawAssetId = asString(plan.params.asset_id)?.replace(/^@/, '')
      const mention = rawAssetId
        ? commandMentionAssets.find((candidate) =>
            candidate.artifactId === rawAssetId
            || candidate.cellAddress.toLowerCase() === rawAssetId.toLowerCase())
        : undefined
      const explicitAssetId = mention?.artifactId ?? rawAssetId
      const target = resolveWatermarkTarget(
        explicitAssetId,
        selectedNotebookCell,
        assets,
        new Map(commandMentionAssets.map((asset) => [asset.artifactId, asset.cellAddress])),
      )
      if (!target.ok) return { ok: false, message: target.message }
      const sharedStartSeconds = asNumber(plan.params.start_seconds)
      const sharedEndSeconds = asNumber(plan.params.end_seconds)
      const qrStartSeconds = asNumber(plan.params.qr_start_seconds) ?? sharedStartSeconds
      const qrEndSeconds = asNumber(plan.params.qr_end_seconds) ?? sharedEndSeconds
      const handleStartSeconds = asNumber(plan.params.handle_start_seconds) ?? sharedStartSeconds
      const handleEndSeconds = asNumber(plan.params.handle_end_seconds) ?? sharedEndSeconds
      const sharedOpacity = asNumber(plan.params.opacity)
      const qrOpacity = asNumber(plan.params.qr_opacity) ?? sharedOpacity
      const handleOpacity = asNumber(plan.params.handle_opacity) ?? sharedOpacity
      const handleVerticalPercent = asNumber(plan.params.handle_vertical_percent)
      const handlePadding = asNumber(plan.params.handle_padding)
      const handleRounding = asNumber(plan.params.handle_rounding)
      const requestedPosition = plan.params.position
      openWatermarkReview(target.artifactId, target.label, {
        ...(asString(plan.params.handle)
          ? { handle: asString(plan.params.handle) ?? undefined }
          : {}),
        ...(asString(plan.params.url)
          ? { url: asString(plan.params.url) ?? undefined }
          : {}),
        ...(typeof plan.params.include_qr === 'boolean'
          ? { includeQr: plan.params.include_qr }
          : {}),
        ...(isWatermarkPosition(requestedPosition)
          ? { position: requestedPosition }
          : {}),
        ...(handleVerticalPercent !== null
          ? { handleVerticalPercent: clampHandleVerticalPercent(handleVerticalPercent) }
          : {}),
        ...(typeof plan.params.include_x_icon === 'boolean'
          ? { includeXIcon: plan.params.include_x_icon }
          : {}),
        ...(typeof plan.params.include_handle_border === 'boolean'
          ? { includeHandleBorder: plan.params.include_handle_border }
          : {}),
        ...(handlePadding !== null
          ? { handlePadding: clampHandlePadding(handlePadding) }
          : {}),
        ...(handleRounding !== null
          ? { handleRounding: clampHandleRounding(handleRounding) }
          : {}),
        ...(qrOpacity !== null
          ? { qrOpacity: clampWatermarkOpacity(qrOpacity) }
          : {}),
        ...(handleOpacity !== null
          ? { handleOpacity: clampWatermarkOpacity(handleOpacity) }
          : {}),
        ...(qrStartSeconds !== null && qrStartSeconds >= 0
          ? { qrStartSeconds }
          : {}),
        ...(qrEndSeconds !== null && qrEndSeconds >= 0
          ? { qrEndSeconds }
          : {}),
        ...(handleStartSeconds !== null && handleStartSeconds >= 0
          ? { handleStartSeconds }
          : {}),
        ...(handleEndSeconds !== null && handleEndSeconds >= 0
          ? { handleEndSeconds }
          : {}),
        ...(typeof plan.params.save_default === 'boolean'
          ? { saveDefault: plan.params.save_default }
          : {}),
      })
      return applyReadyOutcome(`Watermark review ready for ${target.label}`)
    }
    if (plan.tool === 'extract_audio') {
      const sourceReference = routedAssetReference(plan.params.asset_id)
      if (!sourceReference) {
        return { ok: false, message: 'Sol did not select a video source.' }
      }
      return await runNotebookAudioCommandNow({ sourceReference })
    }
    if (plan.tool === 'extract_first_frame' || plan.tool === 'extract_last_frame') {
      const sourceReference = routedAssetReference(plan.params.asset_id)
      if (!sourceReference) {
        return { ok: false, message: 'Sol did not select a video source.' }
      }
      const command: NotebookFrameCommand = {
        frameMode: plan.tool === 'extract_last_frame' ? 'last' : 'first',
        sourceReference,
      }
      if (plan.confirmation.required === false) {
        return await runNotebookFrameCommandNow(command)
      }
      return await previewNotebookFrameCommand(command)
    }
    if (plan.tool === 'extract_frame') {
      const sourceReference = routedAssetReference(plan.params.asset_id)
      const timestampSeconds = asNumber(plan.params.timestamp)
      if (!sourceReference || timestampSeconds === null || timestampSeconds < 0) {
        return {
          ok: false,
          message: 'Sol did not select a valid video source and timestamp.',
        }
      }
      const command: NotebookFrameCommand = {
        frameMode: 'time',
        sourceReference,
        timestampSeconds,
      }
      if (plan.confirmation.required === false) {
        return await runNotebookFrameCommandNow(command)
      }
      return await previewNotebookFrameCommand(command)
    }
    if (plan.tool === 'split_video') {
      const sourceReference = routedAssetReference(plan.params.asset_id)
      const splitAtSeconds = asNumber(plan.params.chunk_a_end)
      if (!sourceReference || !splitAtSeconds || splitAtSeconds <= 0) {
        return { ok: false, message: 'Sol did not select a valid split source and time.' }
      }
      return await previewNotebookSplitCommand({
        sourceReference,
        cutPointsSeconds: [splitAtSeconds],
      })
    }
    if (
      plan.tool === 'split_video_by_durations'
      && plan.params.destination === undefined
    ) {
      const sourceReference = routedAssetReference(plan.params.asset_id)
      const rawTargets = Array.isArray(plan.params.target_secs)
        ? plan.params.target_secs
        : [7]
      const targets = rawTargets.map(asNumber)
      if (targets.some((target) => target === null || target <= 0)) {
        return { ok: false, message: 'Sol did not select valid split durations.' }
      }
      if (sourceReference) {
        return await previewNotebookSplitCommand({
          sourceReference,
          cutPointsSeconds: durationTargetsToCutPoints(targets as number[]),
        })
      }
    }
    if (plan.effect === 'generation') {
      const cellType = generationCellTypeForRoutedTool(
        plan.tool,
        plan.routedTool,
        generationActions,
      )
      // TTS routes carry the spoken words in text rather than prompt.
      const rawRoutedPrompt = (plan.tool === 'generate_elevenlabs_text_to_audio'
        ? asString(plan.params.text) ?? asString(plan.params.prompt)
        : asString(plan.params.prompt))
        ?? originalInput
      const routedPrompt = restoreNotebookMentionAliases(
        rawRoutedPrompt,
        commandMentionAssets,
      )
      const parameterReferenceInput = notebookChatGenerationParameterReferences(
        plan.params,
      ).map((reference) => restoreNotebookMentionAliases(
        `@${reference}`,
        commandMentionAssets,
      )).join(' ')
      const parameterReferences = notebookChatGenerationReferences(
        parameterReferenceInput,
      )
      const promptReferences = notebookChatGenerationReferences(routedPrompt)
      const command: NotebookChatGenerationCommand = {
        cellType,
        mediaKind: generationMediaKind(cellType),
        prompt: rawRoutedPrompt,
        sourceReferences: parameterReferences.length > 0
          ? parameterReferences
          : promptReferences.length > 0
            ? promptReferences
            : notebookChatGenerationReferences(originalInput),
      }
      return await previewNotebookGenerationCommand(command, {
        preferredTool: plan.tool,
        reason: plan.confirmation.reason,
        routedParams: plan.params,
        summary: plan.summary,
      })
    }
    if (plan.confirmation.required === false) {
      return await executeRoutedChatActionNow(plan)
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
    setPendingChatAction((current) => current?.kind === 'generation'
      && current.draft.cell.id === preparedAction.draft.cell.id
      ? {
          ...current,
          draft: preparedAction.draft,
          previewError: null,
          previewLoading: true,
          previewStale: false,
        }
      : current)
    let validatedPreview: unknown
    try {
      validatedPreview = await loadPendingGenerationPreview(
        preparedAction.draft,
        currentNotebook,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setPendingChatAction((current) => current?.kind === 'generation'
        && current.draft.cell.id === preparedAction.draft.cell.id
        ? {
            ...current,
            draft: preparedAction.draft,
            previewError: message,
            previewLoading: false,
            previewStale: false,
          }
        : current)
      return {
        ok: false,
        message,
        nextInput: retryInput,
        selectInput: false,
      }
    }
    setPendingChatAction((current) => current?.kind === 'generation'
      && current.draft.cell.id === preparedAction.draft.cell.id
      ? {
          ...current,
          draft: preparedAction.draft,
          preview: validatedPreview,
          previewError: null,
          previewLoading: false,
          previewStale: false,
        }
      : current)
    const referenceError = providerPayloadPreviewReferenceError(validatedPreview)
    if (referenceError) {
      return {
        ok: false,
        message: referenceError,
        nextInput: retryInput,
        selectInput: false,
      }
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
    rememberLastWorkSlot(preparedAction.draft.cell.slot)
    selectCanvasCell(cellId)
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
      const acceptedRecord = recordValue(accepted)
      const runId = asString(acceptedRecord?.run_id)
      const jobOperationId = asString(acceptedRecord?.job_id)
      const outputCellId = asString(acceptedRecord?.output_cell_id)
      setPendingChatAction(null)
      setCellQueued(cellId, false)
      if (!runId || !jobOperationId) {
        await refreshBookData(bookId, currentNotebook.id).catch(() => undefined)
        return {
          ok: true,
          message: `${cellAddress} was accepted; follow its status in Jobs`,
        }
      }
      setNotice(`${cellAddress} queued`)
      const watchCellId = outputCellId ?? cellId
      let address = notebookGridAddress(preparedAction.draft.cell.slot)
      if (outputCellId) {
        const refreshed = await refreshNotebook(bookId, currentNotebook.id)
          .catch(() => null)
        revealCells([outputCellId])
        setCellQueued(outputCellId, true)
        const output = refreshed?.cells.find((candidate) =>
          candidate.id === outputCellId)
        if (output) address = notebookGridAddress(output.slot)
      }
      void watchGenerationRun({
        bookId,
        notebookId: currentNotebook.id,
        cellId: watchCellId,
        address,
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
          const created = recordValue(await call('create_notebook_cell', {
            book_id: bookId,
            notebook_id: currentNotebook.id,
            ...revisionInput,
            cell: {
              type: action.cellType,
              slot: destination,
              ...(action.cellType === 'prompt'
                || action.cellType === 'analyze'
                || isNotebookGenerationCellType(action.cellType)
                ? { prompt: '' }
                : {}),
            },
          }))
          const cellId = asString(created?.id)
          if (cellId) selectCanvasCell(cellId)
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
    return await executeRoutedChatActionNow(pendingChatAction.plan)
  }

  const executeCommand = async (
    input: string,
    context?: { speakVoiceId?: string },
  ): Promise<ComposerOutcome> => {
    try {
      const normalizedInput = input.trim().toLowerCase()
      const applyCommand = parsePendingApplyCommand(input)
      if (applyCommand) {
        if (
          applyCommand.promptOverride
          && (pendingWatermarkReview || pendingChatAction?.kind !== 'generation')
        ) {
          return {
            ok: false,
            message: 'A quick prompt can only revise a pending generation.',
            nextInput: input,
            selectInput: false,
          }
        }
        if (pendingWatermarkReview) return await submitWatermark()
        if (pendingChatAction) {
          return await applyPendingChatAction(applyCommand.promptOverride)
        }
        if (pendingCommandPlan) return await applyPendingCommandPlan()
        return { ok: false, message: 'There is no pending action to apply.' }
      }
      if (normalizedInput === '/cancel') {
        if (!pendingWatermarkReview && !pendingChatAction && !pendingCommandPlan) {
          return { ok: false, message: 'There is no pending action to cancel.' }
        }
        setPendingWatermarkReview(null)
        setPendingChatAction(null)
        setPendingCommandPlan(null)
        return { ok: true, message: 'Pending action cancelled' }
      }
      if (pendingWatermarkReview) setPendingWatermarkReview(null)
      if (!bookId) return { ok: false, message: 'Load or create a book first.' }
      if (!input.startsWith('/')) {
        const routed = await call('chat', {
          book_id: bookId,
          ...(notebook ? { notebook_id: notebook.id } : {}),
          prompt: input,
          model: chatModel,
        })
        const routedRecord = recordValue(routed)
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
      const resolvedRest = commandToken.toLowerCase() === '/duplicate'
        ? [
            resolveNotebookMentionAliases(
              restParts[0] ?? '',
              commandMentionAssets,
            ),
            ...restParts.slice(1),
          ].filter(Boolean).join(' ')
        : resolveNotebookMentionAliases(
            rest,
            commandMentionAssets,
          )
      if (commandToken === '/extract-audio') {
        if (!notebook || restParts.length !== 1) {
          return { ok: false, message: 'Usage: /extract-audio @video' }
        }
        return await runNotebookAudioCommandNow({
          sourceReference: normalizeNotebookReference(restParts[0]),
        })
      }
      if (commandToken === '/split') {
        const command = parseNotebookSplitCommand(input)
        if (!command) {
          return { ok: false, message: 'Usage: /split @video [at 5s, 12.5s] | keep 0.03-0.11 | remove 0.03-0.11' }
        }
        return await previewNotebookSplitCommand(command)
      }
      if (
        (commandToken === '/split-chunks' || commandToken === '/even-split')
        && /^@[a-z](?:[1-9]|1[0-3])$/iu.test(restParts[0] ?? '')
      ) {
        const [sourceValue, ...targetValues] = restParts
        const targets = (targetValues.length > 0 ? targetValues : ['7'])
          .map((value) => Number(value.replace(/\s*s(?:ec(?:onds?)?)?$/iu, '')))
        if (targets.some((value) => !Number.isFinite(value) || value <= 0)) {
          return { ok: false, message: 'Split durations must be positive seconds.' }
        }
        return await previewNotebookSplitCommand({
          sourceReference: normalizeNotebookReference(sourceValue!),
          cutPointsSeconds: durationTargetsToCutPoints(targets),
        })
      }
      if (commandToken === '/rough-cut') {
        return await prepareRoughCut('slash')
      }
      if (commandToken === '/sound-effects') {
        return await prepareSoundEffects('slash')
      }
      if (commandToken === '/generate-cell') {
        if (!notebook || restParts.length !== 1) {
          return { ok: false, message: 'Usage: /generate-cell @cell-id' }
        }
        const token = normalizeNotebookReference(restParts[0])
        const cell = notebook.cells.find((candidate) =>
          candidate.id.toLowerCase().startsWith(token))
        if (
          !cell
          || !notebookCellSupportsGenerateCellCommand(cell)
        ) {
          return { ok: false, message: 'Choose a configured generation cell' }
        }
        return await prepareGenerationPlan(cell.id, 'slash')
      }
      if (
        commandToken === '/arrange-videos-column'
        || commandToken === '/arrange-videos-row'
      ) {
        const anchor = selectedNotebookCell?.slot ?? lastWorkSlot
        if (!anchor) {
          return { ok: false, message: 'Select a cell to anchor the arrangement' }
        }
        return await arrangeVideoCellsOnAxis(
          commandToken === '/arrange-videos-column' ? 'column' : 'row',
          anchor,
        )
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
        const invalid = recordValue(value)
        if (invalid?.kind === 'invalid-export') {
          const validation = recordValue(invalid.validation)
          const errors = Array.isArray(validation?.errors)
            ? validation.errors.map((entry) =>
                asString(recordValue(entry)?.message)).filter(Boolean)
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
        const name = command.command.slice(1)
        const target = books.find((book) =>
          book.name.toLowerCase() === name.toLowerCase())
        if (!target) return { ok: false, message: `Book not found: ${name}` }
        const result = await chooseBook(target.bookId)
        return result.ok
          ? { ok: true, message: `Opened ${target.name}` }
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
      if (command.uiAction === 'speak_preview') {
        const parsed = parseCommandArgs(resolvedRest, command.params)
        const action = resolveSpeakPreviewAction({
          command: command.command,
          text: asString(parsed.text) ?? '',
          voiceId: context?.speakVoiceId,
          hasNotebook: Boolean(notebook),
        })
        if (action.kind === 'prefill') {
          return {
            ok: true,
            message: action.message,
            nextInput: action.nextInput,
            selectInput: false,
          }
        }
        if (action.kind === 'error') {
          return { ok: false, message: action.message }
        }
        return await runSpeakGeneration(action.text, action.voiceId)
      }
      if (command.uiAction === 'open_watermark') {
        const parsed = parseCommandArgs(resolvedRest, command.params)
        const target = resolveWatermarkTarget(
          asString(parsed.asset_ref) ?? undefined,
          selectedNotebookCell,
          assets,
          new Map(commandMentionAssets.map((asset) => [asset.artifactId, asset.cellAddress])),
        )
        if (!target.ok) return { ok: false, message: target.message }
        openWatermarkReview(target.artifactId, target.label)
        return applyReadyOutcome(`Watermark review ready for ${target.label}`)
      }
      if (!command.mcpTool) return { ok: false, message: `${command.command} is available from its workspace.` }
      if (command.mcpTool.tool === 'download_video' && !notebook) {
        return { ok: false, message: 'Open a notebook before downloading media.' }
      }
      const parsed = parseCommandArgs(resolvedRest, command.params)
      const adapted = adaptCommandArgs(command.mcpTool.adapter, parsed)
      const args: CommandToolArgs = {
        ...adapted,
        ...(command.mcpTool.injectParams ?? {}),
      }
      if (command.mcpTool.autoInject?.includes('book_id')) args.book_id = bookId
      if (command.mcpTool.autoInject?.includes('notebook_id') && notebook) {
        args.notebook_id = notebook.id
      }
      const result = await call(command.mcpTool.tool, args)
      if (command.mcpTool.tool === 'download_video' && notebook) {
        return await completeVideoDownload(result, asString(args.url) ?? '')
      }
      const routedCells = notebook
        ? routedMediaCellInputs(command.mcpTool.tool, result, notebook.cells, lastWorkSlot)
        : []
      if (notebook && routedCells.length > 0) {
        const placements: string[] = []
        let firstCellId: string | null = null
        for (const cell of routedCells) {
          const created = recordValue(await call('create_notebook_cell', {
            book_id: bookId,
            notebook_id: notebook.id,
            cell,
          }))
          const cellId = asString(created?.id)
          if (!cellId) {
            throw new Error('The server did not return the new notebook cell')
          }
          firstCellId ??= cellId
          placements.push(notebookGridTag(cell.slot))
        }
        selectCanvasCell(firstCellId)
        await refreshBookData(bookId, notebook.id)
        const message = `Created ${placements.join(' and ')}`
        setNotice(message)
        return { ok: true, message }
      }
      await refreshBookData(bookId, notebook?.id)
      if (command.mcpTool.tool === 'rename_asset') {
        const renamed = recordValue(result)
        const newLabel = asString(renamed?.label)
        return {
          ok: true,
          message: newLabel ? `Renamed asset to ${newLabel}` : 'Asset renamed',
        }
      }
      return { ok: true, message: messageFor(result, `${command.command} complete`) }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  const executeComposerCommand = async (
    input: string,
    context?: { speakVoiceId?: string },
  ): Promise<ComposerOutcome> => {
    const session = mediaFullscreen?.asset.type === 'image'
      ? mediaFullscreen
      : null
    if (!session) return await executeCommand(input, context)
    if (input.startsWith('/')) {
      return {
        ok: false,
        message: 'Close the image editor to run notebook commands.',
        nextInput: input,
        selectInput: false,
      }
    }
    if (session.subjectMap?.status !== 'ready') {
      return {
        ok: false,
        message: session.subjectMap?.status === 'analyzing'
          ? 'Wait for people and object analysis to finish before editing.'
          : 'Analyze the image before describing an edit.',
        nextInput: input,
        selectInput: false,
      }
    }
    const selectedSubjects = session.subjectMap.subjects.filter((subject) =>
      mediaFullscreenSelectedSubjectIds.includes(subject.id))
    if (selectedSubjects.length === 0) {
      return {
        ok: false,
        message: 'Select at least one person or object to edit.',
        nextInput: input,
        selectInput: false,
      }
    }
    const queued = await editFullscreenSubjects(session, {
      operation: 'edit',
      subjectIds: selectedSubjects.map((subject) => subject.id),
      prompt: input,
    })
    if (!queued) {
      return {
        ok: false,
        message: 'The image edit was not queued.',
        nextInput: input,
        selectInput: false,
      }
    }
    return {
      ok: true,
      message: `Image edit queued for ${selectedSubjects.length} ${selectedSubjects.length === 1 ? 'subject' : 'subjects'}.`,
    }
  }

  const setHoveredMediaDropSlot = (slot: NotebookGridSlot | null) => {
    setMediaDropSlot((current) => (
      current?.row === slot?.row && current?.column === slot?.column
        ? current
        : slot
    ))
  }

  const openMediaDropSlotAt = (
    clientX: number,
    clientY: number,
  ): NotebookGridSlot | null => {
    if (busy) return null
    const point = flowRef.current?.screenToFlowPosition({ x: clientX, y: clientY })
    if (!point) return null
    const slot = notebookGridSquareAt(point, notebookMetrics)
    if (!slot) return null
    return nodes.some((node) =>
      node.data.slot.row === slot.row
      && node.data.slot.column === slot.column)
      ? null
      : slot
  }

  const handleAppFileDragEnter = (event: DragEvent<HTMLElement>) => {
    if (screen !== 'notebook' || !dataTransferHasFiles(event.dataTransfer)) return
    setMediaDropActive(true)
  }

  const handleAppFileDragLeave = (event: DragEvent<HTMLElement>) => {
    if (screen !== 'notebook' || !dataTransferHasFiles(event.dataTransfer)) return
    const relatedTarget = event.relatedTarget
    if (
      relatedTarget instanceof Element
      && event.currentTarget.contains(relatedTarget)
    ) return
    setMediaDropActive(false)
    setHoveredMediaDropSlot(null)
  }

  const handleAppFileDragOver = (event: DragEvent<HTMLElement>) => {
    if (!dataTransferHasFiles(event.dataTransfer)) return
    event.preventDefault()
  }

  const handleAppFileDropCapture = (event: DragEvent<HTMLElement>) => {
    if (!dataTransferHasFiles(event.dataTransfer)) return
    setMediaDropActive(false)
    setHoveredMediaDropSlot(null)
  }

  const handleAppFileDrop = (event: DragEvent<HTMLElement>) => {
    if (!dataTransferHasFiles(event.dataTransfer) || event.defaultPrevented) return
    event.preventDefault()
    if (screen === 'notebook') {
      setNotice('Drop one image, video, or audio file on an open grid square', 'error')
    }
  }

  const handleNotebookFlowDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!dataTransferHasFiles(event.dataTransfer)) return
    const relatedTarget = event.relatedTarget
    if (
      relatedTarget instanceof Element
      && event.currentTarget.contains(relatedTarget)
    ) return
    setHoveredMediaDropSlot(null)
  }

  const handleNotebookFlowDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    if (dataTransferHasFiles(event.dataTransfer)) {
      setPreviewSlot(null)
      setMediaDropActive(true)
      const slot = openMediaDropSlotAt(event.clientX, event.clientY)
      setHoveredMediaDropSlot(slot)
      event.dataTransfer.dropEffect = slot ? 'copy' : 'none'
      return
    }
    setHoveredMediaDropSlot(null)
    const point = flowRef.current?.screenToFlowPosition({
      x: event.clientX,
      y: event.clientY,
    })
    if (point) {
      setPreviewSlot(notebookGridDropSlot(point, notebookBaseMetrics))
    }
  }

  const handleNotebookFlowDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    if (dataTransferHasFiles(event.dataTransfer)) {
      event.stopPropagation()
      setPreviewSlot(null)
      setMediaDropActive(false)
      setHoveredMediaDropSlot(null)
      if (busy) {
        setNotice('Wait for the current operation to finish', 'error')
        return
      }
      const files = [...event.dataTransfer.files]
      if (files.length !== 1) {
        setNotice('Drop one image, video, or audio file per square', 'error')
        return
      }
      const slot = openMediaDropSlotAt(event.clientX, event.clientY)
      if (!slot) {
        setNotice('Choose an open grid square for the media file', 'error')
        return
      }
      void createMediaCellFromFile(slot, files[0]!)
      return
    }
    const raw = event.dataTransfer.getData('application/x-videobook-cell')
    if (!isNotebookCellAddType(raw)) return
    const point = flowRef.current?.screenToFlowPosition({
      x: event.clientX,
      y: event.clientY,
    })
    setPreviewSlot(null)
    void createCell(raw, point)
  }

  const navigate = (next: Screen) => {
    closeCellContextMenu()
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
  const mediaLibraryDialogState: MediaLibraryDialogState | null = mediaLibraryPicker
    ? {
        ...mediaLibraryPicker,
        mode: mediaLibraryReference.state.mode,
        reference: mediaLibraryReference.state.reference,
        referenceStartSeconds: mediaLibraryReference.state.startSeconds,
        referenceDurationSeconds: mediaLibraryReference.state.durationSeconds,
        preparingReference: mediaLibraryReference.state.preparing,
        error: mediaLibraryReference.state.error ?? mediaLibraryPicker.error,
      }
    : null
  const updateMediaLibraryDraft = (query: string) => {
    setMediaLibraryPicker((current) => current ? { ...current, draftQuery: query } : current)
  }
  const changeMediaLibraryMode = (mode: MediaSearchMode) => {
    if (!mediaLibraryPicker || mediaLibraryReference.state.mode === mode) return
    const cellId = mediaLibraryPicker.cellId
    mediaLibraryReference.lifecycle.changeMode(mode)
    setMediaLibraryPicker((current) => current && current.cellId === cellId
      ? {
          ...current,
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
    if (!mediaLibraryPicker || mediaLibraryReference.state.mode === 'text' || !bookId) return
    const picker = mediaLibraryPicker
    const mode = mediaLibraryReference.state.mode
    setMediaLibraryPicker((current) => current && current.cellId === picker.cellId
      ? { ...current, error: null }
      : current)
    const result = await mediaLibraryReference.lifecycle.prepare(
      mode,
      () => uploadSearchReference(file, bookId, referenceKind(mode)),
    )
    if (result.status === 'error') {
      setNotice(result.error, 'error')
      return
    }
    if (result.status === 'stale') return
    await loadMediaLibrary(picker.cellId, '', 0, false, {
      mode: result.mode,
      reference: result.reference,
      referenceStartSeconds: '0',
      referenceDurationSeconds: '',
    })
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
          error: null,
        }
      : current)
    const result = await mediaLibraryReference.lifecycle.prepare(
      mode,
      () => prepareExistingSearchReference(call, {
        sourceBookId: asset.owningBookId,
        sourceArtifactId: asset.artifactId,
        mode,
        previewUrl: mode === 'image-reverse'
          ? asset.thumbnailUrl ?? asset.mediaUrl
          : asset.mediaUrl,
      }),
    )
    if (result.status === 'error') {
      setNotice(result.error, 'error')
      return
    }
    if (result.status === 'stale') return
    await loadMediaLibrary(picker.cellId, '', 0, false, {
      mode: result.mode,
      reference: result.reference,
      referenceStartSeconds: '0',
      referenceDurationSeconds: '',
    })
  }
  const clearMediaLibraryReference = () => {
    if (!mediaLibraryPicker) return
    mediaLibraryReference.lifecycle.clearReference()
    setMediaLibraryPicker((current) => current ? { ...current, error: null } : current)
  }
  const searchMediaLibrary = () => {
    if (!mediaLibraryPicker) return
    mediaLibraryReference.lifecycle.clearError()
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

  const openCellInspector = (cellId: string) => {
    selectCanvasCell(cellId)
    setSourceViewCellId(null)
    setGenerationsViewCellId(null)
    setInspectorOpen(true)
  }

  const openCellSource = (cellId: string) => {
    selectCanvasCell(cellId)
    setGenerationsViewCellId(null)
    setSourceViewCellId(cellId)
    setInspectorOpen(true)
  }

  const openCellGenerations = (cellId: string) => {
    selectCanvasCell(cellId)
    setSourceViewCellId(null)
    setGenerationsViewCellId(cellId)
    setInspectorOpen(true)
    if (!notebook || !bookId) {
      setGenerationsState({
        cellId,
        loading: false,
        error: 'Notebook is unavailable',
        attempts: [],
        currentExecution: null,
      })
      return
    }
    setGenerationsState({
      cellId,
      loading: true,
      error: null,
      attempts: [],
      currentExecution: null,
    })
    void call('list_cell_generations', {
      book_id: bookId,
      notebook_id: notebook.id,
      cell_id: cellId,
      limit: 20,
    }, { background: true })
      .then((payload) => {
        const data = payload as {
          attempts?: CellGenerationAttempt[]
          currentExecution?: NotebookCellExecution | null
        }
        setGenerationsState((current) => current?.cellId === cellId
          ? {
              cellId,
              loading: false,
              error: null,
              attempts: Array.isArray(data.attempts) ? data.attempts : [],
              currentExecution: data.currentExecution ?? null,
            }
          : current)
      })
      .catch((cause: unknown) => {
        setGenerationsState((current) => current?.cellId === cellId
          ? {
              cellId,
              loading: false,
              error: cause instanceof Error ? cause.message : String(cause),
              attempts: [],
              currentExecution: null,
            }
          : current)
      })
  }

  const contextMenuCell = cellContextMenu
    ? notebook?.cells.find((cell) => cell.id === cellContextMenu.cellId) ?? null
    : null
  const contextMenuNode = cellContextMenu
    ? presentedNodes.find((node) => node.id === cellContextMenu.cellId) ?? null
    : null
  const contextMenuRunAction = contextMenuNode
    ? notebookCellActionPresentation({
        type: contextMenuNode.data.kind,
        model: contextMenuNode.data.model,
        operation: contextMenuNode.data.operation,
        outputArtifactId: contextMenuNode.data.outputArtifactId,
        tool: contextMenuNode.data.tool,
      }, contextMenuNode.data.status)
    : null
  const contextMenuMediaKind = contextMenuCell
    ? passiveMediaKind(contextMenuCell.type)
    : null
  const contextMenuEmptyMediaSlot = Boolean(
    contextMenuCell
    && contextMenuNode
    && contextMenuMediaKind
    && isEmptyPassiveMediaSlot(
      contextMenuCell.type,
      contextMenuCell.outputArtifactId,
      contextMenuNode.data.targetConnectionCount ?? 0,
    ),
  )
  const contextMenuVisualAsset = contextMenuNode?.data.asset
    && contextMenuNode.data.asset.type !== 'audio'
    && (contextMenuNode.data.asset.mediaUrl || contextMenuNode.data.asset.thumbnailUrl)
    ? contextMenuNode.data.asset
    : null
  const contextMenuDuplicateAssetId = contextMenuCell?.outputArtifactId
    && contextMenuNode?.data.asset
    && passiveMediaKindForAsset(contextMenuNode.data.asset.type)
    ? contextMenuCell.outputArtifactId
    : null
  const contextMenuDuplicateDestinationAvailable = Boolean(
    notebook
    && contextMenuCell
    && contextMenuDuplicateAssetId
    && contextMenuCell.slot.row + 1 < notebookGrid.maximumRowCount
    && !notebook.cells.some((cell) =>
      cell.slot.row === contextMenuCell.slot.row + 1
      && cell.slot.column === contextMenuCell.slot.column),
  )
  const contextMenuSplitSource = selectedCellId === cellContextMenu?.cellId
    ? selectedSplitSource
    : null
  const contextMenuGenerationTypes = contextMenuCell && notebook
    ? (['generate_video', 'generate_image'] as const).filter((cellType) => {
        try {
          planContextMenuGeneration({
            actions: generationActions,
            cellId: `context-menu-${cellType}`,
            cellType,
            document: notebook,
            lastWorkSlot,
            sourceCellId: contextMenuCell.id,
          })
          return true
        } catch {
          return false
        }
      })
    : []
  const contextMenuActions: NotebookCellContextAction[] = []
  if (contextMenuCell && contextMenuNode) {
    contextMenuActions.push({
      id: 'inspect',
      label: 'Edit cell',
      icon: 'inspect',
    })
    if (contextMenuRunAction) {
      contextMenuActions.push({
        id: 'run',
        label: notebookCellInspectorActionLabel(
          contextMenuCell.type,
          contextMenuRunAction.label,
        ),
        icon: 'run',
        disabled: busy || contextMenuRunAction.disabled,
      })
    }
    if (contextMenuEmptyMediaSlot) {
      contextMenuActions.push({
        id: 'library',
        label: 'Choose media',
        icon: 'library',
        disabled: busy,
      })
    }
    if (contextMenuVisualAsset) {
      contextMenuActions.push({
        id: 'media',
        label: 'Open media',
        icon: 'media',
      })
    }
    if (
      contextMenuVisualAsset
      && (contextMenuVisualAsset.type === 'video'
        || contextMenuVisualAsset.type === 'final')
    ) {
      contextMenuActions.push({
        id: 'extract_frame',
        label: 'Extract frame',
        icon: 'extract-frame',
        disabled: busy,
      })
    }
    for (const cellType of contextMenuGenerationTypes) {
      const video = cellType === 'generate_video'
      contextMenuActions.push({
        id: cellType,
        label: video ? 'Generate video' : 'Generate image',
        icon: video ? 'generate-video' : 'generate-image',
        disabled: busy,
      })
    }
    if (contextMenuDuplicateAssetId) {
      contextMenuActions.push({
        id: 'duplicate',
        label: 'Duplicate',
        icon: 'duplicate',
        disabled: busy || !contextMenuDuplicateDestinationAvailable,
      })
    }
    if (notebookVideoCellIds.size > 0) {
      contextMenuActions.push(
        {
          id: 'arrange_videos_column',
          label: 'Arrange videos in column',
          icon: 'arrange-column',
          disabled: busy,
        },
        {
          id: 'arrange_videos_row',
          label: 'Arrange videos in row',
          icon: 'arrange-row',
          disabled: busy,
        },
      )
    }
    if (contextMenuSplitSource) {
      contextMenuActions.push({
        id: 'split',
        label: 'Split video',
        icon: 'split',
        disabled: busy,
      })
    }
    contextMenuActions.push(
      {
        id: 'generations',
        label: 'View generations',
        icon: 'generations',
      },
      {
        id: 'source',
        label: 'View source',
        icon: 'source',
      },
    )
  }
  const duplicateContextMenuAsset = async () => {
    if (!contextMenuDuplicateAssetId || !bookId || !notebook) return
    setBusy(true)
    try {
      const result = recordValue(await call('duplicate_asset', {
        asset_id: contextMenuDuplicateAssetId,
        book_id: bookId,
        notebook_id: notebook.id,
      }))
      const cellId = asString(result?.cell_id)
      const address = asString(result?.address)
      if (!cellId || !address) {
        throw new Error('The server did not return the duplicated notebook cell')
      }
      await refreshBookData(bookId, notebook.id)
      selectCanvasCell(cellId)
      setNotice(`Duplicated as ${address}`)
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause), 'error')
    } finally {
      setBusy(false)
    }
  }
  const createContextMenuGeneration = async (
    cellType: ContextMenuGenerationCellType,
  ) => {
    if (!bookId || !notebook || !contextMenuCell) return
    const notebookId = notebook.id
    const sourceCellId = contextMenuCell.id
    setBusy(true)
    try {
      const currentNotebook = asNotebook(await call('get_notebook', {
        book_id: bookId,
        notebook_id: notebookId,
      }))
      if (!currentNotebook) {
        throw new Error('The server returned an invalid notebook')
      }
      const draft = planContextMenuGeneration({
        actions: generationActions,
        cellId: uuidv7(),
        cellType,
        document: currentNotebook,
        lastWorkSlot,
        sourceCellId,
      })
      const materialized = await materializeNotebookChatGeneration({
        bookId,
        callTool: call,
        document: currentNotebook,
        draft,
        ...(currentNotebook.revision
          ? { expectedRevision: currentNotebook.revision }
          : {}),
      })
      rememberLastWorkSlot(draft.cell.slot)
      await refreshBookData(bookId, notebookId)
      openCellInspector(materialized.cellId)
      setNotice(
        `Added ${materialized.cellAddress} ${cellType === 'generate_video' ? 'video' : 'image'} generation from ${materialized.sourceAddresses[0]}`,
      )
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setBusy(false)
    }
  }
  const handleCellContextAction = (actionId: string) => {
    if (!contextMenuCell) return
    if (actionId === 'inspect') {
      openCellInspector(contextMenuCell.id)
      return
    }
    if (actionId === 'run') {
      void runCell(contextMenuCell.id)
      return
    }
    if (actionId === 'library') {
      openMediaLibrary(contextMenuCell.id)
      return
    }
    if (actionId === 'media' || actionId === 'extract_frame') {
      if (contextMenuVisualAsset) {
        openMediaFullscreen(
          contextMenuCell,
          contextMenuVisualAsset,
          cellContextMenu?.returnFocus ?? null,
        )
      }
      return
    }
    if (actionId === 'duplicate') {
      void duplicateContextMenuAsset()
      return
    }
    if (actionId === 'arrange_videos_column' || actionId === 'arrange_videos_row') {
      void arrangeVideoCellsOnAxis(
        actionId === 'arrange_videos_column' ? 'column' : 'row',
        contextMenuCell.slot,
      )
      return
    }
    if (actionId === 'generate_video' || actionId === 'generate_image') {
      void createContextMenuGeneration(actionId)
      return
    }
    if (actionId === 'split' && contextMenuSplitSource) {
      void previewNotebookSplitCommand({
        sourceReference: contextMenuSplitSource.source.id,
        cutPointsSeconds: [],
      }).then((outcome) => {
        if (!outcome.ok) setNotice(outcome.message, 'error')
      })
      return
    }
    if (actionId === 'generations') {
      openCellGenerations(contextMenuCell.id)
      return
    }
    if (actionId === 'source') openCellSource(contextMenuCell.id)
  }
  const deleteContextMenuCell = () => {
    if (contextMenuCell) void deleteNotebookCells([contextMenuCell])
  }
  const fullscreenImageEditor = mediaFullscreen?.asset.type === 'image'
    ? mediaFullscreen
    : null
  const imageReplacementCandidates = useMemo((): ImageReplacementCandidate[] => {
    if (!fullscreenImageEditor) return []
    return commandMentionAssets.flatMap((asset) => {
      if (asset.type !== 'image') return []
      if (asset.artifactId === fullscreenImageEditor.asset.artifactId) return []
      return [{
        artifactId: asset.artifactId,
        address: asset.cellAddress,
        label: asset.cellAddress,
        thumbnailUrl: asset.thumbnailUrl ?? asset.mediaUrl,
      }]
    })
  }, [commandMentionAssets, fullscreenImageEditor])
  const fullscreenSelectedSubjects = fullscreenImageEditor?.subjectMap?.subjects.filter(
    (subject) => mediaFullscreenSelectedSubjectIds.includes(subject.id),
  ) ?? []
  const fullscreenComposerContext = fullscreenImageEditor
    ? {
        label: `@${fullscreenImageEditor.address.toUpperCase()} IMAGE EDIT`,
        description: fullscreenSelectedSubjects.length > 0
          ? `${fullscreenSelectedSubjects.length} selected ${fullscreenSelectedSubjects.length === 1 ? 'subject' : 'subjects'}`
          : 'Select people or objects to edit',
      }
    : null
  const fullscreenComposerPlaceholder = !fullscreenImageEditor
    ? undefined
    : fullscreenImageEditor.subjectMap?.status !== 'ready'
      ? 'Analyze the image to find editable people and objects…'
      : fullscreenSelectedSubjects.length === 0
        ? 'Select people or objects to edit…'
        : `Describe how to edit ${fullscreenSelectedSubjects
            .slice(0, 2)
            .map((subject) => subject.label)
            .join(' and ')}…`
  const revealSuccessfulComposerResult = () => {
    if (!fullscreenImageEditor) revealLatestNotebookResult()
  }

  return (
    <main
      className={`app-shell app-screen-${screen} ${inspectorOpen ? 'inspector-visible' : 'inspector-hidden'} ${selectedCell ? 'inspector-detail' : 'inspector-overview'} ${mediaFullscreen ? 'media-fullscreen-open' : ''}`}
      onDragEnter={handleAppFileDragEnter}
      onDragLeave={handleAppFileDragLeave}
      onDragOver={handleAppFileDragOver}
      onDropCapture={handleAppFileDropCapture}
      onDrop={handleAppFileDrop}
    >
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
              <BookProjectMenu
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
          {screen === 'notebook' && notebook && (
            <div className="canvas-toolbar" aria-label="Notebook canvas controls">
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
              <NotebookCellAddMenu
                disabled={busy}
                onAdd={createCell}
                onDragEnd={() => setPreviewSlot(null)}
              />
              <button
                type="button"
                className="canvas-auto-arrange"
                title="Auto-arrange notebook"
                aria-label="Auto-arrange notebook"
                disabled={busy || mcp.state !== 'ready' || notebook.cells.length === 0}
                onClick={() => void autoArrangeNotebook()}
              >
                <Network size={15} />
              </button>
              {selectedNotebookCells.length > 0 && (
                <div
                  className="canvas-selection-actions"
                  aria-label="Notebook selection actions"
                  title="Drag across the canvas or Shift, Command, or Control-click to select more cells"
                >
                  <span>
                    <strong>{selectedNotebookCells.length}</strong> selected
                  </span>
                  {selectedNotebookCells.length > 1 && selectedNotebookCell && (
                    <code>{notebookGridTag(selectedNotebookCell.slot)} active</code>
                  )}
                  <button
                    type="button"
                    className="canvas-delete-selection"
                    aria-label={`Delete ${selectedNotebookCells.length} selected ${selectedNotebookCells.length === 1 ? 'cell' : 'cells'}`}
                    aria-keyshortcuts="Delete Backspace"
                    disabled={busy}
                    onClick={() => void deleteSelectedCells()}
                  >
                    <Trash2 size={13} />
                    <span>Delete</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
        <nav className="header-navigation" aria-label="Workspace navigation">
          <button type="button" title="Refresh books" aria-label="Refresh books" disabled={busy || mcp.state !== 'ready'} onClick={() => void loadBooks(bookId)}>
            {busy ? <BusyIndicator size={17} /> : <RefreshCw size={17} />}
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
                  <div
                    className="notebook-horizontal-scroll"
                    ref={notebookScrollRef}
                    tabIndex={0}
                    aria-label="Notebook canvas"
                    onKeyDown={handleNotebookCanvasKeyDown}
                  >
                    <div
                      className="notebook-flow-frame"
                      style={notebookFlowStyle}
                    >
                      <MediaSlotContext.Provider value={mediaSlotContextValue}>
                        <CellRunContext.Provider value={runCell}>
                          <PrimaryCellContext.Provider value={selectedCellId}>
                            <GenerationTitlesContext.Provider value={generationTitleByTool}>
                              <CellContextMenuContext.Provider value={cellContextMenuContextValue}>
                                <ReactFlow<CanvasNode, NotebookFlowEdge>
                          className="notebook-flow"
                      nodes={canvasPresentationNodes}
                      edges={focusedEdges}
                      nodeTypes={nodeTypes}
                      edgeTypes={edgeTypes}
                      viewport={notebookViewport}
                      onViewportChange={updateNotebookViewport}
                      onInit={(instance) => {
                        flowRef.current = instance
                      }}
                      onNodesChange={(changes) => {
                        const selectionChanges = changes.filter((change) =>
                          change.type === 'select')
                        if (selectionChanges.length > 0) {
                          const nextSelection = new Set(selectedCellIdsRef.current)
                          for (const change of selectionChanges) {
                            if (change.selected) nextSelection.add(change.id)
                            else nextSelection.delete(change.id)
                          }
                          updateSelectedCellIds(nextSelection)
                          const nextId = [...nextSelection].at(-1) ?? null
                          setSelectedCellId((current) =>
                            current && nextSelection.has(current)
                              ? current
                              : nextId)
                          const rememberedCell = nextId
                            ? notebook?.cells.find((cell) => cell.id === nextId)
                            : undefined
                          const rememberedNode = nextId
                            ? nodes.find((item) => item.id === nextId)
                            : undefined
                          if (rememberedCell) {
                            rememberLastWorkSlot(rememberedCell.slot)
                          } else if (rememberedNode) {
                            rememberLastWorkSlot(rememberedNode.data.slot)
                          }
                        }
                        setNodes((current) => {
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
                        })
                      }}
                      onEdgesChange={(changes) => {
                        setEdges((current) => applyEdgeChanges(changes, current))
                        const removed = changes.filter((change) => change.type === 'remove').map((change) => change.id)
                        if (removed.length > 0) void removeEdges(removed)
                      }}
                      onNodeClick={(_event, node) => {
                        const currentSelection = selectedCellIdsRef.current
                        const nextId = currentSelection.has(node.id)
                          ? node.id
                          : [...currentSelection].at(-1) ?? null
                        setSelectedCellId(nextId)
                        if (nextId === node.id) {
                          rememberLastWorkSlot(node.data.slot)
                        }
                        setSourceViewCellId(null)
                        setInspectorOpen(true)
                      }}
                      onPaneClick={() => {
                        closeCellContextMenu()
                        selectCanvasCell(null)
                        setSourceViewCellId(null)
                      }}
                      onNodeDrag={(_event, node) => {
                        closeCellContextMenu()
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
                                        if (movedNodes.length > 0) {
                          const moved = movedNodes.find((item) => item.id === node.id)
                            ?? movedNodes[0]
                          if (moved) rememberLastWorkSlot(moved.data.slot)
                          void persistSlots(movedNodes)
                        }
                      }}
                      onConnect={(connection) => void connectCells(connection)}
                      onDrop={handleNotebookFlowDrop}
                      onDragLeave={handleNotebookFlowDragLeave}
                      onDragOver={handleNotebookFlowDragOver}
                      minZoom={notebookGrid.minimumZoom}
                      maxZoom={notebookGrid.maximumZoom}
                      defaultEdgeOptions={notebookDefaultEdgeOptions}
                      elementsSelectable
                      multiSelectionKeyCode={notebookMultiSelectionKeys}
                      panOnDrag={notebookPanOnDragButtons}
                      panOnScroll={false}
                      selectionKeyCode={null}
                      selectionMode={SelectionMode.Partial}
                      selectionOnDrag
                      selectNodesOnDrag={false}
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
                              occupiedSlots={notebookOccupiedSlots}
                              previewSlot={previewSlot}
                              mediaDropActive={mediaDropActive && !busy}
                              mediaDropSlot={mediaDropSlot}
                            />
                                </ReactFlow>
                              </CellContextMenuContext.Provider>
                            </GenerationTitlesContext.Provider>
                          </PrimaryCellContext.Provider>
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
                    <PanelRightOpen size={18} />
                  </button>
                )}
              </section>
              <aside
                className={[
                  'inspector',
                  inspectorOpen ? '' : 'inspector-closed',
                  selectedCell && deletingCellIds.has(selectedCell.id)
                    ? 'inspector-deleting'
                    : '',
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
                      {selectedNotebookCell && (
                        <code className="inspector-cell-address">
                          {notebookGridTag(selectedNotebookCell.slot)}
                        </code>
                      )}
                    </span>
                  ) : (
                    <span>INSPECTOR</span>
                  )}
                  <div className="inspector-header-actions">
                    {selectedCell && (
                      <>
                        {selectedSplitSource && (
                          <button
                            type="button"
                            className="inspector-source-toggle"
                            title="Split video"
                            aria-label="Split video"
                            disabled={busy}
                            onClick={() => {
                              void previewNotebookSplitCommand({
                                sourceReference: selectedSplitSource.source.id,
                                cutPointsSeconds: [],
                              }).then((outcome) => {
                                if (!outcome.ok) setNotice(outcome.message, 'error')
                              })
                            }}
                          >
                            <Scissors size={15} />
                          </button>
                        )}
                        <button
                          type="button"
                          className={generationsViewCellId === selectedCell.id
                            ? 'inspector-source-toggle active'
                            : 'inspector-source-toggle'}
                          title={generationsViewCellId === selectedCell.id
                            ? 'View cell'
                            : 'View generations'}
                          aria-label={generationsViewCellId === selectedCell.id
                            ? 'View cell'
                            : 'View generations'}
                          aria-pressed={generationsViewCellId === selectedCell.id}
                          onClick={() => {
                            if (generationsViewCellId === selectedCell.id) {
                              setGenerationsViewCellId(null)
                              return
                            }
                            openCellGenerations(selectedCell.id)
                          }}
                        >
                          <History size={15} />
                        </button>
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
                          onClick={() => {
                            if (sourceViewCellId === selectedCell.id) {
                              setSourceViewCellId(null)
                              return
                            }
                            openCellSource(selectedCell.id)
                          }}
                        >
                          <Braces size={15} />
                        </button>
                      </>
                    )}
                    <button type="button" aria-label="Close inspector" onClick={() => setInspectorOpen(false)}>
                      <PanelRightClose size={16} />
                    </button>
                  </div>
                </header>
                {!selectedCell ? (
                  <div className="inspector-body">
                    <div className="empty-inspector compact">
                      <CircleDot size={18} />
                      <strong>Select a notebook cell</strong>
                      <p>Cell editing appears here.</p>
                    </div>
                  </div>
                ) : selectedNotebookCell ? (
                  <NotebookCellInspector
                    key={`${selectedNotebookCell.id}:${selectedNotebookCell.prompt ?? ''}`}
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
                    mentionAssets={commandMentionAssets}
                    voiceCatalog={elevenLabsVoices}
                    busy={busy || Boolean(selectedMediaSlotState?.operation)}
                    deleting={deletingCellIds.has(selectedNotebookCell.id)}
                    sourceVisible={sourceViewCellId === selectedNotebookCell.id}
                    generationsVisible={
                      generationsViewCellId === selectedNotebookCell.id
                    }
                    generations={
                      generationsState
                      && generationsState.cellId === selectedNotebookCell.id
                        ? {
                            attempts: generationsState.attempts,
                            currentExecution: generationsState.currentExecution,
                            loading: generationsState.loading,
                            error: generationsState.error,
                          }
                        : generationsViewCellId === selectedNotebookCell.id
                          ? {
                              attempts: [],
                              currentExecution: null,
                              loading: true,
                              error: null,
                            }
                          : undefined
                    }
                    onUpdate={updateCell}
                    onSetInput={setSelectedCellInput}
                    onRun={runCell}
                    onDelete={deleteSelectedCell}
                    onOpenFullscreen={(asset) => {
                      openMediaFullscreen(selectedNotebookCell, asset)
                    }}
                    onPreviewPayload={previewGenerationPayload}
                    onLoadGenerationPayload={loadGenerationPayload}
                    mediaInsightWork={mediaInsightWork}
                    onTranscribeAsset={transcribeAsset}
                    onLoadTranscriptJson={loadTranscriptJson}
                    onDownloadTranscriptSrt={exportTranscriptSrt}
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
                <div><span className="section-label">SEARCHABLE SOURCE LIBRARY</span><h1>Find the exact moment.</h1><p>Search language, speech, OCR, imagery, video motion, and audio across {activeBook?.name ?? 'the active project'}.</p></div>
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
                selectTimelineRange()
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
                <button type="submit" disabled={busy || !sequence}>
                  Set selection
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
                    disabled={busy || !sequence || sequence.captions.length === 0}
                    onClick={() => void prepareRoughCut('ui')
                      .then((outcome) => setNotice(outcome.message, outcome.ok ? 'info' : 'error'))}
                  >
                    Suggest rough cut
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
                    const result = recordValue(value)
                    if (result?.kind === 'invalid-export') {
                      const validation = recordValue(result.validation)
                      const errors = Array.isArray(validation?.errors)
                        ? validation.errors.map((entry) =>
                            asString(recordValue(entry)?.message)).filter(Boolean)
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

      {cellContextMenu && contextMenuCell && (
        <NotebookCellContextMenu
          actions={contextMenuActions}
          address={notebookGridTag(contextMenuCell.slot)}
          cellType={cellTypeLabel(contextMenuCell.type)}
          deleteDisabled={busy || deletingCellIds.has(contextMenuCell.id)}
          menuId={cellContextMenuId(contextMenuCell.id)}
          position={cellContextMenu.position}
          returnFocus={cellContextMenu.returnFocus}
          onAction={handleCellContextAction}
          onClose={closeCellContextMenu}
          onDelete={deleteContextMenuCell}
        />
      )}

      {mediaLibraryDialogState && mediaLibraryKind && (
        <MediaLibraryDialog
          state={mediaLibraryDialogState}
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
          onReferenceStart={mediaLibraryReference.lifecycle.setStartSeconds}
          onReferenceDuration={mediaLibraryReference.lifecycle.setDurationSeconds}
          onSimilar={(asset) => void prepareMediaLibrarySimilar(asset)}
        />
      )}

      {mediaFullscreen && (
        <NotebookMediaFullscreen
          key={mediaFullscreen.key}
          asset={mediaFullscreen.asset}
          address={mediaFullscreen.address}
          composerEditing={mediaFullscreenComposerSending}
          composerPortalRef={setMediaFullscreenComposerTarget}
          subjectMap={mediaFullscreen.subjectMap}
          subjectMapLoading={mediaFullscreen.subjectMapLoading}
          returnFocus={mediaFullscreen.returnFocus}
          analysisUnavailableReason={
            mediaFullscreen.asset.type === 'image'
            && !mediaFullscreen.asset.objectHash
              ? 'This version is missing its immutable object hash. Refresh the book data and reopen it.'
              : null
          }
          onAnalyzeSubjects={(force) =>
            analyzeFullscreenSubjects(mediaFullscreen, force)}
          onCaptureFrame={
            mediaFullscreen.asset.type === 'video'
            || mediaFullscreen.asset.type === 'final'
              ? (timestampSeconds) =>
                  captureFullscreenFrame(mediaFullscreen, timestampSeconds)
              : undefined
          }
          onEditingChange={setMediaFullscreenSidebarEditing}
          replacementCandidates={imageReplacementCandidates}
          onEditSubjects={(input) =>
            editFullscreenSubjects(mediaFullscreen, input)}
          onSelectedSubjectIdsChange={updateMediaFullscreenSelectedSubjectIds}
          onClose={closeMediaFullscreen}
        />
      )}

      <CommandComposer
        commands={commands}
        cells={notebook?.cells ?? []}
        bookId={bookId}
        callTool={call}
        chatModels={chatModelCatalog.models}
        disabled={
          busy
          || mediaFullscreenSidebarEditing
          || !bookId
          || mcp.state !== 'ready'
        }
        modelSelectionDisabled={!bookId || mcp.state !== 'ready'}
        connectionLabel={mediaFullscreenSidebarEditing
          ? 'Removing selected subjects…'
          : mcp.state === 'ready'
            ? 'Load a book to begin'
            : 'Connecting to MCP…'}
        mcpActivity={mcpActivity}
        selectedModel={chatModel}
        context={fullscreenComposerContext}
        inputSession={fullscreenImageEditor
          ? `image-edit:${fullscreenImageEditor.key}`
          : 'chat'}
        placeholder={fullscreenComposerPlaceholder}
        portalTarget={fullscreenImageEditor
          ? mediaFullscreenComposerTarget
          : null}
        pendingInput={fullscreenImageEditor
          ? undefined
          : pendingWatermarkReview
            ? '/apply'
            : pendingChatAction?.kind === 'generation'
            ? '/apply '
            : pendingCommandPlan || pendingChatAction
              ? '/apply'
              : undefined}
        notice={notice
          ? { message: notice.text, tone: notice.tone }
          : null}
        onEnsureCatalog={refreshComposerCatalog}
        onDismissNotice={() => setNoticeState(null)}
        onDismissPanel={!fullscreenImageEditor && (
          pendingWatermarkReview
          || pendingCommandPlan
          || pendingChatAction
        )
          ? dismissPendingCommandPlan
          : undefined}
        onExecute={executeComposerCommand}
        voiceCatalog={elevenLabsVoices}
        onModelChange={changeChatModel}
        onSendingChange={fullscreenImageEditor
          ? setMediaFullscreenComposerSending
          : undefined}
        onSuccessfulExecute={revealSuccessfulComposerResult}
      >
        {pendingWatermarkReview && (
          <Suspense fallback={null}>
            <WatermarkChatReview
              applyFormId={COMMAND_COMPOSER_FORM_ID}
              busy={busy}
              state={pendingWatermarkReview}
              onChange={(patch) => setPendingWatermarkReview((current) =>
                current ? { ...current, ...patch, error: null } : current)}
              onMediaMetadata={(metadata) => setPendingWatermarkReview((current) =>
                current
                  ? {
                      ...current,
                      durationSeconds: metadata.durationSeconds,
                      width: metadata.width,
                      height: metadata.height,
                    }
                  : current)}
              onCancel={dismissPendingCommandPlan}
            />
          </Suspense>
        )}
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
            sourceOptions={pendingGenerationSourceOptions}
            summary={pendingChatAction.summary}
            voiceCatalog={elevenLabsVoices}
            onActionChange={updatePendingGenerationAction}
            onAddSource={addPendingGenerationSource}
            onCancel={dismissPendingCommandPlan}
            onModeChange={updatePendingGenerationMode}
            onPromptChange={updatePendingGenerationPrompt}
            onRefreshPreview={refreshPendingGenerationPreview}
            onRemoveSource={removePendingGenerationSource}
            onSelectSource={selectPendingGenerationSource}
            onSettingChange={updatePendingGenerationSetting}
          />
        )}
        {pendingChatAction?.kind === 'split' && pendingSplitReview && (
          <VideoSegmentSplit
            applyFormId={COMMAND_COMPOSER_FORM_ID}
            availableEmptyCells={pendingSplitReview.availableEmptyCells}
            busy={busy}
            cutPointsSeconds={pendingSplitReview.cutPointsSeconds}
            mediaUrl={pendingSplitReview.mediaUrl}
            outputMode={pendingSplitReview.outputMode}
            selectedIndex={pendingSplitReview.selectedIndex}
            sourceDurationSeconds={pendingSplitReview.sourceDurationSeconds}
            sourceFps={pendingSplitReview.sourceFps}
            sourceLabel={pendingSplitReview.sourceLabel}
            onCancel={dismissPendingCommandPlan}
            onChange={updatePendingSplitSelection}
          />
        )}
        {pendingChatAction
          && pendingChatAction.kind !== 'generation'
          && (pendingChatAction.kind !== 'split' || !pendingSplitReview) && (
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
                  <Check size={14} />{pendingXPostPreview ? 'Post to X' : 'Apply'}
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
              <div className={`command-plan-content command-plan-content-single${(pendingChatAction.kind === 'routed'
                && !pendingChangeSpeedPreview
                && !pendingXPostPreview)
                ? ' command-plan-content-routed'
                : ''}`}>
                {pendingChatAction.kind !== 'routed' && (
                  <div className="command-plan-context">
                    <p>{pendingChatAction.kind === 'notebook'
                      ? pendingChatAction.plan.reason
                      : pendingChatAction.reason}</p>
                  </div>
                )}
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
                          : pendingChatAction.command.frameMode === 'time'
                            ? `Extract frame at ${pendingChatAction.command.timestampSeconds ?? 0}s`
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
                              className={setting.wide
                                ? setting.tone === 'warning'
                                  ? 'routed-action-setting-warning routed-action-setting-wide'
                                  : 'routed-action-setting-wide'
                                : setting.tone === 'warning'
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
                {pendingChatAction.kind === 'routed' && pendingChangeSpeedPreview && (
                  <div className="routed-action-preview" aria-label="Speed change preview">
                    {pendingChangeSpeedPreview.unavailableReason === null ? (
                      <SpeedChangePreview
                        key={pendingChangeSpeedPreview.mediaUrl ?? 'speed-preview'}
                        effectiveSpeed={pendingChangeSpeedPreview.effectiveSpeed}
                        mediaUrl={pendingChangeSpeedPreview.mediaUrl ?? ''}
                        thumbnailUrl={pendingChangeSpeedPreview.thumbnailUrl}
                      />
                    ) : (
                      <p className="routed-action-preview-fallback">
                        {`Preview unavailable — ${pendingChangeSpeedPreview.unavailableReason}.`}
                      </p>
                    )}
                  </div>
                )}
                {pendingChatAction.kind === 'routed' && pendingXPostPreview && (
                  <PostToXChatPreview {...pendingXPostPreview} />
                )}
              </div>
            </div>
          </aside>
        )}
      </CommandComposer>
    </main>
  )
}

export default App
