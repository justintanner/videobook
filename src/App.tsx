import { PostInspector } from '@/components/videobook/PostInspector'
import { insertVideoReviewError } from '@/videobook/insert-video-review'
import type { PostView } from '../server/src/posts/post-contract'
import { WATERMARK_PLATFORMS, isWatermarkPlatform } from '../server/src/watermark-platform'
import { ColdOpenBody } from '@/components/videobook/confirm/bodies/ColdOpenBody'
import { PostDeliveryBody } from '@/components/videobook/confirm/bodies/PostDeliveryBody'
import { useIcloudSyncPoll } from '@/videobook/use-icloud-sync-poll'
import {
  defaultDropboxFolder,
  defaultIcloudFolder,
  deliveryCaptionLocked,
  fetchDropboxConnection,
  fetchIcloudStatus,
  latestPostForSource,
  postDeliveryArgs,
  postDeliveryReceipt,
  postDeliveryTool,
  postDeliveryValidation,
  postPlatformArgs,
  postReviewDraftArgs,
  resolveDeliveryPost,
  resolveDeliverySource,
  reviewWithIcloudStatus,
  startDropboxConnection,
  waitForDropboxConnection,
  type DeliveryDestination,
  type PostDeliveryReview,
} from '@/videobook/post-delivery-review'
import {
  appendCopyDraft,
  copyDraftArgs,
  copyNeedsDraft,
  initialCopyState,
  postCopyDraftFromTool,
  type PostCopyState,
} from '@/videobook/post-copy-review'
import type { PostCopyLanguage } from '../server/src/posts/post-copy-format'
import { coldOpenRangeError } from '../server/src/cold-open-model'
import { prepareColdOpenReview, renderColdOpenReview, type ColdOpenReview } from '@/videobook/cold-open-review'
import { DEFAULT_IMAGE_EDIT_MODEL_ID } from '../server/src/image-edit-default'
import { creditRetryProducer } from '../server/src/notebook-credit-retry'
import { isGenerationCreditError } from '../server/src/generation-credit-error'
import { presentChat, reviewChat, type ChatExecution } from '@/videobook/chat-turns'
import {
  addHighlight,
  expireHighlight,
  HIGHLIGHT_MS,
} from '@/videobook/cell-highlight'
import {
  mediaCellGenerationState,
  mediaGenerationProducer,
} from '@/videobook/media-cell-generation-state'
import {
  notebookCellRepairMediaLabel,
  notebookCellRepairPrompt,
} from '@/videobook/notebook-cell-repair'
import { parseGenerationRequestInspection } from '@/videobook/generation-request-inspection'
import { fetchGenerationHar, saveGenerationHar } from '@/videobook/generation-har-download'
import { useChatTurns } from '@/videobook/use-chat-turns'
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
} from 'react'
import { useVoiceConversation } from './videobook/use-voice-conversation'
import type { VoiceOutcome, VoiceReviewCommand } from '../server/src/voice-contract'
import {
  ReactFlow,
  SelectionMode,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type ReactFlowInstance,
} from '@xyflow/react'
import {
  Activity,
  BookOpen,
  Braces,
  Code,
  History,
  Library,
  Settings,
  Undo2,
} from 'lucide-react'
import { v7 as uuidv7 } from 'uuid'
import type {
  EditPreview,
  NotebookCell,
  NotebookCellType,
  NotebookDocument,
  Sequence,
} from 'videobook-engine'
import { sequenceContentRevision } from './videobook/sequence-revision'
import { useTimelineAssembly } from './videobook/useTimelineAssembly'
import { useMusicRhythm } from './videobook/useMusicRhythm'
import type { MusicDraftOptions, MusicVideoDraft } from '../server/src/rhythm/draft-model'
import {
  clearReferencesConfirmation,
  forgetConfirmation,
  forgottenNotice,
} from './videobook/forget-asset'
import {
  sameTagFilter,
  tagFilterArgs,
  toggleTagFilter,
  type TagFilterTerm,
  type TagSuggestion,
} from './videobook/asset-tag-editing'
import type { LibraryBrowsePage as LibrarySearchPage } from '@/videobook/library-browse'
import {
  NOTEBOOK_GRID_ADDRESS_SOURCE,
  normalizeNotebookReference,
  stripNotebookMentions,
  scanNotebookMentions,
} from 'videobook-engine/notebook-mentions'
import {
  notebookCellOccupiedSlots,
} from 'videobook-engine/notebook-grid'
import { resolveGeneratedVideoArtifact } from 'videobook-engine/notebook-media-artifact'
import {
  adaptCommandArgs,
  normalizePostCommandArgs,
  parseCommandArgs,
  selectCommandForInput,
  type CommandToolArgs,
  type ServerCommand,
} from '@/lib/command-registry'
import {
  COMMAND_COMPOSER_FORM_ID,
  CommandComposer,
  type ComposerActionDiscovery,
  type ComposerExecuteContext,
  type ComposerOutcome,
} from '@/components/videobook/CommandComposer'
import { composerReferences } from '@/videobook/composer-references'
import { ComposerDockClose } from '@/components/videobook/ComposerDockClose'
import { JobsScreen } from '@/components/videobook/JobsScreen'
import {
  BusRiverEdge,
} from '@/components/videobook/BusRiverEdge'
import { NotebookGridBoard } from '@/components/videobook/NotebookGridBoard'
import { useGenerationCellPreview } from '@/videobook/use-generation-cell-preview'
import { useGenerationPreviewRefresh } from '@/videobook/useGenerationPreviewRefresh'
import {
  NotebookCellInspector,
  type CellAssetRevision,
  type CellGenerationAttempt,
  type NotebookCellInspectorAsset,
} from '@/components/videobook/NotebookCellInspector'
import { MediaLibraryPanel, type MediaLibraryKind, type MediaLibraryPanelState } from '@/components/videobook/MediaLibraryPanel'
import {
  GenerationBody,
  type GenerationReviewSource,
} from '@/components/videobook/confirm/bodies/GenerationBody'
import { TranscribeBody } from '@/components/videobook/confirm/bodies/TranscribeBody'
import { usePromptHistory } from '@/videobook/use-prompt-history'
import { generationPromptSurface } from '../server/src/prompt-surfaces'
import {
  NotebookMediaFullscreen,
  type ImageReplacementCandidate,
  type ImageSubjectEditInput,
} from '@/components/videobook/NotebookMediaFullscreen'
import type { MediaFullscreenMode } from '@/videobook/image-editor-copy'
import type { WatermarkReviewPatch, WatermarkReviewState } from '@/components/videobook/confirm/bodies/WatermarkBody'
import { materializeNotebookSpeakCommand } from './videobook/notebook-speak-command'
import { useElevenLabsVoices } from './videobook/use-elevenlabs-voices'
import { useImageEditModels } from './videobook/use-image-edit-models'
import {
  persistSpeakVoiceId,
  readStoredSpeakVoiceId,
  resolveSpeakPreviewAction,
  resolveSpeakVoiceId,
} from './videobook/speak-preview'
import { resolveFullscreenTarget } from './videobook/fullscreen-target'
import { resolveWatermarkTarget } from './videobook/watermark-target'
import {
  fitWatermarkReviewTiming,
  readWatermarkReviewPreferences,
  resolveWatermarkReviewInputs,
  saveWatermarkReviewPreferences,
} from './videobook/watermark-review-preferences'
import {
  clampHandlePadding,
  clampHandleRounding,
  clampHandleVerticalPercent,
  clampWatermarkFadeSeconds,
  clampWatermarkOpacity,
  DEFAULT_HANDLE_PADDING,
  DEFAULT_HANDLE_ROUNDING,
  DEFAULT_HANDLE_VERTICAL_PERCENT,
  DEFAULT_WATERMARK_FADE_SECONDS,
  DEFAULT_WATERMARK_OPACITY,
  isWatermarkHandlePlacement,
  isWatermarkPosition,
} from './videobook/watermark-review'
import {
  watermarkAppliedMessage,
  watermarkBurnWatchStep,
  watermarkQueuedMessage,
} from './videobook/watermark-burn'
import {
  NotebookCellContextMenu,
  type NotebookCellContextAction,
} from '@/components/videobook/NotebookCellContextMenu'
import { BookProjectMenu } from '@/components/videobook/BookProjectMenu'
import { WorkspaceActionsDialog } from '@/components/videobook/WorkspaceActionsDialog'
import type { WorkspaceActionReview, WorkspaceActionResult } from '@/components/videobook/WorkspaceActionsDialog'
import { asWorkspaceActionCatalog, initialActionValues, pendingWorkspaceCommands, workspaceActionCommands } from '@/videobook/workspace-actions'
import { loadWorkspaceActionResources } from '@/videobook/workspace-action-resources'
import type { WorkspaceActionResources } from '@/videobook/workspace-action-resources'
import { WORKSPACE_UI_ROUTES, normalizePanelSide, parseFilePosition, workspaceUiFormValues } from '@/videobook/workspace-ui-routes'
import { WorkspacePreviewDialog } from '@/components/videobook/WorkspacePreviewDialog'
import type { WorkspaceMediaPreview } from '@/components/videobook/WorkspacePreviewDialog'
import type { ActionChoice, WorkspaceActionContext } from '@/videobook/workspace-actions'
import type { WorkspaceAction } from '../server/src/workspace-action-contract'
import { NotebookStartTiles } from '@/components/videobook/NotebookStartTiles'
import { NotebookToolbar } from '@/components/videobook/NotebookToolbar'
import { BookUsageCounter } from '@/components/videobook/BookUsageCounter'
import { useBookUsage } from '@/videobook/useBookUsage'
import { isNotebookCellAddType } from '@/videobook/notebook-cell-add-menu'
import { SplitBody } from '@/components/videobook/confirm/bodies/SplitBody'
import { PostToXBody } from '@/components/videobook/confirm/bodies/PostToXBody'
import { SettingsScreen } from '@/components/videobook/SettingsScreen'
import { parseSettingsProviders, parseSettingsStorage, type SettingsProvider, type SettingsStorageSnapshot } from '@/videobook/settings'
import {
  fetchXConnectionStatus,
  initialXConnectionState,
  startXConnection,
  waitForXConnection,
  xConnectionOutcome,
  xPostMaxCharacters,
  type XConnectionState,
  type XConnectionStatus,
} from '@/videobook/x-connection'
import { RoutedBody } from '@/components/videobook/confirm/bodies/RoutedBody'
import { CommandPlanBody } from '@/components/videobook/confirm/bodies/CommandPlanBody'
import { NotebookActionBody } from '@/components/videobook/confirm/bodies/NotebookActionBody'
import { ConfirmSheet } from '@/components/videobook/confirm/ConfirmSheet'
import {
  commandPlanValidation,
  generationValidation,
  splitValidation,
  VALID_CONFIRMATION,
  watermarkValidation,
  xPostValidation,
} from '@/videobook/confirm-validation'
import {
  generationEstimate,
  historicalAverageEstimate,
  providerPayloadPreviewMentions,
} from '@/videobook/provider-payload-preview'
import {
  reviseXPostParams,
  reviseXPostFollowups,
  xPostDraftError,
  xPostDraftFromParams,
  type XPostDraftPatch,
} from '@/videobook/x-post-review'
import {
  dedupeXPostSourceCredits,
  discoverXPostThreadGraph,
  initialXPostThreadReview,
  readableXPostPrompt,
  selectXPostGenerationModel,
  selectXPostGenerationPrompt,
  X_POST_EMPTY_THREAD_MESSAGE,
  withXPostThreadLimit,
  xPostFollowupsFromThread,
  xPostSourceCredit,
  type XPostPromptMention,
  type XPostSourceCredit,
  type XPostThreadOptions,
  type XPostThreadReview,
  type XPostThreadStep,
} from '@/videobook/x-post-thread'
import type {
  MusicVideoCommitResult,
  MusicVideoSetupState,
} from '@/components/videobook/MusicVideoEditor'
import {
  notebookEdges,
  notebookEdgesWithCellFocus,
  notebookConnectionTargetInput,
  notebookNodesWithCellStatus,
  type NotebookFlowEdge,
} from '@/videobook/notebook-draft'
import { isValidNotebookFlowConnection } from '@/videobook/notebook-graph'
import {
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
import { searchWithPreparation } from '@/videobook/search-preparation'
import { repairSearchIndexes } from '@/videobook/search-index-repair'
import { useSearchReferenceLifecycle } from '@/videobook/useSearchReferenceLifecycle'
import {
  pathForScreen,
  screenFromPath,
  screenTitle,
  type Screen,
} from '@/videobook/screen-routes'
import type {
  CommandPlan,
  EditCommandStage,
} from '@/videobook/command-plan'
import { useLastWorkSlot } from '@/videobook/last-work-slot'
import { useNotebookViewport } from '@/videobook/useNotebookViewport'
import { resolveMusicVideoCommandAsset } from '@/videobook/music-video-command'
import { composerGoal, goalGenerationMarks } from '@/videobook/goals'
import { useVideoGoals } from '@/videobook/use-video-goals'
import { parseSequenceSlashCommand } from '@/videobook/sequence-slash-command'
import { parseExportSequenceCommand } from '@/videobook/export-sequence-command'
import { parseTrackAddCommand } from '@/videobook/track-add-command'
import { resolvePlaySlot } from '@/videobook/play-command'
import { resolveTimelineAudioTarget } from '@/videobook/timeline-audio-command'
import { useSubtitleEditor } from '@/videobook/useSubtitleEditor'
import { subtitlesCommandTarget } from '@/videobook/subtitles-model'
import { SubtitlesSheet } from '@/components/videobook/subtitles/SubtitlesSheet'
import {
  changedNotebookGridNodes,
  nextNotebookCreationSlot,
  parseNotebookGridAddress,
  notebookGrid,
  notebookGridAddress,
  notebookGridDetailScale,
  notebookGridDropSlot,
  notebookGridFrameSize,
  notebookGridMetrics,
  notebookGridPosition,
  notebookGridSlot,
  notebookGridSlotKey,
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
import { planImageGrouping } from '@/videobook/notebook-group-images'
import {
  notebookCellActionPresentation,
  notebookCellExecutionObservation,
  notebookCellInspectorActionLabel,
  notebookCellRunObservation,
  notebookCellSupportsExecution,
  notebookOutputVersionArtifactIds,
  cellTypeLabel,
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
import { performMediaFileAction } from '@/videobook/use-media-file-actions'
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
  splitSelectionTitle,
  type NotebookSplitCommand,
  type NotebookSplitOutputMode,
  type NotebookSplitRun,
} from '@/videobook/notebook-split-command'
import { resolveNotebookVideoSourceCell } from '@/videobook/notebook-video-source'
import {
  durationTargetsToCutPoints,
  splitSegments,
} from '@/videobook/video-split-segments'
import {
  generationCellTypeForRoutedTool,
  materializeNotebookChatGeneration,
  notebookChatGenerationCellPrompt,
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
import {
  isNotebookGenerationCellType,
} from '@/videobook/notebook-cell-types'
import {
  groupNotebookLaneSections,
  summarizeNotebookLaneRows,
} from '@/videobook/notebook-lane-policy'
import {
  mediaKindForFile,
  mediaFileAccept,
  type PassiveMediaKind,
  passiveMediaKind,
  dataTransferHasFiles,
  isEmptyPassiveMediaSlot,
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
import {
  chainStepReview,
  routedActionReview,
  type ChainRunValue,
  type ChainStepReviewValue,
} from '@/videobook/chat-action-review'
import { nextHistorySequence } from '@/videobook/history-sequence'
import {
  beginMcpCall,
  emptyMcpCallLog,
  mcpCallArgs,
  mcpResultSummary,
  settleMcpCall,
  shouldNotifyMcpActivity,
  toggleMcpCall,
  MCP_CALL_MIN_VISIBLE_MS,
  type McpCallLog,
  type McpCallPhase,
  type McpFlash,
} from '@/videobook/mcp-activity'
import { useMcpConnection } from '@/videobook/useMcpConnection'
import { useNotebookAutoRefresh } from '@/videobook/useNotebookAutoRefresh'
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
import {
  captureDismissedComposerFocus,
  capturePointerComposerFocus,
  restoreCommandComposerFocus,
  useCommandComposerFocus,
} from '@/videobook/command-composer-focus'
import {
  composerDockShouldOpen,
  composerPanelDrawsClose,
  pauseComposerDockMedia,
  notebookActionCreatedCells,
} from '@/videobook/composer-dock'
import {
  parsePendingApplyCommand,
  pendingCommandVoiceOutcome,
} from '@/videobook/command-composer-outcome'
import {
  planVoiceReviewCommand,
  type PendingReview,
  type VoiceReviewEdit,
} from '@/videobook/voice-review-command'
import { revealNotebookResult } from '@/videobook/notebook-result-reveal'
import {
  NO_NOTEBOOK_REVIEW,
  notebookReviewRoles,
  revealNotebookReviewRow,
  type NotebookReviewAddresses,
} from '@/videobook/notebook-review-focus'
import {
  notebookAddressExpectationsAreStale,
  type NotebookAddressExpectation,
  type NotebookCoordinateActionPlan,
} from '@/videobook/notebook-coordinate-actions'
import {
  notebookCellAtSlot,
  notebookReferences,
} from '@/videobook/notebook-addressing'
import {
  composerImageReplacementMentions,
  imageReplacementTargets,
  mergeRegionReplacements,
  regionReplacementPayload,
  type ImageEditSelection,
} from '@/videobook/image-edit-regions'
import { recordValue, asString, asNumber } from '@/videobook/value-decoders'
import {
  asImageSubjectMap,
  type ImageSubjectMap,
} from '@/videobook/image-subject-map'
import { pollImageSubjectMap } from '@/videobook/image-subject-map-poll'
import {
  idleMediaInsightWork,
  mediaCellHasSpokenAudio,
  mediaInsightIsRunning,
  mediaInsightRunningPatch,
  type MediaInsightKind,
  type MediaInsightWork,
  type TranscriptSidecarSource,
} from '@/videobook/media-insights'
import {
  resolveTranscribeTarget,
  transcribeClipChoices,
  transcribeEstimateView,
  transcribeLanguageOverride,
  transcribeToolArgs,
  transcribeValidation,
} from '@/videobook/transcribe-review'
import {
  mediaInsightWatchStep,
  type MediaInsightWatchStep,
} from '@/videobook/media-insight-watch'
import { guardedAsyncResult } from '@/videobook/async-request-guard'
import {
  asAssets,
  asBook,
  asBooks,
  asCellAssetRevisions,
  asChainRun,
  asChatActionPlan,
  asCommandPlan,
  asCommands,
  asForgetAssetOutcome,
  asGenerationPlans,
  asInitialWorkspace,
  asJobs,
  asLibrarySearchResult,
  asNotebook,
  asNotebooks,
  asSequence,
  isDownloadVideoResult,
  messageFor,
  parseResult,
  type AssetRecord,
  type ChatActionPlan,
  type GenerationPlanRecord,
  type JobRecord,
  type LibraryAssetRecord,
  type NotebookSnapshot,
} from '@/videobook/workspace-responses'
import { CellIcon, CellNode, TimelineNode } from '@/components/videobook/NotebookCanvasNodes'
import { GoalCellNode } from '@/components/videobook/GoalCellNode'
import { GoalComposerStatus } from '@/components/videobook/GoalComposerStatus'
import { GoalPanel, GoalPanelPlaceholder } from '@/components/videobook/GoalPanel'
import {
  CellContextMenuContext,
  cellContextMenuId,
  CellRunContext,
  CellActionsContext,
  type CellActionsContextValue,
  GenerationTitlesContext,
  GoalMarksContext,
  GoalTileContext,
  GoalMediaContext,
  MediaSlotContext,
  PrimaryCellContext,
  TimelineContext,
  type CellContextMenuContextValue,
  type MediaSlotContextValue,
  type MediaSlotOperation,
  type MediaSlotState,
  type TimelineContextValue,
} from '@/components/videobook/notebook-canvas-context'
import {
  artifactForCell,
  canvasNodes,
  cellExecutionError,
  jsonEqual,
  reconcileCanvasNodes,
  reconcileFlowEdges,
  type CanvasNode,
} from '@/videobook/notebook-canvas'

const WatermarkBody = lazy(async () => {
  const module = await import('@/components/videobook/confirm/bodies/WatermarkBody')
  return { default: module.WatermarkBody }
})

const MusicVideoEditor = lazy(async () => {
  const module = await import('@/components/videobook/MusicVideoEditor')
  return { default: module.MusicVideoEditor }
})

type MusicVideoPreparedSetup = Extract<
  MusicVideoSetupState,
  { status: 'ready' }
> & {
  plan: CommandPlan
  preview: EditPreview
}

type MusicVideoSession = {
  key: string
  audioArtifactId: string
  returnFocus: HTMLElement | null
  setup:
    | Exclude<MusicVideoSetupState, { status: 'ready' }>
    | MusicVideoPreparedSetup
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
  mode: MediaFullscreenMode
  initialInstruction: string
}

type MediaSearchMode = SearchReferenceMode

type MediaLibraryPickerState = {
  unindexedVisualAssets: number
  preparingIndex: boolean
  bookId: string
  notebookId: string
  cellId: string | null
  slot?: NotebookGridSlot
  query: string
  draftQuery: string
  assets: LibraryAssetRecord[]
  page: LibrarySearchPage
  booksWithErrors: Array<{ bookId: string; message: string }>
  loading: boolean
  loadingMore: boolean
  error: string | null
  activeArtifactId: string | null
  /** Exact tag terms narrowing this search; changing them resets paging. */
  tagFilters: TagFilterTerm[]
  tagSuggestions: TagSuggestion[]
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

type PendingCommandPlan = {
  plan: CommandPlan
  previews: Record<string, EditPreview>
}

type PendingChatAction =
  | { kind: 'cold-open'; review: ColdOpenReview }
  | { kind: 'post-delivery'; review: PostDeliveryReview }
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
      xPostReview?: XPostThreadReview | null
    }
  | {
      kind: 'chain-step'
      chainId: string
      review: ChainStepReviewValue
      remaining: number
    }
  | { kind: 'subtitles'; assetId: string }
  | {
      kind: 'transcribe'
      assetId: string | null
      languageCode: string
      diarize: boolean
      tagAudioEvents: boolean
      estimateUsd: number | null
      estimateLoading: boolean
      estimateUnavailable: boolean
    }

type WorkspaceNoticeTone = 'info' | 'error'
type WorkspaceNotice = { text: string; tone: WorkspaceNoticeTone }

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

type CellContextMenuTarget =
  | { kind: 'cell'; cellId: string }
  | { kind: 'slot'; slot: NotebookGridSlot }

type CellContextMenuState = {
  target: CellContextMenuTarget
  position: { x: number; y: number }
  returnFocus: HTMLElement | null
}

const mcpUrl = typeof window === 'undefined'
  ? 'http://localhost/mcp'
  : new URL('/mcp', window.location.origin).toString()
const notebookRunPollIntervalMs = 500
const notebookRunPollTimeoutMs = 5 * 60_000
// A watch tolerates this many consecutive poll failures before giving up —
// enough to ride out the MCP client's 3s reconnect after a transient error.
const notebookRunMaxPollFailures = 10
// After a watch ends (completed, lost contact, or timed out) it pulls the
// server's current snapshot into the canvas so a cell is never left drawn as
// queued once the server has moved on. Retries cover a reconnect in progress.
const notebookRunResyncAttempts = 5
const notebookRunResyncDelayMs = 1_000
const notebookGenerationWatchIntervalMs = 2_000
const notebookGenerationWatchTimeoutMs = 45 * 60_000
const downloadWatchIntervalMs = 5_000
const mediaInsightWatchIntervalMs = 3_000
const mediaInsightWatchTimeoutMs = 20 * 60_000
const mediaProcessWatchIntervalMs = 750
// Polls a queued watermark burn may spend without its job in the listing
// before the watch gives up (the job lands in list_jobs on the first poll).
const watermarkBurnMissingPollLimit = 20
const mediaAssetWatchTimeoutMs = 45 * 60_000
const activeJobStates = new Set(['queued', 'running', 'completing'])
const EMPTY_NOTEBOOK_CELLS: NotebookCell[] = []

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

const screenNavigation: Array<{
  id: Exclude<Screen, 'notebook'>
  label: string
  icon: typeof BookOpen
}> = [
  { id: 'jobs', label: 'Jobs', icon: Activity },
  { id: 'settings', label: 'Settings', icon: Settings },
]

function assetHasInsight(
  asset: AssetRecord | undefined,
  insight: MediaInsightKind,
): boolean {
  return Boolean(insight === 'transcript'
    ? asset?.transcript
    : asset?.visionAnalysis)
}

function isRunnableCell(
  cell: NotebookDocument['cells'][number],
): boolean {
  return notebookCellSupportsExecution(cell)
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

function bookProjectFailure(error: unknown): { ok: false; error: string } {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }
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

function sequenceTrackReference(sequence: Sequence | null, value: string | undefined) {
  if (!sequence || !value) return null
  const token = normalizeNotebookReference(value)
  const matches = sequence.tracks.filter((track) =>
    track.trackId.toLowerCase().startsWith(token)
    || track.name.toLowerCase() === token)
  return matches.length === 1 ? matches[0] : null
}

function musicVideoSoundtrackTrack(
  sequence: Sequence,
  audioArtifactId: string,
) {
  const candidates = sequence.tracks.filter((track) =>
    track.kind === 'audio' && track.enabled && !track.locked && !track.muted)
  const existing = candidates.find((track) => {
    const clips = sequence.clips.filter((clip) => clip.trackId === track.trackId)
    return clips.length === 1
      && clips[0]?.timelineStartFrame === 0
      && clips[0].source.kind === 'timed'
      && clips[0].source.artifactId === audioArtifactId
  })
  return existing ?? candidates.find((track) =>
    !sequence.clips.some((clip) => clip.trackId === track.trackId)) ?? null
}

function musicVideoSoundtrackApplied(
  sequence: Sequence,
  audioArtifactId: string,
  timelineLimitFrame: number,
): boolean {
  const track = musicVideoSoundtrackTrack(sequence, audioArtifactId)
  if (!track) return false
  const clips = sequence.clips.filter((clip) => clip.trackId === track.trackId)
  const clip = clips[0]
  return clips.length === 1
    && clip !== undefined
    && clip.timelineStartFrame === 0
    && clip.durationFrames === timelineLimitFrame
    && clip.source.kind === 'timed'
    && clip.source.artifactId === audioArtifactId
}

function musicVideoTimelineLimit(
  plan: CommandPlan,
  sequence: Sequence,
  audioArtifactId: string,
): number {
  const stage = plan.stages.find(
    (candidate): candidate is EditCommandStage => candidate.kind === 'edit',
  )
  const inserted = stage?.intent.operations.find((operation) =>
    operation.kind === 'insert-clip'
    && operation.placement.source.artifactId === audioArtifactId)
  if (inserted?.kind === 'insert-clip') return inserted.placement.durationFrames
  const existing = sequence.clips.find((clip) =>
    clip.timelineStartFrame === 0
    && clip.source.kind === 'timed'
    && clip.source.artifactId === audioArtifactId)
  const trimmed = stage?.intent.operations.find((operation) =>
    operation.kind === 'trim-clip' && operation.clipId === existing?.clipId)
  if (trimmed?.kind === 'trim-clip') return trimmed.durationFrames
  if (existing) return existing.durationFrames
  throw new Error('The soundtrack setup plan has no duration boundary')
}

function musicVideoSetupSummary(plan: CommandPlan): string {
  const operations = plan.stages.flatMap((stage) =>
    stage.kind === 'edit' ? stage.intent.operations : [])
  const inserts = operations.filter((operation) => operation.kind === 'insert-clip').length
  const muted = operations.filter((operation) =>
    operation.kind === 'set-clip-audio'
      ? operation.audio.muted
      : operation.kind === 'set-clip-speed' && operation.audioPolicy === 'mute')
    .length
  return `${inserts > 0 ? 'Place' : 'Normalize'} master soundtrack · mute ${muted} other ${muted === 1 ? 'clip' : 'clips'}`
}

function editPreviewError(preview: EditPreview): string | null {
  if (preview.valid) return null
  const conflicts = preview.conflicts.map((conflict) => conflict.message)
  return conflicts.join(' · ') || 'The canonical edit preview is invalid'
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

function passiveMediaKindForAsset(type: string): PassiveMediaKind | null {
  if (type === 'final') return 'video'
  return type === 'audio' || type === 'image' || type === 'video' ? type : null
}

function mediaLibraryKinds(kind: MediaLibraryKind): string[] {
  if (kind === 'all') return ['audio', 'image', 'video', 'final']
  return kind === 'video' ? ['video', 'final'] : [kind]
}

function isCompatibleLibraryAsset(
  kind: MediaLibraryKind,
  assetType: string,
): boolean {
  return mediaLibraryKinds(kind).includes(assetType)
}

async function fileObjectHash(file: File): Promise<string> {
  const digest = await window.crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
}

function slotContextMenuId(slot: NotebookGridSlot): string {
  return `slot-context-menu-${slot.row}-${slot.column}`
}

type TimelinePreviewSession = {
  bookId: string
  cellId: string
  initialFrame: number
  returnFocus: HTMLElement | null
}
const nodeTypes = { cell: CellNode, timeline: TimelineNode, goal: GoalCellNode }
const edgeTypes = { busRiver: BusRiverEdge }
const flowProOptions = { hideAttribution: true }
const notebookDefaultEdgeOptions = { selectable: false }
const notebookMultiSelectionKeys = ['Shift', 'Control', 'Meta']
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
  const [screen, setScreen] = useState<Screen>(
    () => screenFromPath(window.location.pathname),
  )
  const [books, setBooks] = useState<BookProjectSummary[]>(
    () => initialWorkspace?.books ?? [],
  )
  const [bookId, setBookId] = useState(() =>
    initialWorkspace?.bookId ?? savedValue('videobook.active-book'))
  const [notebook, setNotebook] = useState<NotebookDocument | null>(
    () => initialWorkspace?.notebook ?? null,
  )
  const [assets, setAssets] = useState<AssetRecord[]>(() => initialWorkspace?.assets ?? [])
  const [sequence, setSequence] = useState<Sequence | null>(
    () => initialWorkspace?.sequence ?? null,
  )
  const [jobs, setJobs] = useState<JobRecord[]>(() => initialWorkspace?.jobs ?? [])
  const [jobSnapshotAt, setJobSnapshotAt] = useState(() => Date.now())
  const [commands, setCommands] = useState<ServerCommand[]>(
    () => initialWorkspace?.commands ?? [],
  )
  const [workspaceActions, setWorkspaceActions] = useState<WorkspaceAction[]>([])
  const [actionCatalogStatus, setActionCatalogStatus] = useState<{ loading: boolean; error: string | null }>({ loading: false, error: null })
  const [actionDialog, setActionDialog] = useState<{
    key: number
    actionId?: string
    values?: Record<string, unknown>
    query?: string
    opener: HTMLElement | null
    resources?: WorkspaceActionResources
    result?: WorkspaceActionResult
  } | null>(null)
  const actionCatalogRequestRef = useRef(0)
  const transcribeEstimateRequestRef = useRef(0)
  const [actionDiscovery, setActionDiscovery] = useState<(ComposerActionDiscovery & { bookId: string; session: string }) | null>(null)
  const [actionComposer, setActionComposer] = useState<{ bookId: string; session: string; opener: HTMLElement | null } | null>(null)
  const [previewComposerTarget, setPreviewComposerTarget] = useState<HTMLDivElement | null>(null)
  const [inspectorActionHost, setInspectorActionHost] = useState<HTMLDivElement | null>(null)
  const [workspacePreview, setWorkspacePreview] = useState<{ media?: WorkspaceMediaPreview; initialFrame?: number; turnId?: number; opener: HTMLElement | null } | null>(null)
  const actionUploadRef = useRef<HTMLInputElement>(null)
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
    () => new Map(generationActions.map((action) => [action.model, action.title])),
    [generationActions],
  )
  const [providers, setProviders] = useState<SettingsProvider[]>([])
  const [xConnection, setXConnection] = useState<XConnectionState>(
    initialXConnectionState,
  )
  // Post length the connected X account allows: 280, or 25,000 with X Premium.
  const xPostMaxLength = xPostMaxCharacters(xConnection.status)
  const [storage, setStorage] = useState<SettingsStorageSnapshot | null>(null)
  const [settingsLoading, setSettingsLoading] = useState(false)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [settingsRefreshed, setSettingsRefreshed] = useState(false)
  const settingsRequestRef = useRef(0)
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
  const [mediaFullscreen, setMediaFullscreen] = useState<MediaFullscreenSession | null>(null)
  const imageEditInstructionsRef = useRef(new Map<string, string>())
  const [musicVideoSession, setMusicVideoSession] = useState<MusicVideoSession | null>(null)
  const [mediaFullscreenComposerTarget, setMediaFullscreenComposerTarget] =
    useState<HTMLDivElement | null>(null)
  const [mediaFullscreenSidebarEditing, setMediaFullscreenSidebarEditing] =
    useState(false)
  const [previewSlot, setPreviewSlot] = useState<NotebookGridSlot | null>(null)
  const [mediaDropActive, setMediaDropActive] = useState(false)
  const [mediaDropSlot, setMediaDropSlot] = useState<NotebookGridSlot | null>(null)
  const {
    scrollRef: notebookScrollRef,
    surface: notebookSurface,
    zoom: notebookZoom,
    revealCell: revealNotebookCanvasCell,
  } = useNotebookViewport(bookId, notebook?.id, screen === 'notebook')
  const [commandRowHeight, setCommandRowHeight] = useState(58)
  const [composerHeight, setComposerHeight] = useState(58)
  const notebookCanvasStyle = useMemo(() => ({
    '--notebook-command-row-height': `${commandRowHeight}px`,
    '--notebook-composer-height': `${composerHeight}px`,
  }) as CSSProperties, [commandRowHeight, composerHeight])
  const [composerDockOpen, setComposerDockOpen] = useState(false)
  const [sourceViewCellId, setSourceViewCellId] = useState<string | null>(null)
  const [historyViewCellId, setHistoryViewCellId] = useState<string | null>(null)
  const [historyState, setHistoryState] = useState<{
    cellId: string
    assetId: string
    loading: boolean
    error: string | null
    revisions: CellAssetRevision[]
  } | null>(null)
  const [bookMenuOpen, setBookMenuOpen] = useState(false)
  const [bookMenuLoading, setBookMenuLoading] = useState(false)
  const [bookMenuError, setBookMenuError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [pendingCommandPlan, setPendingCommandPlan] = useState<PendingCommandPlan | null>(null)
  const [pendingChatAction, setPendingChatAction] = useState<PendingChatAction | null>(null)
  const voiceOutcomeRef = useRef<((outcome: VoiceOutcome) => void) | null>(null)
  const voiceTypedTurnRef = useRef<((input: string, message: string) => void) | null>(null)
  const voiceActiveRef = useRef(false)
  const [lastEditActionId, setLastEditActionId] = useState('')
  const [busy, setBusy] = useState(false)
  const { turns: chatTurns, begin: beginChatTurn, observe: observeChat, cancelReview: cancelChatReview, claimVoice: claimVoiceTurn } = useChatTurns(bookId, notebook?.id ?? null)
  const voiceChatRef = useRef<ChatExecution | undefined>(undefined)
  const [previewTurnId, setPreviewTurnId] = useState<number | null>(null)
  const [mcpCalls, setMcpCalls] = useState<McpCallLog>(emptyMcpCallLog)
  const [mcpFlash, setMcpFlash] = useState<McpFlash>(null)
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
  const bookMenuRequestRef = useRef(0)
  const mediaLibraryRequestRef = useRef(0)
  const imageSubjectMapRequestRef = useRef(0)
  const bookDataRequestRef = useRef(0)
  const mediaLibraryOpenerRef = useRef<HTMLElement | null>(null)
  const activeWatchesRef = useRef(new Map<string, string>())
  const activeMcpCallsRef = useRef(new Map<number, { tool: string; startedAt: number }>())

  const mcpFlashTimerRef = useRef(0)
  const mcpSettleTimersRef = useRef(new Map<number, number>())
  const selectedCellIdsRef = useRef<ReadonlySet<string>>(new Set())
  const watchScopeRef = useRef<{
    bookId: string | null
    notebookId: string | null
    assets: AssetRecord[]
  }>({ bookId, notebookId: notebook?.id ?? null, assets })
  const callRef = useRef<(
    tool: string,
    args: Record<string, unknown>,
    options?: { background?: boolean; chat?: ChatExecution },
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
  const commandMentionAssets = useMemo(
    () => notebookMentionAssets(notebook?.cells ?? [], assets),
    [assets, notebook],
  )
  const composerReferenceMap = useMemo(() => composerReferences(notebook?.cells ?? [], assets), [assets, notebook])
  const gridMentionAssets = useMemo(() => [...composerReferenceMap.values()].flatMap(reference => reference.asset
    ? [{ ...reference.asset, cellAddress: reference.token.slice(1) }] : []), [composerReferenceMap])
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
    const draft = xPostDraftFromParams(plan.params)
    const review = pendingChatAction.xPostReview
    const validation = review?.options.enabled
      && xPostFollowupsFromThread(review).length === 0
      ? {
          blocking: X_POST_EMPTY_THREAD_MESSAGE,
          notice: null,
        }
      : xPostValidation(draft, undefined, xPostMaxLength)
    return {
      asset,
      draft,
      error: xPostDraftError(draft, undefined, xPostMaxLength),
      validation,
      sourceLabel: mention
        ? `@${mention.cellAddress}`
        : rawReference.startsWith('@')
          ? rawReference
          : reference
            ? `@${reference}`
            : 'Selected media',
    }
  }, [assetById, commandMentionAssets, pendingChatAction, xPostMaxLength])
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
  /* Which addresses the open review is about. A generation names the slot it
     will write to even when no cell lives there yet; a frame or a split names
     only the cell it reads. Whatever it names, the canvas scrolls to the first
     of them and marks the rest while the sheet is up. */
  const pendingReviewAddresses = useMemo<NotebookReviewAddresses>(() => {
    if (!pendingChatAction) return NO_NOTEBOOK_REVIEW
    if (pendingChatAction.kind === 'generation' && pendingGenerationDraft) {
      return {
        target: notebookGridAddress(pendingGenerationDraft.cell.slot),
        sources: pendingGenerationSources.map((source) => source.address),
      }
    }
    if (pendingChatAction.kind === 'frame' || pendingChatAction.kind === 'split') {
      return {
        target: null,
        sources: pendingChatAction.expectations.map((item) => item.address),
      }
    }
    if (pendingChatAction.kind === 'notebook') {
      const [target, ...rest] = pendingChatAction.plan.expectations
        .map((item) => item.address)
      return { target: target ?? null, sources: rest }
    }
    if (pendingChatAction.kind === 'transcribe' && pendingChatAction.assetId) {
      const assetId = pendingChatAction.assetId
      const address = commandMentionAssets.find((asset) => asset.artifactId === assetId)?.cellAddress
      return address
        ? { target: null, sources: [address] }
        : NO_NOTEBOOK_REVIEW
    }
    return NO_NOTEBOOK_REVIEW
  }, [commandMentionAssets, pendingChatAction, pendingGenerationDraft, pendingGenerationSources])
  const pendingReviewRoles = useMemo(
    () => notebookReviewRoles(pendingReviewAddresses),
    [pendingReviewAddresses],
  )
  const pendingGenerationSourceOptions = useMemo<GenerationReviewSource[]>(
    () => pendingGenerationDraft && notebook
      ? notebookChatGenerationSourceOptions(
          notebook,
          pendingGenerationDraft.sourceCellIds,
          pendingGenerationDraft.cell.id,
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
  const generationPlans = useMemo(
    () => asGenerationPlans(notebook?.generationPlans),
    [notebook],
  )
  const call = useCallback(async (
    tool: string,
    args: Record<string, unknown>,
    options?: { background?: boolean; chat?: ChatExecution },
  ) => {
    if (mcp.state !== 'ready') throw new Error('MCP server is not ready')
    if (options?.chat && !options.chat.isInScope()) throw new Error('Workspace changed. Repeat the command in the current workspace.')
    if (options?.background || !shouldNotifyMcpActivity(tool)) {
      const value = parseResult(await mcp.callTool(tool, args))
      options?.chat?.accept(tool, args, value)
      return value
    }
    const sequence = nextHistorySequence()
    const startedAt = performance.now()
    activeMcpCallsRef.current.set(sequence, { tool, startedAt })
    setMcpCalls((log) => beginMcpCall(log, { id: sequence, turnId: options?.chat?.visible === false ? undefined : options?.chat?.id, tool, args: mcpCallArgs(args) }))
    let phase: Extract<McpCallPhase, 'done' | 'failed'> = 'done'
    let detail = ''
    try {
      const value = parseResult(await mcp.callTool(tool, args))
      detail = mcpResultSummary(value)
      options?.chat?.accept(tool, args, value)
      return value
    } catch (error) {
      phase = 'failed'
      detail = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      activeMcpCallsRef.current.delete(sequence)
      const elapsedMs = performance.now() - startedAt
      // The row stays either way, but a call that finishes in 30ms should still
      // read as having run rather than blinking the panel rail.
      const settle = () => {
        mcpSettleTimersRef.current.delete(sequence)
        setMcpCalls((log) => settleMcpCall(log, sequence, { phase, elapsedMs, detail }))
        if (activeMcpCallsRef.current.size > 0) return
        window.clearTimeout(mcpFlashTimerRef.current)
        setMcpFlash(phase === 'failed' ? 'error' : 'success')
        mcpFlashTimerRef.current = window.setTimeout(
          () => setMcpFlash(null),
          phase === 'failed' ? 1100 : 620,
        )
      }
      const held = Math.max(0, MCP_CALL_MIN_VISIBLE_MS - elapsedMs)
      if (held === 0) settle()
      else mcpSettleTimersRef.current.set(sequence, window.setTimeout(settle, held))
    }
  }, [mcp])

  const deliveryPoll = pendingChatAction?.kind === 'post-delivery' ? pendingChatAction.review : null
  useIcloudSyncPoll(
    Boolean(deliveryPoll?.receipt && deliveryPoll.destination === 'icloud'),
    mcp.state === 'ready' ? call : undefined,
    deliveryPoll?.bookId ?? '',
    deliveryPoll?.postId ?? '',
    sync => setPendingChatAction(current => current?.kind === 'post-delivery'
      ? { ...current, review: { ...current.review, sync } }
      : current),
  )

  const goalScope = useMemo(
    () => bookId && notebook ? { bookId, notebookId: notebook.id } : null,
    [bookId, notebook],
  )
  const {
    goals: goalSnapshots,
    events: goalEvents,
    accept: acceptGoals,
    refresh: refreshGoals,
    act: actOnGoal,
  } = useVideoGoals(call, goalScope)
  const goalCellIds = useMemo(
    () => new Set((notebook?.cells ?? []).filter((cell) => cell.type === 'goal').map((cell) => cell.id)),
    [notebook],
  )
  const visibleGoals = useMemo(
    () => goalSnapshots.filter((goal) => goalCellIds.has(goal.cellId)),
    [goalCellIds, goalSnapshots],
  )
  const goalTiles = useMemo(
    () => new Map(visibleGoals.map((goal) => [goal.cellId, goal] as const)),
    [visibleGoals],
  )
  const goalMarks = useMemo(() => goalGenerationMarks(visibleGoals), [visibleGoals])
  const activeComposerGoal = composerGoal(visibleGoals)

  const imageEditModels = useImageEditModels({
    callTool: call,
    ready: mcp.state === 'ready',
  })

  const bookUsage = useBookUsage({ bookId, ready: mcp.state === 'ready', call })

  const estimateImageEditCost = useCallback(
    async (modelId: string): Promise<string | null> => {
      try {
        const result = recordValue(await call('estimate_cost', {
          calls: [{ tool_name: 'edit_image_subjects', input: { model: modelId } }],
        }))
        const estimate = recordValue(result?.estimate)
        const warnings = Array.isArray(estimate?.warnings)
          ? estimate.warnings.filter((value): value is string => typeof value === 'string')
          : []
        const usd = typeof estimate?.usd === 'number' ? estimate.usd : null
        const historical = historicalAverageEstimate(warnings)
        if (usd === null || usd <= 0 || (warnings.length > 0 && !historical)) return null
        const amount = `$${usd.toFixed(usd < 0.01 ? 4 : 2)}`
        return historical ? `${amount} · historical average` : amount
      } catch {
        return null
      }
    },
    [call],
  )

  const [timelinePreview, setTimelinePreview] = useState<TimelinePreviewSession | null>(null)
  const timeline = useTimelineAssembly({
    bookId,
    ready: mcp.state === 'ready' && !busy,
    sequence,
    call,
    parseSequence: asSequence,
    parseAssets: asAssets,
    onSequence: (next) => {
      watchSnapshotClockRef.current = performance.now()
      setSequence(next)
    },
    onAssets: (loaded) => setAssets((current) => {
      const merged = new Map(current.map((asset) => [asset.artifactId, asset]))
      for (const asset of loaded) merged.set(asset.artifactId, asset)
      return [...merged.values()]
    }),
  })
  const musicRhythm = useMusicRhythm({
    bookId, ready: mcp.state === 'ready', sequence, call,
    onSequence: (value) => {
      const next = asSequence(value)
      if (next) { watchSnapshotClockRef.current = performance.now(); setSequence(next) }
    },
  })
  const timelinePreviewCell = timelinePreview?.bookId === bookId
    ? notebook?.cells.find((cell) => cell.id === timelinePreview.cellId && cell.type === 'timeline')
    : undefined
  const timelinePreviewOpen = Boolean(timelinePreviewCell && sequence && screen === 'notebook')

  const { preview: generationCellPreview, select: selectGenerationCellPreview } = useGenerationCellPreview({
    bookId, notebook, ready: mcp.state === 'ready', call,
  })

  const handleToggleMcpCall = useCallback((id: number) => {
    setMcpCalls((log) => toggleMcpCall(log, id))
  }, [])

  useEffect(() => () => {
    window.clearTimeout(mcpFlashTimerRef.current)
    for (const timer of mcpSettleTimersRef.current.values()) window.clearTimeout(timer)
    mcpSettleTimersRef.current.clear()
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
    observeChat(watchScopeRef.current.bookId ?? '', nextJobs)
    const changed = !jsonEqual(jobsRef.current, nextJobs)
    if (changed) {
      jobsRef.current = nextJobs
      setJobs(nextJobs)
    }
    const ticking = screenRef.current === 'jobs'
      && nextJobs.some((job) => activeJobStates.has(job.state))
    if (changed || ticking) setJobSnapshotAt(Date.now())
  }, [observeChat])

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

  const [highlightedCellIds, setHighlightedCellIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  )
  const highlightExpireTimerRef = useRef<number | null>(null)
  useEffect(() => () => {
    if (highlightExpireTimerRef.current !== null) {
      window.clearTimeout(highlightExpireTimerRef.current)
    }
  }, [])
  const highlightCells = useCallback((
    cellIds: readonly string[],
    options: { scroll?: 'center' | 'offscreen' } = {},
  ) => {
    setHighlightedCellIds((current) => addHighlight(current, cellIds))
    if (highlightExpireTimerRef.current !== null) {
      window.clearTimeout(highlightExpireTimerRef.current)
    }
    highlightExpireTimerRef.current = window.setTimeout(() => {
      highlightExpireTimerRef.current = null
      setHighlightedCellIds((current) => expireHighlight(current, cellIds))
    }, HIGHLIGHT_MS)
    if (!options.scroll) return
    window.requestAnimationFrame(() => {
      if (
        options.scroll === 'offscreen'
        && flowRef.current?.getNodes().some((node) => node.dragging)
      ) return
      const reducedMotion = window.matchMedia(
        '(prefers-reduced-motion: reduce)',
      ).matches
      for (const cellId of cellIds) {
        const target = document.querySelector(`[data-id="${cellId}"]`)
        if (!target) continue
        if (options.scroll === 'offscreen') {
          const rect = target.getBoundingClientRect()
          const onScreen = rect.top >= 0 && rect.left >= 0
            && rect.bottom <= window.innerHeight
            && rect.right <= window.innerWidth
          if (onScreen) continue
        }
        target.scrollIntoView({
          block: 'center',
          behavior: reducedMotion ? 'auto' : 'smooth',
        })
      }
    })
  }, [])

  const focusCommandComposer = useCallback(() => {
    restoreCommandComposerFocus(() =>
      document.querySelector<HTMLElement>(
        '.command-composer [aria-label="Videobook command input"]',
      ))
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
    chat?: ChatExecution,
  ): Promise<CommandPlan> => {
    if (!bookId || !notebook) {
      throw new Error('Load a notebook first.')
    }
    return asCommandPlan(await call('plan_notebook_generation', {
      book_id: bookId,
      notebook_id: notebook.id,
      cell_id: cellId,
      source_surface: sourceSurface,
      actor: 'videobook-user',
      timeline_start_frame: 0,
    }, { chat }))
  }, [bookId, call, notebook])

  const prepareGenerationPlan = useCallback(async (
    cellId: string,
    sourceSurface: 'ui' | 'slash' | 'chat',
    chat?: ChatExecution,
  ): Promise<ComposerOutcome> => {
    const plan = await createGenerationPlan(cellId, sourceSurface, chat)
    reviewChat(chat, false, () => setPendingChatAction(null))
    reviewChat(chat, true, () => setPendingCommandPlan({ plan, previews: {} }))
    presentChat(chat, () => focusCommandComposer())
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
    if (next.size > 0) {
      setMediaLibraryPicker((current) => current?.cellId === null ? null : current)
    }
    const current = selectedCellIdsRef.current
    if (
      current.size === next.size
      && [...next].every((cellId) => current.has(cellId))
    ) return
    selectedCellIdsRef.current = next
    setSelectedCellIds(next)
  }, [])

  const subtitles = useSubtitleEditor({ bookId, ready: mcp.state === 'ready', call })
  const selectCanvasCell = useCallback((cellId: string | null, chat?: ChatExecution, initialPreview?: unknown) => {
    if (chat && !chat.isCurrent()) return
    setPreviewTurnId(cellId ? chat?.id ?? null : null)
    setSelectedCellId(cellId)
    selectGenerationCellPreview(cellId, initialPreview)
    updateSelectedCellIds(cellId ? new Set([cellId]) : new Set())
    if (!cellId) return
    const fromNotebook = notebook?.cells.find((cell) => cell.id === cellId)
    if (fromNotebook) {
      rememberLastWorkSlot(fromNotebook.slot)
      return
    }
    const fromNode = nodes.find((node) => node.id === cellId)
    if (fromNode) rememberLastWorkSlot(fromNode.data.slot)
  }, [selectGenerationCellPreview, notebook, nodes, rememberLastWorkSlot, updateSelectedCellIds])

  const closeCellContextMenu = useCallback(() => {
    setCellContextMenu(null)
  }, [])

  const openCellContextMenu = useCallback((
    cellId: string,
    position: { x: number; y: number },
    returnFocus: HTMLElement | null,
  ) => {
    selectCanvasCell(cellId)
    setCellContextMenu({ target: { kind: 'cell', cellId }, position, returnFocus })
  }, [selectCanvasCell])

  const openSlotContextMenu = useCallback((
    slot: NotebookGridSlot,
    position: { x: number; y: number },
    returnFocus: HTMLElement | null,
  ) => {
    setCellContextMenu({ target: { kind: 'slot', slot }, position, returnFocus })
  }, [])

  const openContextMenuCellId = cellContextMenu?.target.kind === 'cell'
    ? cellContextMenu.target.cellId
    : null
  const cellContextMenuContextValue = useMemo<CellContextMenuContextValue>(() => ({
    openCellId: openContextMenuCellId,
    open: openCellContextMenu,
  }), [openContextMenuCellId, openCellContextMenu])

  const applyNotebook = useCallback((
    next: NotebookDocument,
    nextAssets: AssetRecord[],
    nextJobs: JobRecord[],
    owningBookId = bookId,
  ) => {
    observeChat(owningBookId, nextJobs, next, nextAssets)
    watchSnapshotClockRef.current = performance.now()
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
    setMediaSlotStates((current) => Object.keys(current).every((cellId) => cellIds.has(cellId))
      ? current
      : Object.fromEntries(Object.entries(current).filter(([cellId]) => cellIds.has(cellId))))
    setCellRunErrors((current) => Object.keys(current).every((cellId) => cellIds.has(cellId))
      ? current
      : Object.fromEntries(Object.entries(current).filter(([cellId]) => cellIds.has(cellId))))
    updateSelectedCellIds(new Set(
      [...selectedCellIdsRef.current].filter((cellId) => cellIds.has(cellId)),
    ))
    setMediaLibraryPicker((current) =>
      current && current.bookId === owningBookId && current.notebookId === next.id
        && (current.cellId === null || cellIds.has(current.cellId)) ? current : null)
    setCellContextMenu((current) =>
      !current
      || current.target.kind === 'slot'
      || cellIds.has(current.target.cellId)
        ? current
        : null)
    setNodes((current) =>
      reconcileCanvasNodes(current, canvasNodes(next, nextAssets, nextJobs)))
    setEdges((current) => reconcileFlowEdges(current, notebookEdges(next)))
    setSelectedCellId((current) =>
      current && next.cells.some((cell) => cell.id === current) ? current : null)
    setSourceViewCellId((current) =>
      current && cellIds.has(current) ? current : null)
  }, [bookId, observeChat, updateSelectedCellIds])

  useNotebookAutoRefresh({
    bookId,
    notebookId: notebook?.id ?? null,
    enabled: mcp.state === 'ready' && screen === 'notebook' && !busy && !timeline.busy
      && !nodes.some((node) => node.dragging),
    refresh: async (isCurrent) => {
      if (mcp.state !== 'ready' || !notebook || activeMcpCallsRef.current.size > 0) return
      const fetchedAt = performance.now()
      const listGoals = goalCellIds.size > 0 || goalSnapshots.length > 0
      const [notebookResult, assetResult, jobResult, sequenceResult, goalResult] = await Promise.allSettled([
        call('get_notebook', {
          book_id: bookId,
          notebook_id: notebook.id,
        }, { background: true }),
        call('list_assets', {
          book_id: bookId,
          sort: 'newest',
          limit: 200,
          include_referenced: true,
        }, { background: true }),
        call('list_jobs', { book_id: bookId, limit: 200 }, { background: true }),
        notebook.cells.some((cell) => cell.type === 'timeline')
          ? call('get_primary_sequence', { book_id: bookId }, { background: true })
          : Promise.resolve(null),
        listGoals
          ? call('video_goal', { book_id: bookId, notebook_id: notebook.id, action: 'list' }, { background: true })
          : Promise.resolve(null),
      ])
      if (!isCurrent() || activeMcpCallsRef.current.size > 0) return
      if (goalResult.status === 'fulfilled' && goalResult.value) {
        acceptGoals({ bookId, notebookId: notebook.id }, goalResult.value)
      }
      if (fetchedAt < watchSnapshotClockRef.current) return
      if (notebookResult.status !== 'fulfilled'
        || assetResult.status !== 'fulfilled'
        || jobResult.status !== 'fulfilled') return
      const nextNotebook = asNotebook(notebookResult.value)
      if (!nextNotebook) return
      const nextAssets = asAssets(assetResult.value)
      const nextJobs = asJobs(jobResult.value)
      setAssets((current) => jsonEqual(current, nextAssets) ? current : nextAssets)
      if (sequenceResult.status === 'fulfilled' && sequenceResult.value) {
        const nextSequence = asSequence(sequenceResult.value)
        if (nextSequence) setSequence((current) => jsonEqual(current, nextSequence) ? current : nextSequence)
      }
      applyJobsSnapshot(nextJobs)
      applyNotebook(nextNotebook, nextAssets, nextJobs)
    },
  })

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
    const inScope = () => {
      const scope = watchScopeRef.current
      return scope.bookId === params.bookId
        && scope.notebookId === params.notebookId
    }
    const resyncSnapshot = async (): Promise<void> => {
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
      if (!inScope()) return
      const nextNotebook = asNotebook(notebookValue)
      if (!nextNotebook) return
      const nextAssets = asAssets(assetValue)
      const nextJobs = asJobs(jobValue)
      if (fetchedAt < watchSnapshotClockRef.current) return
      watchSnapshotClockRef.current = fetchedAt
      setAssets((current) =>
        jsonEqual(current, nextAssets) ? current : nextAssets)
      applyJobsSnapshot(nextJobs)
      applyNotebook(nextNotebook, nextAssets, nextJobs)
    }
    const settleSnapshot = async (): Promise<void> => {
      for (let attempt = 0; attempt < notebookRunResyncAttempts; attempt += 1) {
        if (!inScope()) return
        try {
          await resyncSnapshot()
          return
        } catch {
          await delay(notebookRunResyncDelayMs)
        }
      }
    }
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
            await settleSnapshot()
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
            await settleSnapshot()
            return {
              kind: 'failed',
              message:
                `Lost contact with the server while watching @${params.address}: ${detail}`,
            }
          }
          await delay(params.intervalMs)
        }
      }
      await settleSnapshot()
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
  }, chat?: ChatExecution) => {
    try {
      const outcome = await watchNotebookRun({
        ...params,
        intervalMs: notebookGenerationWatchIntervalMs,
        timeoutMs: notebookGenerationWatchTimeoutMs,
        maxPollFailures: 10,
      })
      if (outcome.kind === 'completed') {
        presentChat(chat, () => {
          setNotice(`@${params.address} generated`)
          highlightCells([params.cellId], { scroll: 'offscreen' })
        })
        setCellRunError(params.cellId, null)
        return
      }
      if (outcome.kind === 'failed') {
        const message = outcome.message ?? `@${params.address} failed`
        setCellRunError(params.cellId, message)
        presentChat(chat, () => setNotice(message, 'error'))
        return
      }
      if (outcome.kind === 'timeout') {
        presentChat(chat, () => setNotice(
          `@${params.address} is still running — check the Jobs screen`,
        ))
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setCellRunError(params.cellId, message)
      presentChat(chat, () => setNotice(message, 'error'))
    } finally {
      setCellQueued(params.cellId, false)
    }
  }, [highlightCells, setCellQueued, setCellRunError, setNotice, watchNotebookRun])

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
            cellExecutionError(nextNotebook, params.cellId),
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

  const collapseComposerAfterCellCreation = useCallback((chat?: ChatExecution) => {
    const scope = watchScopeRef.current
    if (scope.bookId !== bookId || scope.notebookId !== notebook?.id) return
    // Closing the dock ends a voice conversation, so a live one keeps it open.
    if (voiceActiveRef.current) return
    presentChat(chat, () => setComposerDockOpen(false))
  }, [bookId, notebook?.id])

  const runCell = useCallback(async (
    cellId: string,
    providedNotebook?: NotebookSnapshot,
    chat?: ChatExecution,
    retryFailedCellId?: string,
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
        }, { chat },
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
          const plan = await createGenerationPlan(cellId, 'ui', chat)
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
          reviewChat(chat, false, () => setPendingChatAction(null))
          reviewChat(chat, false, () => setPendingCommandPlan(null))
          const accepted = await startNotebookCellRun({
            start: () => call('run_notebook_cell', {
              book_id: bookId,
              notebook_id: plannedNotebookId,
              cell_id: cellId,
              plan,
              ...(retryFailedCellId ? { retry_failed_cell_id: retryFailedCellId } : {}),
              actor: 'videobook-user',
            }, { chat }),
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
          if (outputCellId) collapseComposerAfterCellCreation(chat)
          const watchCellId = outputCellId ?? cellId
          let address = notebookGridAddress(cell.slot)
          if (outputCellId) {
            const notebookValue = await call('get_notebook', {
              book_id: bookId,
              notebook_id: plannedNotebookId,
            }, { background: true, chat })
            const nextNotebook = asNotebook(notebookValue)
            if (nextNotebook) {
              applyNotebook(nextNotebook, assets, jobs)
              const output = nextNotebook.cells.find((candidate) =>
                candidate.id === outputCellId)
              if (output) address = notebookGridAddress(output.slot)
            }
            presentChat(chat, () => revealCells([outputCellId]))
            setCellRunError(outputCellId, null)
            setCellQueued(outputCellId, true)
            if (selectedCellIdsRef.current.has(cellId)) {
              selectCanvasCell(null, chat)
              presentChat(chat, () =>
                highlightCells([outputCellId], { scroll: 'center' }))
            }
          }
          presentChat(chat, () => setNotice(`${notebookGridTag(cell.slot)} queued`))
          void watchGenerationRun({
            bookId,
            notebookId: plannedNotebookId,
            cellId: watchCellId,
            address,
            runId,
            jobOperationId,
          }, chat)
          return {
            ok: true,
            message: `${notebookGridTag(cell.slot)} queued`,
          }
        }
        const outcome = await prepareGenerationPlan(cellId, 'ui', chat)
        presentChat(chat, () => setNotice(outcome.message, outcome.ok ? 'info' : 'error'))
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
        }, { chat }),
        onStarting: () => setCellQueued(cellId, true),
        onRejected: () => setCellQueued(cellId, false),
      })
      const runId = asString(recordValue(accepted)?.run_id)
      const jobOperationId = asString(recordValue(accepted)?.job_id)
      if (!runId || !jobOperationId) {
        throw new Error('The server did not return a notebook run')
      }
      presentChat(chat, () => setNotice(`${notebookGridTag(cell.slot)} queued`))
      const outcome = await watchNotebookRun({
        bookId,
        notebookId: currentNotebook.id,
        cellId,
        address: notebookGridAddress(cell.slot),
        runId,
        jobOperationId,
        intervalMs: notebookRunPollIntervalMs,
        timeoutMs: notebookRunPollTimeoutMs,
        maxPollFailures: notebookRunMaxPollFailures,
      })
      if (outcome.kind === 'failed') {
        throw new Error(outcome.message ?? `${notebookGridTag(cell.slot)} failed`)
      }
      if (outcome.kind === 'timeout') {
        throw new Error('Notebook run did not finish within five minutes')
      }
      if (outcome.kind === 'completed') {
        presentChat(chat, () => setNotice(`${notebookGridTag(cell.slot)} updated`))
      }
      return {
        ok: true,
        message: `${notebookGridTag(cell.slot)} run accepted`,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setCellRunError(cellId, message)
      presentChat(chat, () => setNotice(message, 'error'))
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
    collapseComposerAfterCellCreation,
    createGenerationPlan,
    highlightCells,
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
    if (highlightedCellIds.size > 0) {
      next = next.map((node) => highlightedCellIds.has(node.id)
        ? { ...node, data: { ...node.data, highlighted: true } }
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
  }, [cellRunErrors, highlightedCellIds, nodes, queuedCellIds, revealingCellIds])
  const canvasPresentationNodes = useMemo(() => presentedNodes.map((node) => {
    const selected = selectedCellIds.has(node.id)
    const role = pendingReviewRoles.get(notebookGridAddress(node.data.slot))
    const className = role ? `notebook-review-${role}` : undefined
    return node.selected === selected && node.className === className
      ? node
      : { ...node, selected, className }
  }), [pendingReviewRoles, presentedNodes, selectedCellIds])
  const focusedEdges = useMemo(
    () => notebookEdgesWithCellFocus(edges, selectedCellId),
    [edges, selectedCellId],
  )
  const notebookOccupiedSlots = useMemo(
    () => nodes.flatMap((node) => notebookCellOccupiedSlots({ type: node.data.kind, slot: node.data.slot })),
    [nodes],
  )
  const notebookLaneCells = useMemo(
    () => nodes.map((node) => ({
      type: node.data.kind,
      slot: node.data.slot,
    })),
    [nodes],
  )
  const notebookBaseMetrics = useMemo(
    () => notebookGridMetrics(
      notebookOccupiedSlots,
      {
        viewportWidth: notebookSurface.width,
        viewportHeight: notebookSurface.height,
        zoom: notebookZoom,
      },
    ),
    [
      notebookOccupiedSlots,
      notebookSurface.height,
      notebookSurface.width,
      notebookZoom,
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
            zoom: notebookZoom,
          },
        )
      : notebookBaseMetrics,
    [
      notebookOccupiedSlots,
      notebookBaseMetrics,
      notebookSurface.height,
      notebookSurface.width,
      notebookZoom,
      previewSlot,
    ],
  )
  const notebookFrameSize = useMemo(
    () => notebookGridFrameSize(notebookMetrics, notebookZoom),
    [notebookMetrics, notebookZoom],
  )
  const notebookLaneSections = useMemo(
    () => groupNotebookLaneSections(
      summarizeNotebookLaneRows(notebookLaneCells, notebookMetrics.rowCount),
    ),
    [notebookLaneCells, notebookMetrics.rowCount],
  )
  const notebookFlowStyle = useMemo<CSSProperties>(
    () => ({
      '--notebook-detail-scale': notebookGridDetailScale(notebookZoom),
      width: notebookFrameSize.width,
      height: notebookFrameSize.height,
    }) as CSSProperties,
    [notebookFrameSize.height, notebookFrameSize.width, notebookZoom],
  )
  const notebookViewport = useMemo(
    () => notebookGridViewport(
      notebookMetrics,
      notebookZoom,
    ),
    [notebookMetrics, notebookZoom],
  )
  const revealLatestNotebookResult = useCallback(() => {
    if (screen !== 'notebook') return
    revealNotebookResult(() => notebookScrollRef.current)
  }, [notebookScrollRef, screen])
  const dismissPendingCommandPlan = useCallback(() => {
    cancelChatReview()
    voiceOutcomeRef.current?.({ status: 'cancelled', message: 'Pending action cancelled on screen.' })
    // Declining one step declines the chain: later steps consume its output, so
    // running them would act on something that was never made.
    if (pendingChatAction?.kind === 'chain-step' && bookId) {
      const chainId = pendingChatAction.chainId
      saveValue('videobook.active-chain', '')
      void call('chain', { action: 'cancel', book_id: bookId, chain_id: chainId })
        .catch(() => undefined)
    }
    if (pendingChatAction?.kind === 'subtitles') subtitles.close()
    setPendingCommandPlan(null)
    setPendingChatAction(null)
    setPendingWatermarkReview(null)
    focusCommandComposer()
  }, [bookId, call, cancelChatReview, focusCommandComposer, pendingChatAction, subtitles])
  const updatePendingXPostDraft = useCallback((patch: XPostDraftPatch) => {
    setPendingChatAction((current) => {
      if (current?.kind !== 'routed') return current
      if (current.plan.tool !== 'post' && current.plan.routedTool !== 'post') {
        return current
      }
      return {
        ...current,
        plan: {
          ...current.plan,
          params: reviseXPostParams(current.plan.params, patch),
        },
      }
    })
  }, [])
  const updatePendingXPostThreadOptions = useCallback((
    patch: Partial<XPostThreadOptions>,
  ) => {
    setPendingChatAction((current) => {
      if (current?.kind !== 'routed' || !current.xPostReview) return current
      const xPostReview = {
        ...current.xPostReview,
        options: { ...current.xPostReview.options, ...patch },
      }
      return {
        ...current,
        xPostReview,
        plan: {
          ...current.plan,
          params: reviseXPostFollowups(
            current.plan.params,
            xPostFollowupsFromThread(xPostReview),
          ),
        },
      }
    })
  }, [])
  // Re-derive the thread replies when X reports a different post length, so
  // an untrimmed prompt appears once a Premium account is confirmed.
  const syncPendingXPostLimit = useCallback((maxCharacters: number) => {
    setPendingChatAction((current) => {
      if (current?.kind !== 'routed' || !current.xPostReview) return current
      const xPostReview = withXPostThreadLimit(current.xPostReview, maxCharacters)
      if (xPostReview === current.xPostReview) return current
      return {
        ...current,
        xPostReview,
        plan: {
          ...current.plan,
          params: reviseXPostFollowups(
            current.plan.params,
            xPostFollowupsFromThread(xPostReview),
          ),
        },
      }
    })
  }, [])
  const updatePendingXPostThreadPrompt = useCallback((
    stepId: string,
    text: string,
  ) => {
    setPendingChatAction((current) => {
      if (current?.kind !== 'routed' || !current.xPostReview) return current
      const xPostReview = {
        ...current.xPostReview,
        promptOverrides: {
          ...current.xPostReview.promptOverrides,
          [stepId]: text,
        },
      }
      return {
        ...current,
        xPostReview,
        plan: {
          ...current.plan,
          params: reviseXPostFollowups(
            current.plan.params,
            xPostFollowupsFromThread(xPostReview),
          ),
        },
      }
    })
  }, [])
  const updatePendingXPostThreadCredits = useCallback((text: string) => {
    setPendingChatAction((current) => {
      if (current?.kind !== 'routed' || !current.xPostReview) return current
      const xPostReview = { ...current.xPostReview, creditsOverride: text }
      return {
        ...current,
        xPostReview,
        plan: {
          ...current.plan,
          params: reviseXPostFollowups(
            current.plan.params,
            xPostFollowupsFromThread(xPostReview),
          ),
        },
      }
    })
  }, [])
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
    chat?: ChatExecution,
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
        prompt: notebookChatGenerationCellPrompt(draft, document),
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
    }, { chat, background: true })
  }, [bookId, call])
  const pendingGenerationPreviewRequestRef = useRef(0)
  useEffect(() => () => {
    pendingGenerationPreviewRequestRef.current += 1
  }, [bookId, notebook?.id])
  const requestPendingGenerationPreview = useCallback((
    draft: NotebookChatGenerationDraft,
    document: NotebookDocument,
    chat?: ChatExecution,
  ) => {
    const requestId = ++pendingGenerationPreviewRequestRef.current
    const requestKey = JSON.stringify({
      id: draft.cell.id,
      prompt: draft.cell.prompt,
      action: draft.action.id,
      inputs: draft.cell.inputs,
      connections: draft.connections,
    })
    presentChat(chat, () => setPendingChatAction((current) => current?.kind === 'generation'
      && current.draft.cell.id === draft.cell.id
      ? {
          ...current,
          previewError: null,
          previewLoading: true,
          previewStale: true,
        }
      : current))
    void loadPendingGenerationPreview(draft, document, chat)
      .then((preview) => {
        if (pendingGenerationPreviewRequestRef.current !== requestId) return
        presentChat(chat, () => setPendingChatAction((current) => {
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
        }))
      })
      .catch((error: unknown) => {
        if (pendingGenerationPreviewRequestRef.current !== requestId) return
        presentChat(chat, () => setPendingChatAction((current) => {
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
                previewStale: false,
              }
            : current
        }))
      })
  }, [loadPendingGenerationPreview])
  const pendingGenerationRefresh = useGenerationPreviewRefresh(
    requestPendingGenerationPreview,
    `${bookId}:${notebook?.id}:${pendingGenerationDraft?.cell.id}`,
  )
  const setPendingGenerationDraft = useCallback((
    draft: NotebookChatGenerationDraft,
    refreshPreview: boolean,
  ) => {
    pendingGenerationPreviewRequestRef.current += 1
    pendingGenerationRefresh.cancel()
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
    if (notebook) {
      if (refreshPreview) requestPendingGenerationPreview(draft, notebook)
      else pendingGenerationRefresh.schedule(draft, notebook)
    }
  }, [notebook, pendingGenerationRefresh, requestPendingGenerationPreview])
  const updatePendingGenerationPrompt = useCallback((prompt: string) => {
    if (!pendingGenerationDraft) return
    setPendingGenerationDraft(
      reviseNotebookChatGenerationPrompt(pendingGenerationDraft, prompt),
      false,
    )
  }, [pendingGenerationDraft, setPendingGenerationDraft])
  const pendingGenerationPromptHistory = usePromptHistory({
    call: mcp.state === 'ready' ? call : undefined,
    bookId: bookId ?? '',
    surface: pendingGenerationDraft ? generationPromptSurface(pendingGenerationDraft.cell.type) : null,
    prompt: pendingGenerationDraft?.cell.prompt ?? '',
    onApply: updatePendingGenerationPrompt,
  })
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
    pendingGenerationRefresh.cancel()
    requestPendingGenerationPreview(pendingGenerationDraft, notebook)
  }, [notebook, pendingGenerationDraft, pendingGenerationRefresh, requestPendingGenerationPreview])
  const selectPendingGenerationSource = useCallback((cellId: string) => {
    selectCanvasCell(cellId)
    if (composerDockShouldOpen('selection')) setComposerDockOpen(true)
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
    pendingGenerationRefresh.cancel()
    requestPendingGenerationPreview(next, notebook)
  }, [
    generationActions,
    notebook,
    pendingGenerationDraft,
    pendingGenerationRefresh,
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

  /* Bring the slot a review is about into the middle of the canvas when the
     sheet opens. A viewport move, not a focus move: the zoom is untouched and
     the keyboard stays wherever the sheet put it. */
  const reviewFocusRow = useMemo(() => {
    const address = pendingReviewAddresses.target ?? pendingReviewAddresses.sources[0] ?? null
    return address ? parseNotebookGridAddress(address)?.row ?? null : null
  }, [pendingReviewAddresses])
  useEffect(() => {
    if (screen !== 'notebook' || reviewFocusRow === null) return
    revealNotebookReviewRow(
      () => notebookScrollRef.current,
      { row: reviewFocusRow, zoom: notebookZoom },
      {
        reducedMotion: typeof window !== 'undefined'
          && typeof window.matchMedia === 'function'
          && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      },
    )
  }, [notebookScrollRef, notebookZoom, reviewFocusRow, screen])

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
  const notebookImageCellIds = useMemo(
    () => new Set([...notebookCellAssets].flatMap(([cellId, cellAsset]) =>
      cellAsset.type === 'image' ? [cellId] : [])),
    [notebookCellAssets],
  )
  const selectedCellError = notebook && selectedNotebookCell
    ? (
      notebookCellExecutionObservation(notebook, selectedNotebookCell.id).error
      ?? cellRunErrors[selectedNotebookCell.id]
      ?? null
    )
    : null
  const inspectorJobViews = useMemo(
    () => jobs.map(notebookRunJobViewFromRecord),
    [jobs],
  )
  const selectedGenerationState = selectedNotebookCell
    ? mediaCellGenerationState({
      cell: selectedNotebookCell,
      cells: notebook?.cells ?? [],
      edges: notebook?.edges ?? [],
      queuedCellIds,
      runErrors: cellRunErrors,
      error: selectedCellError,
      jobs: inspectorJobViews,
    })
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
    }, { background: true })
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

  const inspectGenerationRequest = useCallback(async (assetId: string) => {
    if (!bookId) throw new Error('Book is not ready')
    const value = await call('inspect_generation_request', {
      book_id: bookId,
      asset_id: assetId,
    }, { background: true })
    return parseGenerationRequestInspection(value)
  }, [bookId, call])

  const downloadGenerationHar = useCallback(async (generationId: string) => {
    if (!bookId) throw new Error('Book is not ready')
    saveGenerationHar(await fetchGenerationHar(call, bookId, generationId))
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

  const refreshNotebook = useCallback(async (targetBookId: string, notebookId: string, chat?: ChatExecution) => {
    const value = await call('get_notebook', {
      book_id: targetBookId,
      notebook_id: notebookId,
    }, { background: true, chat })
    const next = asNotebook(value)
    if (!next) throw new Error('The server returned an invalid notebook')
    if (chat && !chat.isInScope()) throw new Error('Workspace changed while refreshing the notebook.')
    applyNotebook(next, assets, jobs, targetBookId)
    return next
  }, [applyNotebook, assets, call, jobs])

  const refreshBookData = useCallback(async (targetBookId: string, preferredNotebookId?: string, isCurrent?: () => boolean, chat?: ChatExecution) => {
    if (isCurrent?.() === false || (chat && !chat.isInScope())) return
    const requestId = bookDataRequestRef.current + 1
    bookDataRequestRef.current = requestId
    const response = await guardedAsyncResult(
      async () => await Promise.all([
        call('list_notebooks', { book_id: targetBookId }, { background: true, chat }),
        call('list_assets', {
          book_id: targetBookId,
          sort: 'newest',
          limit: 200,
          include_referenced: true,
        }, { background: true, chat }),
        call('get_primary_sequence', { book_id: targetBookId }, { background: true, chat }),
        call('list_jobs', { book_id: targetBookId, limit: 200 }, { background: true, chat }),
        call('list_notebook_actions', { book_id: targetBookId }, { background: true, chat }),
      ]),
      () => bookDataRequestRef.current === requestId && isCurrent?.() !== false && (!chat || chat.isInScope()),
    )
    if (response.kind === 'stale') return
    if (response.kind === 'error') throw response.error
    const [
      notebookValue,
      assetValue,
      sequenceValue,
      jobValue,
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
    applyNotebook(nextNotebook, nextAssets, nextJobs, targetBookId)
    resumeMediaProcessingWatches(targetBookId, nextNotebook, nextAssets)
    if (nextNotebook.cells.some((cell) => cell.type === 'goal')) {
      void refreshGoals({ bookId: targetBookId, notebookId: nextNotebook.id }).catch(() => undefined)
    }
    return nextNotebook
  }, [applyNotebook, call, refreshGoals, resumeMediaProcessingWatches])

  const openGoalTile = (cellId: string) => {
    showScreen('notebook')
    openCellInspector(cellId)
    revealNotebookCanvasCell(cellId)
  }

  const startGoal = async (brief = '', chat?: ChatExecution): Promise<ComposerOutcome> => {
    if (!bookId || !notebook) return { ok: false, message: 'Open a notebook first.' }
    if (!brief) {
      if (!activeComposerGoal) {
        return { ok: false, message: 'Mention the reference images or videos, for example /goal @a1 @a2 as a short clip.' }
      }
      openGoalTile(activeComposerGoal.cellId)
      return { ok: true, message: `Opened goal ${activeComposerGoal.address ?? ''}`.trim() }
    }
    if (scanNotebookMentions(brief).length === 0) return { ok: false, message: 'Mention the reference images or videos, for example /goal @a1 @a2 as a short clip' }
    const scope = { bookId, notebookId: notebook.id }
    const goal = await actOnGoal(scope, { action: 'create', brief, request_id: uuidv7() }, chat)
    if (watchScopeRef.current.bookId !== scope.bookId || watchScopeRef.current.notebookId !== scope.notebookId || chat?.isCurrent() === false) {
      return { ok: true, message: 'Goal saved in its notebook.' }
    }
    await refreshBookData(scope.bookId, scope.notebookId, undefined, chat)
    revealNotebookCanvasCell(goal.cellId)
    collapseComposerAfterCellCreation(chat)
    openGoalTile(goal.cellId)
    return { ok: true, message: `Planning your video goal in ${goal.address ?? 'a new tile'}` }
  }

  const runGoalAction = async (args: Record<string, unknown>) => {
    if (!goalScope) throw new Error('Open the goal notebook first.')
    const scope = goalScope
    const goal = await actOnGoal(scope, args)
    if (args.action === 'combine') {
      await refreshBookData(scope.bookId, scope.notebookId)
      return goal
    }
    if (args.action !== 'approve' && args.action !== 'regenerate' && args.action !== 'revise' && args.action !== 'retry') return goal
    if (watchScopeRef.current.bookId === scope.bookId && watchScopeRef.current.notebookId === scope.notebookId) collapseComposerAfterCellCreation()
    await refreshBookData(scope.bookId, scope.notebookId)
    return goal
  }

  const previewGoalSequence = async (frame: number) => {
    if (!goalScope) return
    const scope = goalScope
    const refreshed = await refreshBookData(scope.bookId, scope.notebookId, () => watchScopeRef.current.bookId === scope.bookId && watchScopeRef.current.notebookId === scope.notebookId)
    const cell = refreshed?.cells.find((candidate) => candidate.type === 'timeline')
    if (!cell) throw new Error('Add a timeline cell to preview the assembled sequence.')
    openTimelinePreview(cell.id, frame)
  }

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
    mode: MediaFullscreenMode = 'view',
  ) => {
    if (!bookId || !notebook) return
    const session: MediaFullscreenSession = {
      mode,
      initialInstruction: imageEditInstructionsRef.current.get(bookId)
        ?? savedValue(`videobook.image-edit-instruction:${bookId}`),
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
    pauseComposerDockMedia(document.querySelector('.command-composer'))
    actionCatalogRequestRef.current += 1
    setActionDiscovery(null)
    setActionComposer(null)
    const requestId = imageSubjectMapRequestRef.current + 1
    imageSubjectMapRequestRef.current = requestId
    setMediaFullscreenComposerTarget(null)
    setMediaFullscreenSidebarEditing(false)
    setMediaFullscreen(session)
    setComposerDockOpen(true)
    if (asset.type === 'image') imageEditModels.ensureLoaded(bookId)
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
  }, [bookId, call, imageEditModels, notebook, updateFullscreenSubjectMap, watchImageSubjectMap])

  const closeMediaFullscreen = useCallback(() => {
    actionCatalogRequestRef.current += 1
    setActionDiscovery(null)
    setActionComposer(null)
    imageSubjectMapRequestRef.current += 1
    setMediaFullscreenComposerTarget(null)
    setMediaFullscreenSidebarEditing(false)
    setMediaFullscreen(null)
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
    collapseComposerAfterCellCreation()
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
      maxPollFailures: notebookRunMaxPollFailures,
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
    chat?: ChatExecution,
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
    const editModelId = input.model ?? DEFAULT_IMAGE_EDIT_MODEL_ID
    const editModelProvider = editModelId.startsWith('fal-ai/')
      || editModelId.startsWith('alibaba/')
      ? 'fal'
      : 'kie'
    if (
      (input.operation !== 'remove' || (input.editRegions?.length ?? 0) > 0)
      && !acceptCloudGenerationConsent({
        provider: editModelProvider,
        model: editModelId,
        tool: 'edit_image_subjects',
      })
    ) return false
    const requestId = imageSubjectMapRequestRef.current
    const isCurrent = () => {
      const scope = watchScopeRef.current
      return imageSubjectMapRequestRef.current === requestId
        && scope.bookId === session.bookId
        && scope.notebookId === session.notebookId
    }
    const response = await guardedAsyncResult(
      async () => await call('edit_image_subjects', {
        book_id: session.bookId,
        notebook_id: session.notebookId,
        source_cell_id: session.cellId,
        artifact_id: session.asset.artifactId,
        object_hash: session.asset.objectHash,
        ...(input.subjectIds.length > 0 ? { subject_ids: input.subjectIds } : {}),
        operation: input.operation,
        ...(input.model ? { model: input.model } : {}),
        ...(input.prompt ? { prompt: input.prompt } : {}),
        ...(input.editRegions?.length ? { edit_regions: input.editRegions } : {}),
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
      }, { chat }),
      isCurrent,
    )
    if (response.kind === 'stale') return false
    if (response.kind === 'error') throw response.error
    const result = response.value
    const status = asString(recordValue(result)?.status) ?? 'queued'
    presentChat(chat, () => setNotice(
      input.operation === 'remove'
        ? `${input.editRegions?.length ? 'Region' : 'Subject'} removal ${status}`
        : input.operation === 'replace'
          ? `Region replacement ${status}`
          : input.operation === 'whole_image'
            ? `Whole-image edit ${status}`
            : `${input.editRegions?.length ? 'Region' : 'Subject'} edit ${status}`,
    ))
    await refreshBookData(session.bookId, session.notebookId, isCurrent, chat).catch(() => undefined)
    const producerCellId = asString(recordValue(result)?.producer_cell_id)
    if (producerCellId && isCurrent()) {
      presentChat(chat, () => {
        closeMediaFullscreen()
        selectCanvasCell(producerCellId, chat)
        setSourceViewCellId(null)
        setHistoryViewCellId(null)
        collapseComposerAfterCellCreation(chat)
        revealNotebookCanvasCell(producerCellId)
      })
    }
    return true
  }, [bookId, call, closeMediaFullscreen, collapseComposerAfterCellCreation, refreshBookData, revealNotebookCanvasCell, selectCanvasCell, setNotice])

  const refreshBookList = useCallback(async () => {
    const value = await call('list_books', { sort: 'newest' })
    const nextBooks = asBooks(value)
    setBooks(nextBooks)
    return nextBooks
  }, [call])

  /**
   * Forget: delete the asset and destroy its stored bytes. Irreversible, so it
   * confirms first, and again when the engine reports what still holds it.
   */
  const forgetAsset = useCallback(async (asset: LibraryAssetRecord, confirmed = false): Promise<ComposerOutcome> => {
    const name = `@${asset.id}`
    if (asset.owningBookId !== bookId) {
      setNotice(`Open ${asset.owningBookName} to forget ${name}`, 'error')
      return { ok: false, message: `Open ${asset.owningBookName} first` }
    }
    if (!confirmed && !window.confirm(forgetConfirmation(name))) return { ok: false, message: 'Forget cancelled' }
    setBusy(true)
    try {
      let outcome = asForgetAssetOutcome(await call('delete_asset', {
        book_id: bookId,
        asset_id: asset.artifactId,
        forget: true,
      }))
      if (outcome.status === 'in_use') {
        if (!window.confirm(clearReferencesConfirmation(name, outcome.references))) {
          return { ok: false, message: 'Forget cancelled; media is still in use' }
        }
        outcome = asForgetAssetOutcome(await call('delete_asset', {
          book_id: bookId,
          asset_id: asset.artifactId,
          forget: true,
          clear_references: true,
        }))
      }
      if (outcome.status === 'in_use') {
        setNotice(
          clearReferencesConfirmation(name, outcome.references).split('\n')[0],
          'error',
        )
        return { ok: false, message: clearReferencesConfirmation(name, outcome.references).split('\n')[0]! }
      }
      setNotice(forgottenNotice(name, outcome))
      await refreshBookData(bookId, notebook?.id)
      await refreshBookList()
      return { ok: true, message: forgottenNotice(name, outcome) }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error), 'error')
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    } finally {
      setBusy(false)
    }
  }, [
    bookId,
    call,
    notebook?.id,
    refreshBookData,
    refreshBookList,
    setNotice,
  ])


  const refreshBookCommands = useCallback(async () => {
    const [value, catalogValue] = await Promise.all([call('slash_commands', { detail: 'full' }), call('list_workspace_actions', { detail: 'full' })])
    const catalog = asWorkspaceActionCatalog(catalogValue)
    setWorkspaceActions(catalog.actions)
    setCommands(workspaceActionCommands(catalog.actions, asCommands(value)))
  }, [call])

  const queueTranscribeEstimate = (
    assetId: string,
    languageCode: string,
    diarize: boolean,
    tagAudioEvents: boolean,
  ) => {
    if (!bookId) return
    const request = ++transcribeEstimateRequestRef.current
    const args = transcribeToolArgs({
      bookId,
      assetId,
      languageCode,
      diarize,
      tagAudioEvents,
    })
    void call('estimate_cost', {
      calls: [{ tool_name: 'transcribe', input: args }],
    }, { background: true }).then((value) => {
      if (request !== transcribeEstimateRequestRef.current) return
      const next = transcribeEstimateView(recordValue(recordValue(value)?.estimate))
      setPendingChatAction((current) => current?.kind === 'transcribe' && current.assetId === assetId
        ? {
            ...current,
            estimateUsd: next.usd,
            estimateLoading: false,
            estimateUnavailable: next.unavailable,
          }
        : current)
    }).catch(() => {
      if (request !== transcribeEstimateRequestRef.current) return
      setPendingChatAction((current) => current?.kind === 'transcribe' && current.assetId === assetId
        ? { ...current, estimateUsd: null, estimateLoading: false, estimateUnavailable: true }
        : current)
    })
  }

  const openTranscribeReview = (input: {
    assetRef?: string
    languageCode?: string
    diarize?: boolean
    tagAudioEvents?: boolean
    chat?: ChatExecution
  }): ComposerOutcome => {
    if (!bookId) return { ok: false, message: 'Load or create a book first.' }
    const addressByArtifactId = new Map(commandMentionAssets.map((asset) => [asset.artifactId, asset.cellAddress]))
    const fullscreen = mediaFullscreen?.asset
    const previewMedia = workspacePreview?.media
    const preview = fullscreen && mediaCellHasSpokenAudio(fullscreen.type)
      ? { assetId: fullscreen.artifactId, type: fullscreen.type }
      : previewMedia && mediaCellHasSpokenAudio(previewMedia.type)
        ? { assetId: previewMedia.assetId, type: previewMedia.type }
        : null
    const resolved = resolveTranscribeTarget({
      assetRef: input.assetRef,
      selectedCell: selectedNotebookCell
        ? {
            outputArtifactId: selectedNotebookCell.outputArtifactId,
            type: selectedNotebookCell.type,
          }
        : null,
      preview,
      assets,
      addressByArtifactId,
    })
    if (!resolved.ok) return resolved
    const languageCode = input.languageCode?.trim() ?? ''
    const diarize = input.diarize ?? true
    const tagAudioEvents = input.tagAudioEvents ?? true
    actionCatalogRequestRef.current += 1
    reviewChat(input.chat, false, () => setPendingCommandPlan(null))
    reviewChat(input.chat, false, () => setPendingWatermarkReview(null))
    reviewChat(input.chat, false, () => setActionDialog(null))
    reviewChat(input.chat, false, () => setActionDiscovery(null))
    reviewChat(input.chat, true, () => setPendingChatAction({
      kind: 'transcribe',
      assetId: resolved.assetId,
      languageCode,
      diarize,
      tagAudioEvents,
      estimateUsd: null,
      estimateLoading: resolved.assetId !== null,
      estimateUnavailable: false,
    }))
    setComposerDockOpen(true)
    if (resolved.assetId) {
      queueTranscribeEstimate(resolved.assetId, languageCode, diarize, tagAudioEvents)
    } else {
      transcribeEstimateRequestRef.current += 1
    }
    const address = resolved.assetId ? addressByArtifactId.get(resolved.assetId) : null
    const label = address
      ? `@${address}`
      : resolved.assetId
        ? assets.find((asset) => asset.artifactId === resolved.assetId)?.label ?? resolved.assetId
        : null
    return generationApplyReadyOutcome(label
      ? `Transcribe review ready for ${label}`
      : 'Transcribe review ready. Choose a clip.')
  }

  const transcribeAsset = (artifactId: string) => {
    const outcome = openTranscribeReview({ assetRef: artifactId })
    if (!outcome.ok) setNotice(outcome.message, 'error')
  }

  const openWorkspaceActions = async (actionId?: string, values?: Record<string, unknown>, query?: string, returnFocus?: HTMLElement | null, chat?: ChatExecution) => {
    if (actionId === 'tool.transcribe') {
      const outcome = openTranscribeReview({
        assetRef: asString(values?.asset_id) ?? undefined,
        languageCode: asString(values?.language_code) ?? '',
        diarize: typeof values?.diarize === 'boolean' ? values.diarize : true,
        tagAudioEvents: typeof values?.tag_audio_events === 'boolean' ? values.tag_audio_events : true,
        chat,
      })
      if (!outcome.ok) presentChat(chat, () => setNotice(outcome.message, 'error'))
      return
    }
    if (mcp.state !== 'ready') return
    setComposerDockOpen(true)
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const opener = returnFocus ?? actionDialog?.opener ?? (active === document.body || active?.closest('.command-composer')
      ? document.querySelector<HTMLElement>('[aria-label="Videobook command input"]') : active)
    const targetBookId = typeof values?.book_id === 'string' ? values.book_id : bookId
    const request = ++actionCatalogRequestRef.current
    if (actionId) {
      setActionDiscovery(null)
      setActionDialog({ key: request, actionId, values, query, opener })
    } else {
      const session = targetBookId === bookId && mediaFullscreen?.asset.type === 'image' ? `image-edit:${mediaFullscreen.key}` : `chat:${targetBookId}`
      setActionDialog(null)
      setActionDiscovery({ key: request, query: query ?? '', values, bookId: targetBookId, session })
      setActionComposer({ bookId: targetBookId, session, opener })
    }
    setActionCatalogStatus({ loading: true, error: null })
    try {
      const catalog = actionId && workspaceActions.length ? { actions: workspaceActions }
        : asWorkspaceActionCatalog(await call('list_workspace_actions', { detail: 'full' }, { chat }))
      if (request !== actionCatalogRequestRef.current || (chat && !chat.isCurrent())) return
      setWorkspaceActions(catalog.actions)
      const action = catalog.actions.find((entry) => entry.id === actionId)
      if (action) {
        const reference = values?.asset_id ?? values?.artifact_id
        const seededValues = { ...initialActionValues(action, { ...workspaceActionContext, assetId: typeof reference === 'string' ? reference : workspaceActionContext.assetId }), ...values }
        if (action.handler.kind === 'tool' && action.handler.tool === 'create_notebook_cell' && values?.slot) {
          seededValues.cell = { ...recordValue(seededValues.cell), slot: values.slot }
        }
        const resources = await loadWorkspaceActionResources(action, seededValues, (name, args) => call(name, { book_id: seededValues.book_id ?? bookId, ...args }, { chat }))
        if (request !== actionCatalogRequestRef.current || (chat && !chat.isCurrent())) return
        const browse = action.handler.kind === 'tool' && ['list_notebooks', 'list_entities', 'list_book_actions', 'search_archive'].includes(action.handler.tool)
        const result = browse && action.handler.kind === 'tool' ? {
          message: `${action.title} loaded`, value: await call(action.handler.tool, seededValues, { chat }),
        } : undefined
        if (request !== actionCatalogRequestRef.current || (chat && !chat.isCurrent())) return
        setActionDialog((current) => current?.key === request ? { ...current, values: { ...seededValues, ...resources.values }, resources, result } : current)
      }
      setActionCatalogStatus({ loading: false, error: null })
    } catch (cause) {
      if (request !== actionCatalogRequestRef.current || (chat && !chat.isCurrent())) return
      setActionCatalogStatus({ loading: false, error: cause instanceof Error ? cause.message : String(cause) })
    }
  }

  const dismissActionComposer = () => {
    actionCatalogRequestRef.current += 1
    const opener = actionComposer?.opener
    setActionDiscovery(null)
    setActionComposer(null)
    restoreCommandComposerFocus(() => opener?.isConnected ? opener : null)
  }

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

  const showScreen = useCallback((next: Screen) => {
    setScreen(next)
    const path = pathForScreen(next)
    if (window.location.pathname !== path) {
      window.history.pushState({}, '', path)
    }
  }, [])

  useEffect(() => {
    document.title = screenTitle(screen)
  }, [screen])

  useEffect(() => {
    const onPopState = () => {
      const next = screenFromPath(window.location.pathname)
      setScreen(next)
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const chooseBook = useCallback(async (
    nextBookId: string,
  ): Promise<BookProjectMutationResult> => {
    setBusy(true)
    try {
      await refreshBookData(nextBookId)
      const next = books.find((book) => book.bookId === nextBookId)
      setNotice(next ? `Opened ${next.name}` : 'Book opened')
      showScreen('notebook')
      handleBookMenuOpenChange(false)
      return { ok: true }
    } catch (error) {
      const result = bookProjectFailure(error)
      setNotice(result.error, 'error')
      return result
    } finally {
      setBusy(false)
    }
  }, [books, handleBookMenuOpenChange, refreshBookData, setNotice, showScreen])

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
      showScreen('notebook')
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
    showScreen,
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
        showScreen('notebook')
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
    showScreen,
  ])

  const selectedPost = (notebook as NotebookSnapshot | null)?.posts?.find(post => post.id === selectedCellId)

  const createPublication = async (sourceCellId?: string) => {
    if (!bookId || !notebook || mcp.state !== 'ready') return
    setBusy(true)
    try {
      const post = await call('create_post', { book_id: bookId, notebook_id: notebook.id, ...(sourceCellId ? { source_cell_id: sourceCellId } : {}) }) as PostView
      await refreshBookData(bookId, notebook.id)
      openCellInspector(post.id)
      setNotice(`Created Post ${post.address}`)
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error), 'error') }
    finally { setBusy(false) }
  }

  const createCell = async (type: NotebookCellType, position?: { x: number; y: number }) => {
    if (!bookId || !notebook) return
    if (type === 'post') {
      const source = notebook.cells.find(cell => cell.id === selectedCellId && cell.type !== 'post' && cell.outputArtifactId && ['image', 'video', 'generate_image', 'generate_video', 'concat', 'splice', 'split_video'].includes(cell.type))
      await createPublication(source?.id)
      return
    }
    const existing = type === 'timeline' ? notebook.cells.find((cell) => cell.type === 'timeline') : null
    if (existing) {
      selectCanvasCell(existing.id)
      setComposerDockOpen(true)
      document.querySelector(`[data-id="${existing.id}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      return
    }
    let slot: NotebookGridSlot
    try {
      slot = position ? notebookGridDropSlot(position, notebookBaseMetrics)
        : nextNotebookCreationSlot(type, notebook.cells, lastWorkSlot)
      if (type === 'timeline') slot = { row: slot.row, column: 0 }
      const footprint = new Set(notebookCellOccupiedSlots({ type, slot }).map(notebookGridSlotKey))
      if (notebookOccupiedSlots.some((occupied) => footprint.has(notebookGridSlotKey(occupied)))) {
        setNotice(type === 'timeline' ? 'Choose a completely empty row for Timeline' : 'Choose an empty grid square for the new cell', 'error')
        return
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error), 'error')
      return
    }
    setBusy(true)
    try {
      const created = recordValue(await call('create_notebook_cell', {
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
      }))
      const updatedNotebook = await refreshBookData(bookId, notebook.id)
      rememberLastWorkSlot(slot)
      if (type === 'timeline' && typeof created?.id === 'string') {
        selectCanvasCell(created.id)
        requestAnimationFrame(() => document.querySelector(`[data-id="${created.id}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }))
      }
      if (passiveMediaKind(type) && typeof created?.id === 'string') {
        openMediaLibrary(created.id, updatedNotebook)
      } else {
        collapseComposerAfterCellCreation()
      }
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
    options?: { confirm?: boolean },
  ) => {
    if (!bookId || !notebook || cells.length === 0) return
    const uniqueCells = [...new Map(cells.map((cell) => [cell.id, cell])).values()]
    const cellIds = new Set(uniqueCells.map((cell) => cell.id))
    const addresses = uniqueCells.map((cell) => notebookGridTag(cell.slot))
    const count = uniqueCells.length
    const failedCellIds = new Set(presentedNodes
      .filter((node) => node.data.status === 'error')
      .map((node) => node.id))
    const needsConfirm = options?.confirm
      ?? uniqueCells.some((cell) => !failedCellIds.has(cell.id))
    if (needsConfirm) {
      const confirmed = window.confirm(count === 1
        ? `Delete ${addresses[0]}?\n\nThis removes the cell and its connections. This cannot be undone.`
        : `Delete ${count} selected cells?\n\n${addresses.join(', ')}\n\nThis removes the cells and their connections. This cannot be undone.`)
      if (!confirmed) return
    }

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
    setBusy(true)
    try {
      const current = asNotebook(await call('get_notebook', { book_id: bookId, notebook_id: notebook.id }))
      if (!current) throw new Error('Unable to read the notebook before arranging')
      if (watchScopeRef.current.bookId !== bookId || watchScopeRef.current.notebookId !== notebook.id) return
      const planned = planNotebookArrangement(current)
      if (!planned.ok) throw new Error(planned.message)
      const currentSlots = new Map(current.cells.map(cell => [cell.id, cell.slot]))
      const changed = planned.slots.some(slot => {
        const previous = currentSlots.get(slot.id)
        return previous?.row !== slot.row || previous?.column !== slot.column
      })
      const reveal = () => revealNotebookArrangement(() => notebookScrollRef.current)
      if (!changed) {
        await refreshNotebook(bookId, notebook.id)
        setNotice('Notebook is already auto-arranged')
        reveal()
        return
      }
      await call('move_notebook_cells', {
        book_id: bookId,
        notebook_id: notebook.id,
        ...(current.revision ? { expected_revision: current.revision } : {}),
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
    chat?: ChatExecution,
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
      presentChat(chat, () => setNotice(planned.message, 'error'))
      return { ok: false, message: planned.message }
    }
    const axisLabel = axis === 'column'
      ? `column ${anchor.column + 1}`
      : `row ${String.fromCharCode(97 + anchor.row)}`
    if (planned.movedCount === 0) {
      const message = `Videos are already arranged in ${axisLabel}`
      presentChat(chat, () => setNotice(message))
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
      }, { chat })
      await refreshNotebook(bookId, notebook.id, chat)
      rememberLastWorkSlot({ row: anchor.row, column: anchor.column })
      const videoCount = planned.slots.length - planned.displacedCount
      const message = `Arranged ${videoCount} ${videoCount === 1 ? 'video' : 'videos'} in ${axisLabel}`
      presentChat(chat, () => setNotice(message))
      return { ok: true, message }
    } catch (error) {
      await refreshNotebook(bookId, notebook.id, chat).catch(() => undefined)
      const message = error instanceof Error ? error.message : String(error)
      presentChat(chat, () => setNotice(message, 'error'))
      return { ok: false, message }
    } finally {
      setBusy(false)
    }
  }

  const groupImageCells = async (
    anchor: NotebookGridSlot,
    chat?: ChatExecution,
  ): Promise<{ ok: boolean; message: string }> => {
    if (!bookId || !notebook) {
      return { ok: false, message: 'No notebook is open' }
    }
    const planned = planImageGrouping(notebook, notebookImageCellIds, anchor)
    if (!planned.ok) {
      presentChat(chat, () => setNotice(planned.message, 'error'))
      return { ok: false, message: planned.message }
    }
    const anchorLabel = notebookGridTag(anchor)
    if (planned.movedCount === 0) {
      const message = `Images are already grouped from ${anchorLabel}`
      presentChat(chat, () => setNotice(message))
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
      }, { chat })
      await refreshNotebook(bookId, notebook.id, chat)
      rememberLastWorkSlot({ row: anchor.row, column: anchor.column })
      const imageCount = planned.slots.length - planned.displacedCount
      const message = `Grouped ${imageCount} ${imageCount === 1 ? 'image' : 'images'} from ${anchorLabel}`
      presentChat(chat, () => setNotice(message))
      return { ok: true, message }
    } catch (error) {
      await refreshNotebook(bookId, notebook.id, chat).catch(() => undefined)
      const message = error instanceof Error ? error.message : String(error)
      presentChat(chat, () => setNotice(message, 'error'))
      return { ok: false, message }
    } finally {
      setBusy(false)
    }
  }

  const connectCells = async (connection: Connection) => {
    if (!bookId || !notebook || !connection.source || !connection.target) return
    if (!isValidNotebookFlowConnection(notebook.edges, connection, notebook.cells)) {
      const source = notebook.cells.find((cell) => cell.id === connection.source)
      const target = notebook.cells.find((cell) => cell.id === connection.target)
      setNotice(
        source && target
          ? `Connecting ${notebookGridTag(source.slot)} to ${notebookGridTag(target.slot)} would create a cycle`
          : 'That connection would create a cycle',
        'error',
      )
      return
    }
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
    if (!bookId || !notebook || mcp.state !== 'ready') return
    const restoreFocus = capturePointerComposerFocus()
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
    } finally {
      restoreFocus()
    }
  }

  const createMediaCellFromFile = async (
    slot: NotebookGridSlot,
    file: File,
  ) => {
    if (!bookId || !notebook) return
    const restoreFocus = capturePointerComposerFocus()
    if (busy) {
      setNotice('Wait for the current operation to finish', 'error')
      return
    }
    const kind = mediaKindForFile(file)
    if (!kind) {
      setNotice('Drop an image, video, or audio file on an open square', 'error')
      return
    }
    if (notebookOccupiedSlots.some((occupied) =>
      occupied.row === slot.row && occupied.column === slot.column)) {
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
      if (mediaLibraryPicker?.cellId === null) closeMediaLibrary()
      collapseComposerAfterCellCreation()
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
      restoreFocus()
    }
  }

  const closeMediaLibrary = () => {
    const restoreFocus = captureDismissedComposerFocus(mediaLibraryOpenerRef.current)
    mediaLibraryRequestRef.current += 1
    mediaLibraryReference.lifecycle.close()
    setMediaLibraryPicker(null)
    mediaLibraryOpenerRef.current = null
    restoreFocus()
  }

  const loadMediaLibrary = async (
    cellId: string | null,
    query: string,
    offset: number,
    append: boolean,
    criteria?: MediaLibrarySearchCriteria,
    tagFilters?: readonly TagFilterTerm[],
    knownKind?: MediaLibraryKind,
  ) => {
    const cell = notebook?.cells.find((candidate) => candidate.id === cellId)
    const kind = knownKind ?? (cellId === null ? 'all' : cell && passiveMediaKind(cell.type))
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
    // Terms come in with the call rather than being read from state: a chip
    // click sets state and searches in the same tick, and state has not
    // updated yet.
    const activeTagFilters = tagFilters
      ?? (mediaLibraryPicker?.cellId === cellId
        ? mediaLibraryPicker.tagFilters
        : [])
    const requestId = mediaLibraryRequestRef.current + 1
    mediaLibraryRequestRef.current = requestId
    setMediaLibraryPicker((current) => {
      if (!current || current.cellId !== cellId) return current
      return {
        ...current,
        query,
        tagFilters: [...activeTagFilters],
        assets: append ? current.assets : [],
        page: append ? current.page : emptyLibraryPage,
        booksWithErrors: append ? current.booksWithErrors : [],
        preparingIndex: false,
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
      const isCancelled = () => mediaLibraryRequestRef.current !== requestId
      const response = await searchWithPreparation({
        search: () => call('search_library_assets', {
          ...(activeCriteria.mode === 'text' && query.trim()
            ? { query: query.trim() }
            : {}),
          ...(activeCriteria.mode !== 'text' && activeCriteria.reference
            ? { reference_id: activeCriteria.reference.referenceId }
            : {}),
          ...(referenceRange
            ? { reference_range: referenceRange }
            : {}),
          kinds: kind === 'all' ? ['audio', 'image', 'video'] : [kind],
          ...tagFilterArgs(activeTagFilters),
          limit: emptyLibraryPage.limit,
          offset,
        }),
        listJobs: (owningBookId, jobIds) => call('list_jobs', {
          book_id: owningBookId, job_ids: jobIds,
        }, { background: true }),
        onPreparing: (preparingIndex) => {
          if (isCancelled()) return
          setMediaLibraryPicker((current) => current && current.cellId === cellId
            ? { ...current, preparingIndex }
            : current)
        },
        isCancelled,
      })
      if (isCancelled()) return
      const result = asLibrarySearchResult(response)
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
          unindexedVisualAssets: result.unindexedVisualAssets,
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

  const emptyMediaSlotKind = (
    cellId: string,
    currentNotebook: NotebookDocument | null | undefined = notebook,
  ): PassiveMediaKind | null => {
    const cell = currentNotebook?.cells.find((candidate) => candidate.id === cellId)
    const kind = cell ? passiveMediaKind(cell.type) : null
    if (
      !cell
      || !kind
      || cell.outputArtifactId
      || currentNotebook?.edges.some((edge) => edge.target === cellId)
    ) return null
    return kind
  }

  const openMediaLibrary = (
    cellId: string | null,
    currentNotebook: NotebookDocument | null | undefined = notebook,
    slot?: NotebookGridSlot,
  ) => {
    if (!currentNotebook || mcp.state !== 'ready') return
    const kind = cellId === null ? 'all' : emptyMediaSlotKind(cellId, currentNotebook)
    if (!kind) return
    if (cellId === null || selectedCellIdsRef.current.size !== 1 || !selectedCellIdsRef.current.has(cellId)) {
      selectCanvasCell(cellId)
    }
    setSourceViewCellId(null)
    setHistoryViewCellId(null)
    setComposerDockOpen(true)
    mediaLibraryOpenerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    mediaLibraryReference.lifecycle.close()
    if (cellId) setMediaSlotOperation(cellId, null)
    setMediaLibraryPicker({
      unindexedVisualAssets: 0,
      preparingIndex: false,
      bookId,
      notebookId: currentNotebook.id,
      cellId,
      slot,
      query: '',
      draftQuery: '',
      assets: [],
      page: emptyLibraryPage,
      booksWithErrors: [],
      loading: true,
      loadingMore: false,
      error: null,
      activeArtifactId: null,
      tagFilters: [],
      tagSuggestions: [],
    })
    void loadMediaLibrary(cellId, '', 0, false, {
      mode: 'text',
      reference: null,
      referenceStartSeconds: '0',
      referenceDurationSeconds: '',
    }, [], kind)
  }

  const dismissMediaLibrary = () => {
    closeMediaLibrary()
    setComposerDockOpen(false)
  }

  const openNotebookLibrary = (slot?: NotebookGridSlot) => {
    navigate('notebook')
    openMediaLibrary(null, notebook, slot)
  }

  const attachLibraryAsset = async (asset: LibraryAssetRecord) => {
    if (!bookId || !notebook || !mediaLibraryPicker || mcp.state !== 'ready' || busy) return
    const picker = mediaLibraryPicker
    const requestId = mediaLibraryRequestRef.current
    const isCurrent = () => mediaLibraryRequestRef.current === requestId
      && watchScopeRef.current.bookId === picker.bookId
      && watchScopeRef.current.notebookId === picker.notebookId
    let cellId = picker.cellId
    const cell = notebook.cells.find((candidate) => candidate.id === cellId)
    const kind = cellId === null ? passiveMediaKindForAsset(asset.type) : cell && passiveMediaKind(cell.type)
    if (!kind || !isCompatibleLibraryAsset(kind, asset.type)) return
    if (cellId) setMediaSlotOperation(cellId, 'attach')
    setMediaLibraryPicker((current) =>
      current === picker
        ? { ...current, activeArtifactId: asset.artifactId, error: null }
        : current)
    let createdCellId: string | null = null
    let attached = false
    setBusy(true)
    try {
      if (cellId === null) {
        const slot = picker.slot ?? nextNotebookCreationSlot(kind, notebook.cells, lastWorkSlot)
        const created = recordValue(await call('create_notebook_cell', {
          book_id: bookId,
          notebook_id: notebook.id,
          cell: { type: kind, slot },
        }))
        createdCellId = created && asString(created.id)
        if (!createdCellId) throw new Error('The server did not return the new media cell')
        cellId = createdCellId
        rememberLastWorkSlot(slot)
      }
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
          expected_output_artifact_id: cell?.outputArtifactId ?? null,
        })
      }
      attached = true
      if (!isCurrent()) return
      await refreshBookData(bookId, notebook.id)
      if (!isCurrent()) return
      setMediaSlotOperation(cellId, null)
      setNotice(asset.owningBookId === bookId
        ? `Attached @${asset.id}`
        : `Copied and attached @${asset.id} from ${asset.owningBookName}`)
      if (picker.cellId !== null || selectedCellIdsRef.current.size === 0) {
        closeMediaLibrary()
        if (createdCellId) collapseComposerAfterCellCreation()
      }
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
          message += `. The empty cell could not be removed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
        }
      }
      if (!isCurrent()) return
      if (picker.cellId) setMediaSlotError(picker.cellId, message)
      setMediaLibraryPicker((current) =>
        current && current.cellId === picker.cellId
          ? { ...current, activeArtifactId: null, error: message }
          : current)
      setNotice(message, 'error')
    } finally {
      if (!isCurrent() && picker.cellId && watchScopeRef.current.bookId === picker.bookId) {
        setMediaSlotOperation(picker.cellId, null)
      }
      setBusy(false)
    }
  }

  const elevenLabsVoices = useElevenLabsVoices({
    callTool: call,
    ready: mcp.state === 'ready',
  })

  const runSpeakGeneration = async (
    text: string,
    voiceId: string,
    chat?: ChatExecution,
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
      }, { chat }))
      if (!currentNotebook) {
        throw new Error('The server returned an invalid notebook')
      }
      const created = await materializeNotebookSpeakCommand({
        bookId,
        callTool: (tool, args) => call(tool, args, { chat }),
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
      const plan = await createGenerationPlan(created.cellId, 'slash', chat)
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
      reviewChat(chat, false, () => setPendingChatAction(null))
      reviewChat(chat, false, () => setPendingCommandPlan(null))
      const accepted = await startNotebookCellRun({
        start: () => call('run_notebook_cell', {
          book_id: bookId,
          notebook_id: plannedNotebookId,
          cell_id: created.cellId,
          plan,
          actor: 'videobook-user',
        }, { chat }),
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
      collapseComposerAfterCellCreation(chat)
      presentChat(chat, () => setNotice(`${created.cellAddress} queued`))
      void watchGenerationRun({
        bookId,
        notebookId: plannedNotebookId,
        cellId: created.cellId,
        address: created.cellAddress.replace(/^@/, ''),
        runId,
        jobOperationId,
      }, chat)
      await refreshBookData(bookId, notebook.id, undefined, chat).catch(() => undefined)
      return { ok: true, message: `${created.cellAddress} queued` }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (materialized && !runAccepted) {
        await call('delete_notebook_cell', {
          book_id: bookId,
          notebook_id: notebook.id,
          cell_id: materialized.cellId,
        }, { chat }).catch(() => undefined)
        await call('delete_notebook_cell', {
          book_id: bookId,
          notebook_id: notebook.id,
          cell_id: materialized.outputCellId,
        }, { chat }).catch(() => undefined)
        return { ok: false, message }
      }
      if (runAccepted) {
        presentChat(chat, () => setNotice(message, 'error'))
        return { ok: false, message }
      }
      return { ok: false, message }
    }
  }

  const openWatermarkReview = (
    assetId: string,
    targetLabel: string,
    initial: WatermarkReviewPatch = {},
    chat?: ChatExecution,
  ) => {
    const targetAsset = assets.find((asset) => asset.artifactId === assetId)
    const inputs = resolveWatermarkReviewInputs(
      readWatermarkReviewPreferences(bookId), initial, targetAsset?.duration ?? null,
    )
    reviewChat(chat, false, () => setPendingCommandPlan(null))
    reviewChat(chat, false, () => setPendingChatAction(null))
    reviewChat(chat, true, () => {
      saveWatermarkReviewPreferences(bookId, inputs.platform, initial)
      setPendingWatermarkReview({
        assetId,
        targetLabel,
        mediaUrl: targetAsset?.mediaUrl ?? null,
        thumbnailUrl: targetAsset?.thumbnailUrl ?? null,
        width: targetAsset?.width ?? null,
        height: targetAsset?.height ?? null,
        durationSeconds: targetAsset?.duration ?? null,
        platform: inputs.platform,
        identities: {
          x: { handle: inputs.handles?.x ?? '', recent: [] },
          tiktok: { handle: inputs.handles?.tiktok ?? '', recent: [] },
        },
        url: inputs.url ?? '',
        includeQr: inputs.includeQr ?? true,
        includeHandle: inputs.includeHandle ?? true,
        position: inputs.position ?? 'auto',
        handleVerticalPercent: inputs.handleVerticalPercent === undefined
          ? DEFAULT_HANDLE_VERTICAL_PERCENT
          : clampHandleVerticalPercent(inputs.handleVerticalPercent),
        handlePlacement: inputs.handlePlacement ?? 'center',
        includePlatformIcon: inputs.includePlatformIcon ?? true,
        includeHandleBorder: inputs.includeHandleBorder ?? true,
        handlePadding: inputs.handlePadding === undefined
          ? DEFAULT_HANDLE_PADDING
          : clampHandlePadding(inputs.handlePadding),
        handlePaddingY: inputs.handlePaddingY === undefined
          ? DEFAULT_HANDLE_PADDING
          : clampHandlePadding(inputs.handlePaddingY),
        handleRounding: inputs.handleRounding === undefined
          ? DEFAULT_HANDLE_ROUNDING
          : clampHandleRounding(inputs.handleRounding),
        qrOpacity: inputs.qrOpacity === undefined
          ? DEFAULT_WATERMARK_OPACITY
          : clampWatermarkOpacity(inputs.qrOpacity),
        handleOpacity: inputs.handleOpacity === undefined
          ? DEFAULT_WATERMARK_OPACITY
          : clampWatermarkOpacity(inputs.handleOpacity),
        qrStartSeconds: inputs.qrStartSeconds ?? 0,
        qrEndSeconds: inputs.qrEndSeconds ?? null,
        handleStartSeconds: inputs.handleStartSeconds ?? 0,
        handleEndSeconds: inputs.handleEndSeconds ?? null,
        fadeSeconds: inputs.fadeSeconds === undefined
          ? DEFAULT_WATERMARK_FADE_SECONDS
          : clampWatermarkFadeSeconds(inputs.fadeSeconds),
        saveDefault: inputs.saveDefault ?? false,
        loadingConfig: true,
        error: null,
      })
    })
    void Promise.allSettled(WATERMARK_PLATFORMS.map(async (platform) => {
      const config = recordValue(await call('get_watermark_config', {
        book_id: bookId,
        platform,
      }, { background: true, chat }))
      const savedHandle = asString(config?.savedHandle)
      const authenticatedHandle = asString(config?.authenticatedHandle)
      const recent = Array.isArray(config?.recent)
        ? config.recent.filter((entry): entry is string => typeof entry === 'string')
        : []
      const profile = recordValue(config?.profile)
      const profileHandle = asString(profile?.handle)
      const profileUrl = asString(profile?.profileUrl)
      const rememberedHandle = readWatermarkReviewPreferences(bookId).handles?.[platform]
      presentChat(chat, () => setPendingWatermarkReview((current) =>
        current && current.assetId === assetId
          ? {
              ...current,
              url: current.url || (platform === current.platform ? profileUrl ?? '' : current.url),
              identities: {
                ...current.identities,
                [platform]: {
                  handle: rememberedHandle ?? (current.identities[platform].handle
                    || (savedHandle ?? authenticatedHandle ?? recent[0] ?? profileHandle ?? '')),
                  recent,
                },
              },
            }
          : current))
    })).then(() => {
      presentChat(chat, () => setPendingWatermarkReview((current) =>
        current && current.assetId === assetId
          ? { ...current, loadingConfig: false }
          : current))
    })
  }

  const submitWatermark = async (chat?: ChatExecution): Promise<ComposerOutcome> => {
    if (!bookId || !pendingWatermarkReview) {
      return { ok: false, message: 'There is no pending watermark to apply.' }
    }
    const {
      assetId,
      targetLabel,
      platform,
      identities,
      url,
      includeQr,
      includeHandle,
      position,
      handleVerticalPercent,
      handlePlacement,
      includePlatformIcon,
      includeHandleBorder,
      handlePadding,
      handlePaddingY,
      handleRounding,
      qrOpacity,
      handleOpacity,
      qrStartSeconds,
      qrEndSeconds,
      handleStartSeconds,
      handleEndSeconds,
      fadeSeconds,
      saveDefault,
    } = pendingWatermarkReview
    const trimmedHandle = identities[platform].handle.trim().replace(/^@/, '').trim()
    const trimmedUrl = url.trim()
    if (!includeQr && !includeHandle) {
      return {
        ok: false,
        message: 'Include a QR code, a handle, or both before applying the watermark.',
        nextInput: '/apply',
        selectInput: false,
      }
    }
    if (includeHandle && !trimmedHandle) {
      return {
        ok: false,
        message: 'Enter a handle before applying the watermark.',
        nextInput: '/apply',
        selectInput: false,
      }
    }
    if (includeQr && !trimmedUrl && !trimmedHandle) {
      return {
        ok: false,
        message: 'Enter a QR link before applying the watermark.',
        nextInput: '/apply',
        selectInput: false,
      }
    }
    presentChat(chat, () => setPendingWatermarkReview((current) =>
      current && current.assetId === assetId
        ? { ...current, error: null }
        : current))
    setBusy(true)
    try {
      const result = recordValue(await call('apply_watermark', {
        book_id: bookId,
        asset_id: assetId,
        platform,
        ...(trimmedHandle && (includeHandle || !trimmedUrl) ? { handle: trimmedHandle } : {}),
        include_qr: includeQr,
        include_handle: includeHandle,
        position,
        ...(includeHandle ? { handle_vertical_percent: handleVerticalPercent } : {}),
        ...(includeHandle && includeQr && handlePlacement !== 'center'
          ? { handle_position: handlePlacement }
          : {}),
        ...(includeHandle ? { include_platform_icon: includePlatformIcon } : {}),
        ...(includeHandle ? { include_handle_border: includeHandleBorder } : {}),
        ...(includeHandle ? { handle_padding: handlePadding } : {}),
        ...(includeHandle ? { handle_padding_y: handlePaddingY } : {}),
        ...(includeHandle ? { handle_rounding: handleRounding } : {}),
        ...(includeHandle ? { handle_opacity: handleOpacity } : {}),
        ...(includeQr && trimmedUrl ? { url: trimmedUrl } : {}),
        ...(includeQr ? { qr_opacity: qrOpacity } : {}),
        ...(includeQr && qrStartSeconds > 0
          ? { qr_start_seconds: qrStartSeconds }
          : {}),
        ...(includeQr && qrEndSeconds !== null
          ? { qr_end_seconds: qrEndSeconds }
          : {}),
        ...(includeHandle && handleStartSeconds > 0
          ? { handle_start_seconds: handleStartSeconds }
          : {}),
        ...(includeHandle && handleEndSeconds !== null
          ? { handle_end_seconds: handleEndSeconds }
          : {}),
        fade_seconds: fadeSeconds,
        ...(includeHandle && saveDefault ? { save_default: true } : {}),
        wait: false,
      }, { chat }))
      const applied = {
        includeQr,
        includeHandle,
        handle: trimmedHandle,
        handlePlacement,
        handleVerticalPercent,
        handleOpacity,
        qrOpacity,
        requestedPosition: position,
      }
      const jobId = asNumber(result?.job_id)
      if (asString(result?.status) === 'accepted' && jobId !== null) {
        // The burn runs in the queue: hand the composer back now and watch
        // the asset until the reprocess settles.
        const message = watermarkQueuedMessage(
          includeQr,
          includeHandle,
          trimmedHandle,
          targetLabel,
        )
        presentChat(chat, () => setNotice(message))
        reviewChat(chat, false, () => setPendingWatermarkReview(null))
        void watchWatermarkBurn({
          bookId,
          artifactId: assetId,
          jobId,
          targetLabel,
          describe: (burn) => watermarkAppliedMessage({
            ...applied,
            corner: asString(burn?.corner),
            placementSource: asString(burn?.placementSource),
          }),
        }, chat)
        return { ok: true, message }
      }
      await refreshBookData(bookId, notebook?.id, undefined, chat)
      const message = watermarkAppliedMessage({
        ...applied,
        corner: asString(result?.position),
        placementSource: asString(result?.placement_source),
      })
      presentChat(chat, () => setNotice(message))
      reviewChat(chat, false, () => setPendingWatermarkReview(null))
      return { ok: true, message }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      presentChat(chat, () => setPendingWatermarkReview((current) =>
        current && current.assetId === assetId
          ? { ...current, error: message }
          : current))
      presentChat(chat, () => setNotice(message, 'error'))
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
      const refreshed = await refreshBookData(bookId, notebook?.id)
      if (notebookActionCreatedCells(notebook, refreshed)) collapseComposerAfterCellCreation()
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

  const upload = (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])]
    event.target.value = ''
    void uploadFiles(files)
  }

  // A queued watermark burn (apply_watermark wait=false) is tracked here
  // rather than by holding the composer: the burn job anchors the watch and
  // the asset must settle back to ready after the reprocess it enqueues.
  const watchWatermarkBurn = useCallback(async (params: {
    bookId: string
    artifactId: string
    jobId: number
    targetLabel: string
    describe: (burn: Record<string, unknown> | null) => string
  }, chat?: ChatExecution) => {
    const deadline = Date.now() + mediaAssetWatchTimeoutMs
    let consecutiveFailures = 0
    let missingPolls = 0
    const finish = async (message: string, tone: WorkspaceNoticeTone = 'info') => {
      try {
        await refreshBookData(
          params.bookId,
          watchScopeRef.current.notebookId ?? undefined, undefined, chat,
        )
      } catch {
        void 0
      }
      presentChat(chat, () => setNotice(message, tone))
    }
    while (Date.now() < deadline) {
      const scope = watchScopeRef.current
      if (scope.bookId !== params.bookId) return
      try {
        const fetchedAt = performance.now()
        const notebookId = scope.notebookId
        const [assetValue, jobValue, notebookValue] = await Promise.all([
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
          notebookId
            ? callRef.current('get_notebook', {
                book_id: params.bookId,
                notebook_id: notebookId,
              }, { background: true })
            : Promise.resolve(null),
        ])
        consecutiveFailures = 0
        const afterScope = watchScopeRef.current
        if (afterScope.bookId !== params.bookId) return
        const nextAssets = asAssets(assetValue)
        const nextJobs = asJobs(jobValue)
        const nextNotebook = notebookId && afterScope.notebookId === notebookId
          ? asNotebook(notebookValue)
          : null
        if (fetchedAt >= watchSnapshotClockRef.current) {
          watchSnapshotClockRef.current = fetchedAt
          setAssets((current) =>
            jsonEqual(current, nextAssets) ? current : nextAssets)
          applyJobsSnapshot(nextJobs)
          // The cell's working badge comes from the canvas nodes, which only
          // applyNotebook rebuilds.
          if (nextNotebook) applyNotebook(nextNotebook, nextAssets, nextJobs)
        }
        const step = watermarkBurnWatchStep(
          params.artifactId,
          params.jobId,
          nextAssets.find((asset) => asset.artifactId === params.artifactId),
          nextJobs,
        )
        if (step.kind === 'completed') {
          await finish(params.describe(step.result))
          return
        }
        if (step.kind === 'failed') {
          await finish(step.message, 'error')
          return
        }
        missingPolls = step.kind === 'missing' ? missingPolls + 1 : 0
        if (missingPolls >= watermarkBurnMissingPollLimit) {
          presentChat(chat, () => setNotice(
            `Lost track of the ${params.targetLabel} watermark job — check the Jobs screen`,
            'error',
          ))
          return
        }
      } catch (error) {
        consecutiveFailures += 1
        if (consecutiveFailures >= 10) {
          const detail = error instanceof Error ? error.message : String(error)
          presentChat(chat, () => setNotice(
            `Stopped watching the ${params.targetLabel} watermark: ${detail}. Check the Jobs screen.`,
            'error',
          ))
          return
        }
      }
      await delay(mediaProcessWatchIntervalMs)
    }
    presentChat(chat, () => setNotice(`${params.targetLabel} watermark is still processing — check the Jobs screen`))
  }, [applyJobsSnapshot, applyNotebook, refreshBookData, setNotice])

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

  const refreshXConnection = async (
    options: { refreshAccount?: boolean } = {},
  ): Promise<XConnectionStatus | null> => {
    try {
      const status = await fetchXConnectionStatus(call, options)
      setXConnection((current) => ({ ...current, status, error: null }))
      syncPendingXPostLimit(xPostMaxCharacters(status))
      return status
    } catch (error) {
      setXConnection((current) => ({
        ...current,
        error: error instanceof Error ? error.message : String(error),
      }))
      return null
    }
  }

  const connectX = async (): Promise<{ ok: boolean; message: string }> => {
    if (xConnection.connecting) {
      return { ok: false, message: 'X authorization is already waiting for approval.' }
    }
    setXConnection((current) => ({
      ...current,
      connecting: true,
      authorizeUrl: null,
      error: null,
    }))
    try {
      const authorizeUrl = await startXConnection(call)
      setXConnection((current) => ({ ...current, authorizeUrl }))
      window.open(authorizeUrl, '_blank', 'noopener,noreferrer')
      const status = await waitForXConnection(call, { sleep: delay })
      const outcome = xConnectionOutcome(status)
      setXConnection({
        status,
        connecting: false,
        authorizeUrl: null,
        error: outcome.ok || status.error ? null : outcome.message,
      })
      syncPendingXPostLimit(xPostMaxCharacters(status))
      setNotice(outcome.message, outcome.ok ? 'info' : 'error')
      return outcome
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setXConnection((current) => ({
        ...current,
        connecting: false,
        authorizeUrl: null,
        error: message,
      }))
      setNotice(message, 'error')
      return { ok: false, message }
    }
  }

  const refreshSettings = async () => {
    if (mcp.state !== 'ready') return
    const request = ++settingsRequestRef.current
    const targetBookId = bookId
    setSettingsLoading(true)
    setSettingsError(null)
    setNoticeState(null)
    setSettingsRefreshed(false)
    setStorage(targetBookId ? { bookId: targetBookId, status: 'loading' } : null)
    const [providerResult, storageResult, xResult] = await Promise.allSettled([
      call('provider_key_status', {}),
      targetBookId ? call('storage_status', { book_id: targetBookId }) : Promise.resolve(null),
      refreshXConnection({ refreshAccount: true }),
    ])
    if (request !== settingsRequestRef.current) return
    let refreshed = true
    try {
      if (providerResult.status === 'rejected') throw providerResult.reason
      setProviders(parseSettingsProviders(providerResult.value))
    } catch (error) {
      refreshed = false
      setSettingsError(error instanceof Error ? error.message : String(error))
    }
    if (targetBookId) {
      try {
        if (storageResult.status === 'rejected') throw storageResult.reason
        setStorage({ bookId: targetBookId, status: 'ready', value: parseSettingsStorage(storageResult.value) })
      } catch (error) {
        refreshed = false
        setStorage({ bookId: targetBookId, status: 'error', error: error instanceof Error ? error.message : String(error) })
      }
    }
    setSettingsRefreshed(refreshed && xResult.status === 'fulfilled' && xResult.value !== null)
    setSettingsLoading(false)
  }

  const loadSettingsOnOpen = useEffectEvent(() => {
    if (!settingsLoading) void refreshSettings()
  })
  const settingsReady = screen === 'settings' && mcp.state === 'ready'
  useEffect(() => {
    if (settingsReady) loadSettingsOnOpen()
  }, [settingsReady])

  const storeSecret = async (key: string, value: string) => {
    if (mcp.state !== 'ready') throw new Error('Connect to save settings')
    if (!value.trim()) throw new Error('Enter a value to save')
    setBusy(true)
    try {
      await call('set_env_secret', { key, value })
      await refreshSettings()
    } finally {
      setBusy(false)
    }
  }

  const previewCommandPlan = async (
    plan: CommandPlan,
    chat?: ChatExecution,
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
        }, { chat }) as EditPreview,
      ] as const))
      const previews = Object.fromEntries(previewEntries)
      reviewChat(chat, false, () => setPendingChatAction(null))
      reviewChat(chat, true, () => setPendingCommandPlan({ plan, previews }))
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
    chat?: ChatExecution,
  ): Promise<ComposerOutcome> => {
    if (!bookId) return { ok: false, message: 'Load or create a book first.' }
    try {
      const plan = asCommandPlan(await call('plan_sequence_edit', {
        book_id: bookId,
        source_surface: sourceSurface,
        actor: 'videobook-user',
        edits: Array.isArray(request) ? request : [request],
      }, { chat }))
      return await previewCommandPlan(plan, chat)
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  const applyPendingCommandPlan = async (chat?: ChatExecution): Promise<ComposerOutcome> => {
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
        }, { chat }))
        reviewChat(chat, false, () => setPendingCommandPlan(null))
        const refreshed = await refreshBookData(bookId, notebookId, undefined, chat).catch(() => undefined)
        if (notebookActionCreatedCells(notebook, refreshed)) collapseComposerAfterCellCreation(chat)
        const message = asString(queued?.status) === 'completed'
          ? 'Workbook is already current'
          : 'Workbook run accepted and queued'
        presentChat(chat, () => setNotice(message))
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
          }, { chat }))
          latestActionId = asString(committed?.actionId) ?? latestActionId
          continue
        }
        if (
          stage.kind === 'queued'
          && stage.jobType === 'export'
          && stage.tool === 'export_sequence'
        ) {
          const currentSequence = asSequence(await call('get_primary_sequence', { book_id: bookId }, { chat }))
          if (!currentSequence) throw new Error('The sequence is no longer available.')
          const reviewedContent = stage.input.sequence_content_revision
          if (typeof reviewedContent === 'string' && await sequenceContentRevision(currentSequence) !== reviewedContent) {
            throw new Error('The sequence changed after review. Review the current cut before exporting.')
          }
          const queued = recordValue(await call('enqueue_sequence_export', {
            book_id: bookId,
            confirm: true,
            sequence_revision: typeof reviewedContent === 'string' ? currentSequence.revision : stage.input.sequence_revision,
            orientation: stage.input.orientation,
            captions: stage.input.captions,
          }, { chat }))
          if (queued?.kind === 'invalid-export') {
            const validation = recordValue(queued.validation)
            const errors = Array.isArray(validation?.errors) ? validation.errors.map((entry) => asString(recordValue(entry)?.message)).filter(Boolean) : []
            throw new Error(errors.join(' · ') || 'Export validation failed. Review the current sequence again.')
          }
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
            }, { chat }),
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
          if (outputCellId) collapseComposerAfterCellCreation(chat)
          const watchCellId = outputCellId ?? cellId
          const watchedCell = notebook?.cells.find((cell) => cell.id === cellId)
          let address = watchedCell
            ? notebookGridAddress(watchedCell.slot)
            : cellId.slice(0, 8)
          if (outputCellId) {
            const notebookValue = await call('get_notebook', {
              book_id: bookId,
              notebook_id: notebookId,
            }, { background: true, chat })
            const nextNotebook = asNotebook(notebookValue)
            if (nextNotebook) {
              applyNotebook(nextNotebook, assets, jobs)
              const output = nextNotebook.cells.find((candidate) =>
                candidate.id === outputCellId)
              if (output) address = notebookGridAddress(output.slot)
            }
            presentChat(chat, () => revealCells([outputCellId]))
            setCellRunError(outputCellId, null)
            setCellQueued(outputCellId, true)
          }
          void watchGenerationRun({
            bookId,
            notebookId,
            cellId: watchCellId,
            address,
            runId,
            jobOperationId,
          }, chat)
          queuedCount += 1
          continue
        }
        if (stage.kind === 'queued') {
          throw new Error(`Queued ${stage.jobType} execution is not available from this plan yet`)
        }
      }
      reviewChat(chat, false, () => setPendingCommandPlan(null))
      setLastEditActionId(latestActionId)
      await refreshBookData(bookId, notebook?.id, undefined, chat).catch(() => undefined)
      const message = queuedCount > 0
        ? `CommandPlan accepted · ${queuedCount} queued job`
        : 'CommandPlan committed to a new sequence revision'
      presentChat(chat, () => setNotice(message))
      return { ok: true, message }
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error)
      presentChat(chat, () => setNotice(message, 'error'))
      const hasGeneration = pending.plan.stages.some((stage) =>
        stage.kind === 'queued' && stage.jobType === 'generation')
      const hasExport = pending.plan.stages.some((stage) => stage.kind === 'export')
      if (!hasGeneration && !hasExport) {
        try {
          const refreshed = await prepareSequenceEdit(
            requestFromEditStage(pending.plan.stages),
            pending.plan.sourceSurface === 'system'
              ? 'ui'
              : pending.plan.sourceSurface, chat,
          )
          if (!refreshed.ok) {
            message = refreshed.message
            presentChat(chat, () => setNotice(message, 'error'))
          }
        } catch {
          reviewChat(chat, false, () => setPendingCommandPlan(null))
          message = 'The sequence changed. Recreate this plan against the current cut.'
          presentChat(chat, () => setNotice(message, 'error'))
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
      presentChat(chat, () => focusCommandComposer())
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
    chat?: ChatExecution,
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
      }, { chat })
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
      return await previewCommandPlan(asCommandPlan(value), chat)
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  const prepareSoundEffects = async (
    sourceSurface: 'ui' | 'slash' | 'chat',
    chat?: ChatExecution,
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
      }, { chat })
      const result = recordValue(value)
      if (result?.kind === 'sound-effects-uncovered') {
        return {
          ok: false,
          message: 'No existing indexed sound effects cover these beats. Generation is available as a fallback.',
        }
      }
      return await previewCommandPlan(asCommandPlan(value), chat)
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
    chat?: ChatExecution,
  ): Promise<ComposerOutcome> => {
    if (!bookId) return { ok: false, message: 'Load or create a book first.' }
    try {
      const nextSequence = asSequence(await call('add_sequence_track', {
        book_id: bookId,
        kind,
        ...(name?.trim() ? { name: name.trim() } : {}),
      }, { chat }))
      if (!nextSequence) throw new Error('The server returned an invalid sequence')
      setSequence(nextSequence)
      return { ok: true, message: `Added ${kind} track` }
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  const removeSequenceTrack = async (trackId: string, chat?: ChatExecution): Promise<ComposerOutcome> => {
    if (!bookId) return { ok: false, message: 'Load or create a book first.' }
    try {
      const nextSequence = asSequence(await call('remove_sequence_track', {
        book_id: bookId,
        track_id: trackId,
      }, { chat }))
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

  const prepareMusicVideoSetup = async (
    sessionKey: string,
    audioArtifactId: string,
    targetSequence: Sequence,
    chat?: ChatExecution,
  ): Promise<void> => {
    if (!bookId) {
      setMusicVideoSession((current) => current?.key === sessionKey
        ? {
            ...current,
            setup: {
              status: 'error',
              message: 'Load or create a book first.',
            },
          }
        : current)
      return
    }
    setMusicVideoSession((current) => current?.key === sessionKey
      ? { ...current, setup: { status: 'loading' } }
      : current)
    const audioTrack = musicVideoSoundtrackTrack(targetSequence, audioArtifactId)
    if (!audioTrack) {
      setMusicVideoSession((current) => current?.key === sessionKey
        ? {
            ...current,
            setup: {
              status: 'needs-audio-track',
              message: 'Create an empty, enabled soundtrack track before reviewing setup.',
            },
          }
        : current)
      return
    }
    try {
      const plan = asCommandPlan(await call('plan_sequence_edit', {
        book_id: bookId,
        source_surface: 'ui',
        actor: 'videobook-user',
        expected_revision: await sequenceContentRevision(targetSequence),
        edits: [{
          kind: 'music_video_setup',
          audio_artifact_id: audioArtifactId,
          audio_track_id: audioTrack.trackId,
        }],
      }, { chat }))
      const stage = plan.stages.find(
        (candidate): candidate is EditCommandStage => candidate.kind === 'edit',
      )
      if (!stage) throw new Error('The soundtrack setup plan has no edit stage')
      const preview = await call('preview_edit_intent', {
        book_id: bookId,
        intent: stage.intent,
      }, { chat }) as EditPreview
      const invalid = editPreviewError(preview)
      if (invalid) throw new Error(invalid)
      const timelineLimitFrame = musicVideoTimelineLimit(
        plan,
        targetSequence,
        audioArtifactId,
      )
      if (musicVideoSoundtrackApplied(
        targetSequence,
        audioArtifactId,
        timelineLimitFrame,
      )) {
        setMusicVideoSession((current) => current?.key === sessionKey
          ? {
              ...current,
              setup: {
                status: 'applied',
                audioTrackId: audioTrack.trackId,
                timelineLimitFrame,
              },
            }
          : current)
        return
      }
      const prepared: MusicVideoPreparedSetup = {
        status: 'ready',
        audioTrackId: audioTrack.trackId,
        timelineLimitFrame,
        operationCount: stage.intent.operations.length,
        summary: musicVideoSetupSummary(plan),
        warnings: preview.warnings.map((warning) => warning.message),
        plan,
        preview,
      }
      setMusicVideoSession((current) => current?.key === sessionKey
        ? { ...current, setup: prepared }
        : current)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setMusicVideoSession((current) => current?.key === sessionKey
        ? { ...current, setup: { status: 'error', message } }
        : current)
    }
  }

  const applyMusicVideoSetup = async (): Promise<MusicVideoCommitResult> => {
    if (!bookId || !musicVideoSession || musicVideoSession.setup.status !== 'ready') {
      throw new Error('Review the soundtrack setup before applying it')
    }
    const sessionKey = musicVideoSession.key
    const prepared = musicVideoSession.setup
    const stage = prepared.plan.stages.find(
      (candidate): candidate is EditCommandStage => candidate.kind === 'edit',
    )
    if (!stage) throw new Error('The soundtrack setup plan has no edit stage')
    setMusicVideoSession((current) => current?.key === sessionKey
      ? {
          ...current,
          setup: {
            status: 'applying',
            audioTrackId: prepared.audioTrackId,
            timelineLimitFrame: prepared.timelineLimitFrame,
            operationCount: prepared.operationCount,
            summary: prepared.summary,
            warnings: prepared.warnings,
          },
        }
      : current)
    try {
      const committed = recordValue(await call('commit_edit_intent', {
        book_id: bookId,
        intent: stage.intent,
        preview_hash: prepared.preview.previewHash,
      }))
      const nextSequence = asSequence(committed?.sequence)
      const actionId = asString(committed?.actionId)
      if (!nextSequence || !actionId) {
        throw new Error('The server returned an invalid soundtrack commit')
      }
      setSequence(nextSequence)
      setLastEditActionId(actionId)
      const master = nextSequence.clips.find((clip) => clip.trackId === prepared.audioTrackId && clip.source.artifactId === musicVideoSession.audioArtifactId)
      if (master) await musicRhythm.save({ masterClipId: master.clipId, correction: null }, nextSequence)
      setMusicVideoSession((current) => current?.key === sessionKey
        ? {
            ...current,
            setup: {
              status: 'applied',
              audioTrackId: prepared.audioTrackId,
              timelineLimitFrame: prepared.timelineLimitFrame,
            },
          }
        : current)
      return {
        sequence: nextSequence,
        actionId,
        beforeRevision: stage.intent.baseRevision,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setMusicVideoSession((current) => current?.key === sessionKey
        ? { ...current, setup: { status: 'error', message } }
        : current)
      throw error
    }
  }

  const commitMusicVideoEdit = async (
    request: Record<string, unknown>,
    expectedSequence: Sequence,
  ): Promise<MusicVideoCommitResult> => {
    if (!bookId) throw new Error('Load or create a book first.')
    const plan = asCommandPlan(await call('plan_sequence_edit', {
      book_id: bookId,
      source_surface: 'ui',
      actor: 'videobook-user',
      expected_revision: await sequenceContentRevision(expectedSequence),
      edits: [request],
    }))
    const stage = plan.stages.find(
      (candidate): candidate is EditCommandStage => candidate.kind === 'edit',
    )
    if (!stage) throw new Error('The music-video plan has no edit stage')
    const preview = await call('preview_edit_intent', {
      book_id: bookId,
      intent: stage.intent,
    }) as EditPreview
    const invalid = editPreviewError(preview)
    if (invalid) throw new Error(invalid)
    const committed = recordValue(await call('commit_edit_intent', {
      book_id: bookId,
      intent: stage.intent,
      preview_hash: preview.previewHash,
    }))
    const nextSequence = asSequence(committed?.sequence)
    const actionId = asString(committed?.actionId)
    if (!nextSequence || !actionId) {
      throw new Error('The server returned an invalid music-video edit commit')
    }
    watchSnapshotClockRef.current = performance.now()
    setSequence(nextSequence)
    setLastEditActionId(actionId)
    return {
      sequence: nextSequence,
      actionId,
      beforeRevision: stage.intent.baseRevision,
    }
  }

  const planMusicDraft = async (options: MusicDraftOptions, expectedSequence: Sequence): Promise<MusicVideoDraft> => {
    return await call('plan_music_video', {
      book_id: bookId, expected_revision: await sequenceContentRevision(expectedSequence),
      rhythm_revision: musicRhythm.rhythm.revision, options, source_surface: 'ui', actor: 'videobook-user',
    }) as MusicVideoDraft
  }

  const applyMusicDraft = async (draft: MusicVideoDraft): Promise<MusicVideoCommitResult> => {
    const intent = draft.plan.stages[0]?.intent
    if (!intent || draft.uncovered.length) throw new Error('Review a complete draft before applying it')
    const result = recordValue(await call('commit_music_video', { book_id: bookId, intent, preview_hash: draft.preview.previewHash, rhythm_revision: draft.rhythmRevision, sequence_content_revision: draft.sequenceContentRevision }))
    const next = asSequence(result?.sequence)
    const actionId = asString(result?.actionId)
    if (!next || !actionId) throw new Error('The server returned an invalid draft commit')
    watchSnapshotClockRef.current = performance.now()
    setSequence(next)
    setLastEditActionId(actionId)
    return { sequence: next, actionId, beforeRevision: intent.baseRevision }
  }

  const restoreMusicVideoRevision = async (
    targetRevision: string,
    expectedRevision: string,
  ): Promise<MusicVideoCommitResult> => {
    if (!bookId) throw new Error('Load or create a book first.')
    const restored = recordValue(await call('restore_edit_action', {
      book_id: bookId,
      target_revision: targetRevision,
      base_revision: expectedRevision,
      actor: 'videobook-user',
      source_surface: 'ui',
    }))
    const nextSequence = asSequence(restored?.sequence)
    const actionId = asString(restored?.actionId)
    if (!nextSequence || !actionId) {
      throw new Error('The server returned an invalid sequence restore')
    }
    watchSnapshotClockRef.current = performance.now()
    setSequence(nextSequence)
    setLastEditActionId(actionId)
    return {
      sequence: nextSequence,
      actionId,
      beforeRevision: expectedRevision,
    }
  }

  const createMusicVideoTrack = async (
    kind: 'video' | 'audio',
  ): Promise<Sequence> => {
    if (!bookId) throw new Error('Load or create a book first.')
    const nextSequence = asSequence(await call('add_sequence_track', {
      book_id: bookId,
      kind,
      name: kind === 'audio' ? 'Master Soundtrack' : 'Music Video',
    }))
    if (!nextSequence) throw new Error('The server returned an invalid sequence')
    watchSnapshotClockRef.current = performance.now()
    setSequence(nextSequence)
    return nextSequence
  }

  const closeMusicVideoEditor = useCallback(() => {
    const restoreFocus = capturePointerComposerFocus()
    setMusicVideoSession(null)
    restoreFocus()
  }, [])

  const openSubtitles = (artifactId: string, chat?: ChatExecution): ComposerOutcome => {
    const holder = notebook?.cells.find((cell) => cell.outputArtifactId === artifactId)
    const sourceId = holder?.inputs?.sourceOperation === 'caption_video' && typeof holder.inputs.sourceArtifactId === 'string'
      ? holder.inputs.sourceArtifactId
      : artifactId
    const asset = assets.find((entry) => entry.artifactId === sourceId)
    if (!asset || (asset.type !== 'video' && asset.type !== 'final')) return { ok: false, message: 'Subtitles need a video. Choose a video cell.' }
    if (asset.status !== 'ready' || !asset.mediaUrl) return { ok: false, message: 'Wait for the video to finish processing before adding subtitles.' }
    presentChat(chat, () => setMediaFullscreen(null))
    setTimelinePreview(null)
    setMusicVideoSession(null)
    reviewChat(chat, false, () => setPendingCommandPlan(null))
    reviewChat(chat, false, () => setPendingWatermarkReview(null))
    reviewChat(chat, true, () => setPendingChatAction({ kind: 'subtitles', assetId: sourceId }))
    setComposerDockOpen(true)
    subtitles.open({
      artifactId: sourceId,
      label: asset.label,
      mediaUrl: asset.mediaUrl,
      address: commandMentionAssets.find((mention) => mention.artifactId === sourceId)?.cellAddress ?? null,
      notebookId: notebook?.id ?? null,
    })
    return { ok: true, message: `Subtitles opened for ${asset.label}` }
  }

  const completeVideoDownload = async (
    result: unknown,
    sourceUrl: string,
    isCurrent?: () => boolean,
    chat?: ChatExecution,
    slot?: NotebookGridSlot,
  ): Promise<ComposerOutcome> => {
    if (!notebook) {
      await refreshBookData(bookId, undefined, isCurrent, chat)
      return { ok: true, message: messageFor(result, 'Download queued') }
    }
    const cell = downloadVideoCellInput(
      result,
      sourceUrl,
      slot ?? nextNotebookCreationSlot('video', notebook.cells, lastWorkSlot),
    )
    let createdCellId: string
    try {
      const created = recordValue(await call('create_notebook_cell', {
        book_id: bookId,
        notebook_id: notebook.id,
        cell,
      }, { chat }))
      const nextCellId = asString(created?.id)
      if (!nextCellId) {
        throw new Error('The server did not return the new notebook cell')
      }
      createdCellId = nextCellId
      if (isCurrent?.() === false) return { ok: true, message: 'Download queued in the previous workspace.' }
      selectCanvasCell(nextCellId, chat)
      collapseComposerAfterCellCreation(chat)
    } catch (error) {
      await refreshBookData(bookId, notebook.id, isCurrent, chat)
      const message = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        message: `Download queued in Library, but board placement failed: ${message}`,
      }
    }
    await refreshBookData(bookId, notebook.id, isCurrent, chat)
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

  const downloadClipToSlot = async (url: string, slot: NotebookGridSlot) => {
    if (!bookId || !notebook) return
    try {
      const result = await call('download_video', { book_id: bookId, url })
      const outcome = await completeVideoDownload(result, url, undefined, undefined, slot)
      setNotice(outcome.message, outcome.ok ? 'info' : 'error')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  const watchNotebookSplitRun = async (input: {
    actionAddress: string
    bookId: string
    notebookId: string
    outputAddresses: string[]
    run: NotebookSplitRun
    sourceAddress: string
  }, chat?: ChatExecution) => {
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
      presentChat(chat, () => setNotice(outcome.message ?? `${input.actionAddress} failed`, 'error'))
      return
    }
    if (outcome.kind === 'timeout') {
      presentChat(chat, () => setNotice(
        `${input.sourceAddress} is still splitting — check the Jobs screen`,
      ))
      return
    }
    if (outcome.kind === 'superseded') return
    selectCanvasCell(input.run.outputs.at(-1)?.outputCellId ?? null, chat)
    presentChat(chat, () => setNotice(
      `Split ${input.sourceAddress} into ${input.outputAddresses.join(' and ')}`,
    ))
  }

  const executeNotebookSplitCommand = async (
    command: NotebookSplitCommand,
    currentNotebook: NotebookSnapshot,
    chat?: ChatExecution,
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
      }, { chat })
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
      presentChat(chat, () => revealCells(draft.createdCellIds))
      setCellRunError(actionCellId, null)
      setCellQueued(actionCellId, true)
      selectCanvasCell(draft.outputs[0].outputCell.id, chat)
      presentChat(chat, () => setNotice(`Splitting ${sourceAddress} into ${draft.outputs.length} chunks`))
      const run = await enqueueNotebookSplitCommand({
        actor: 'videobook-user',
        bookId,
        callTool: (tool, args) => call(tool, args, { chat }),
        draft,
        ...(currentNotebook.revision
          ? { expectedRevision: currentNotebook.revision }
          : {}),
      })
      collapseComposerAfterCellCreation(chat)
      await refreshBookData(bookId, currentNotebook.id, undefined, chat).catch(() => undefined)
      void watchNotebookSplitRun({
        actionAddress,
        bookId,
        notebookId: currentNotebook.id,
        outputAddresses,
        run,
        sourceAddress,
      }, chat)
      return {
        ok: true,
        message: `Splitting ${sourceAddress} into ${outputAddresses.join(', ')}`,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (actionCellId) setCellQueued(actionCellId, false)
      await refreshBookData(bookId, notebook.id, undefined, chat).catch(() => undefined)
      presentChat(chat, () => setNotice(message, 'error'))
      return { ok: false, message }
    } finally {
      setBusy(false)
    }
  }

  const executeNotebookFrameCommand = async (
    command: NotebookFrameCommand,
    currentNotebook: NotebookSnapshot,
    isCurrent?: () => boolean,
    chat?: ChatExecution,
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
        callTool: (tool, args) => call(tool, args, { chat }),
        command,
        document: currentNotebook,
        ...(currentNotebook.revision
          ? { expectedRevision: currentNotebook.revision }
          : {}),
      })
      actionCellId = run.actionCellId
      if (isCurrent?.() === false) return { ok: true, message: 'Frame extraction queued in the previous workspace.' }
      collapseComposerAfterCellCreation(chat)
      setCellRunError(actionCellId, null)
      setCellQueued(actionCellId, true)
      selectCanvasCell(run.outputCellId ?? actionCellId, chat)
      presentChat(chat, () => setNotice(`Frame extraction queued for ${sourceAddress}`))
      const outcome = await watchNotebookRun({
        bookId,
        notebookId: currentNotebook.id,
        cellId: actionCellId,
        address: notebookGridAddress(source.slot),
        runId: run.runId,
        jobOperationId: run.jobId,
        intervalMs: notebookRunPollIntervalMs,
        timeoutMs: notebookRunPollTimeoutMs,
        maxPollFailures: notebookRunMaxPollFailures,
      })
      if (isCurrent?.() === false) return { ok: true, message: 'Check the previous workspace for the accepted frame extraction.' }
      if (outcome.kind === 'failed') {
        throw new Error(outcome.message ?? `Frame extraction for ${sourceAddress} failed`)
      }
      if (outcome.kind === 'timeout') {
        throw new Error('Frame extraction did not finish within five minutes')
      }
      if (outcome.kind === 'superseded') {
        throw new Error(`Frame extraction for ${sourceAddress} was superseded by a newer run`)
      }
      selectCanvasCell(run.outputCellId ?? actionCellId, chat)
      const successMessage = command.frameMode === 'time'
        ? `Extracted the frame at ${command.timestampSeconds ?? 0}s of ${sourceAddress}`
        : `Extracted the ${command.frameMode} frame of ${sourceAddress}`
      return {
        ok: true,
        message: successMessage,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (isCurrent?.() !== false) {
        if (actionCellId) setCellRunError(actionCellId, message)
        presentChat(chat, () => setNotice(message, 'error'))
      }
      return { ok: false, message }
    } finally {
      if (actionCellId && isCurrent?.() !== false) setCellQueued(actionCellId, false)
      setBusy(false)
    }
  }

  const executeNotebookAudioCommand = async (
    command: NotebookAudioCommand,
    currentNotebook: NotebookSnapshot,
    isCurrent?: () => boolean,
    chat?: ChatExecution,
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
        callTool: (tool, args) => call(tool, args, { chat }),
        command,
        document: currentNotebook,
        ...(currentNotebook.revision
          ? { expectedRevision: currentNotebook.revision }
          : {}),
      })
      actionCellId = run.actionCellId
      if (isCurrent?.() === false) return { ok: true, message: 'Audio extraction queued in the previous workspace.' }
      collapseComposerAfterCellCreation(chat)
      setCellRunError(actionCellId, null)
      setCellQueued(actionCellId, true)
      selectCanvasCell(run.outputCellId ?? actionCellId, chat)
      presentChat(chat, () => setNotice(`Audio extraction queued for ${sourceAddress}`))
      const outcome = await watchNotebookRun({
        bookId,
        notebookId: currentNotebook.id,
        cellId: actionCellId,
        address: notebookGridAddress(source.slot),
        runId: run.runId,
        jobOperationId: run.jobId,
        intervalMs: notebookRunPollIntervalMs,
        timeoutMs: notebookRunPollTimeoutMs,
        maxPollFailures: notebookRunMaxPollFailures,
      })
      if (isCurrent?.() === false) return { ok: true, message: 'Check the previous workspace for the accepted audio extraction.' }
      if (outcome.kind === 'failed') {
        throw new Error(outcome.message ?? `Audio extraction for ${sourceAddress} failed`)
      }
      if (outcome.kind === 'timeout') {
        throw new Error('Audio extraction did not finish within five minutes')
      }
      if (outcome.kind === 'superseded') {
        throw new Error(`Audio extraction for ${sourceAddress} was superseded by a newer run`)
      }
      selectCanvasCell(run.outputCellId ?? actionCellId, chat)
      return {
        ok: true,
        message: `Extracted audio from ${sourceAddress}`,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (isCurrent?.() !== false) {
        if (actionCellId) setCellRunError(actionCellId, message)
        presentChat(chat, () => setNotice(message, 'error'))
      }
      return { ok: false, message }
    } finally {
      if (actionCellId && isCurrent?.() !== false) setCellQueued(actionCellId, false)
      setBusy(false)
    }
  }

  const runNotebookAudioCommandNow = async (
    command: NotebookAudioCommand,
    isCurrent?: () => boolean,
    chat?: ChatExecution,
  ): Promise<ComposerOutcome> => {
    if (!bookId || !notebook) {
      return { ok: false, message: 'Open a notebook before extracting audio.' }
    }
    try {
      const currentNotebook = asNotebook(await call('get_notebook', {
        book_id: bookId,
        notebook_id: notebook.id,
      }, { chat }))
      if (isCurrent?.() === false) return { ok: false, message: 'Workspace changed. Repeat the command in the current workspace.' }
      if (!currentNotebook) {
        throw new Error('The server returned an invalid notebook')
      }
      resolveNotebookVideoSourceCell(
        currentNotebook,
        command.sourceReference,
      )
      reviewChat(chat, false, () => setPendingCommandPlan(null))
      reviewChat(chat, false, () => setPendingChatAction(null))
      return await executeNotebookAudioCommand(command, currentNotebook, isCurrent, chat)
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  const runNotebookFrameCommandNow = async (
    command: NotebookFrameCommand,
    isCurrent?: () => boolean,
    chat?: ChatExecution,
  ): Promise<ComposerOutcome> => {
    if (!bookId || !notebook) {
      return { ok: false, message: 'Open a notebook before extracting a frame.' }
    }
    try {
      const currentNotebook = asNotebook(await call('get_notebook', {
        book_id: bookId,
        notebook_id: notebook.id,
      }, { chat }))
      if (isCurrent?.() === false) return { ok: false, message: 'Workspace changed. Repeat the command in the current workspace.' }
      if (!currentNotebook) {
        throw new Error('The server returned an invalid notebook')
      }
      resolveNotebookVideoSourceCell(
        currentNotebook,
        command.sourceReference,
      )
      reviewChat(chat, false, () => setPendingCommandPlan(null))
      reviewChat(chat, false, () => setPendingChatAction(null))
      return await executeNotebookFrameCommand(command, currentNotebook, isCurrent, chat)
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  const previewNotebookFrameCommand = async (
    command: NotebookFrameCommand,
    isCurrent?: () => boolean,
    chat?: ChatExecution,
  ): Promise<ComposerOutcome> => {
    if (!bookId || !notebook) {
      return { ok: false, message: 'Open a notebook before extracting a frame.' }
    }
    try {
      const currentNotebook = asNotebook(await call('get_notebook', {
        book_id: bookId,
        notebook_id: notebook.id,
      }, { chat }))
      if (isCurrent?.() === false) return { ok: false, message: 'Workspace changed. Repeat the command in the current workspace.' }
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
      reviewChat(chat, false, () => setPendingCommandPlan(null))
      reviewChat(chat, true, () => setPendingChatAction({
        kind: 'frame',
        command,
        expectations: [{
          address: notebookGridTag(source.slot),
          cellId: source.id,
        }],
        notebookId: currentNotebook.id,
        reason: 'This request extracts a frame into a new image cell',
        summary: frameSummary,
      }))
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
    isCurrent?: () => boolean,
    chat?: ChatExecution,
  ): Promise<ComposerOutcome> => {
    if (!bookId || !notebook) {
      return { ok: false, message: 'Open a notebook before splitting a video.' }
    }
    try {
      const currentNotebook = asNotebook(await call('get_notebook', {
        book_id: bookId,
        notebook_id: notebook.id,
      }, { chat }))
      if (isCurrent?.() === false) return { ok: false, message: 'Workspace changed. Repeat the command in the current workspace.' }
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
      reviewChat(chat, false, () => setPendingCommandPlan(null))
      reviewChat(chat, true, () => setPendingChatAction({
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
      }))
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
      preferredModel?: string
      reason?: string
      routedParams?: Record<string, unknown>
      isCurrent?: () => boolean
    },
    chat?: ChatExecution,
  ): Promise<ComposerOutcome> => {
    if (!bookId || !notebook) {
      return { ok: false, message: 'Open a notebook before generating media.' }
    }
    try {
      const currentNotebook = asNotebook(await call('get_notebook', {
        book_id: bookId,
        notebook_id: notebook.id,
      }, { chat }))
      if (options?.isCurrent?.() === false) return { ok: false, message: 'Workspace changed. Repeat the command in the current workspace.' }
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
        ...(options?.preferredModel
          ? { preferredModel: options.preferredModel }
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
      reviewChat(chat, false, () => setPendingCommandPlan(null))
      reviewChat(chat, true, () => setPendingChatAction({
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
        // Never the chat model's own sentence: a review states what will
        // actually run, down to the sources it really carries, so it cannot
        // promise a reference the draft does not have.
        summary: `Generate ${command.mediaKind} as ${notebookGridTag(draft.cell.slot)}${references}`,
      }))
      requestPendingGenerationPreview(draft, currentNotebook, chat)
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

  const isChainSettled = (status: string): boolean =>
    status === 'completed'
    || status === 'failed'
    || status === 'cancelled'
    || status === 'interrupted'
    || status === 'awaiting-approval'

  /**
   * Follow a chain until nothing is running. A chain waiting on a review is
   * settled for polling purposes, so the five-minute deadline covers one leg of
   * work rather than the time a person takes to decide.
   */
  const pollChainRun = async (
    book: string,
    accepted: ChainRunValue,
    isCurrent?: () => boolean,
    chat?: ChatExecution,
  ): Promise<ChainRunValue> => {
    saveValue('videobook.active-chain', JSON.stringify({ bookId: book, chainId: accepted.chainId }))
    const deadline = Date.now() + 5 * 60_000
    let latest = accepted
    while (Date.now() < deadline) {
      const snapshot = asChainRun(await call('chain', {
        action: 'status',
        book_id: book,
        chain_id: accepted.chainId,
      }, { background: true, chat }))
      if (isCurrent?.() === false) throw new Error('Workspace changed. Check the previous project for the accepted action.')
      if (!snapshot) break
      latest = snapshot
      const running = snapshot.steps.find((step) => step.status === 'running')
      if (running) presentChat(chat, () => setNotice(`${running.tool.replaceAll('_', ' ')}…`))
      if (isChainSettled(snapshot.status)) {
        if (snapshot.status !== 'awaiting-approval') saveValue('videobook.active-chain', '')
        return snapshot
      }
      await new Promise((resolve) => window.setTimeout(resolve, 250))
    }
    throw new Error(latest.error ?? 'Chain timed out')
  }

  /** Put one paused step on screen and hand the decision back to the user. */
  const openChainStepReview = (snapshot: ChainRunValue, chat?: ChatExecution): ComposerOutcome => {
    const paused = snapshot.steps.find((step) => step.id === snapshot.awaitingStepId)
    const review = paused?.review
    if (!review) {
      return { ok: false, message: 'The chain is waiting for approval but sent no review.' }
    }
    const remaining = snapshot.steps.filter((step) => step.status === 'pending').length
    reviewChat(chat, true, () => setPendingChatAction({
      kind: 'chain-step',
      chainId: snapshot.chainId,
      review,
      remaining,
    }))
    presentChat(chat, () => setNotice(review.reason))
    return { ok: true, message: review.reason, nextInput: '/apply', selectInput: false }
  }

  /**
   * Spend on the step the user just approved, then follow the chain to whatever
   * comes next: the following paused step, or the end of the run.
   */
  const approveChainStepNow = async (
    pending: Extract<PendingChatAction, { kind: 'chain-step' }>,
    chat?: ChatExecution,
  ): Promise<ComposerOutcome> => {
    if (!bookId) return { ok: false, message: 'Load or create a book first.' }
    reviewChat(chat, false, () => setPendingChatAction(null))
    setBusy(true)
    try {
      const approved = asChainRun(await call('chain', {
        action: 'approve',
        book_id: bookId,
        chain_id: pending.chainId,
        step_id: pending.review.stepId,
        actor: 'chat',
      }, { chat }))
      if (!approved) throw new Error('The server did not return the chain run')
      const settled = isChainSettled(approved.status)
        ? approved
        : await pollChainRun(bookId, approved, undefined, chat)
      if (settled.status === 'awaiting-approval') return openChainStepReview(settled, chat)
      await refreshBookData(bookId, notebook?.id, undefined, chat)
      if (settled.status !== 'completed') {
        throw new Error(settled.error ?? `Chain ${settled.status}`)
      }
      const message = 'Chain complete'
      presentChat(chat, () => setNotice(message))
      return { ok: true, message }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      presentChat(chat, () => setNotice(message, 'error'))
      return { ok: false, message }
    } finally {
      setBusy(false)
    }
  }

  const executeRoutedChatActionNow = async (
    plan: ChatActionPlan,
    isCurrent?: () => boolean,
    chat?: ChatExecution,
  ): Promise<ComposerOutcome> => {
    if (!bookId) return { ok: false, message: 'Load or create a book first.' }
    reviewChat(chat, false, () => setPendingCommandPlan(null))
    setBusy(true)
    let applied = false
    try {
      const result = await call('chat', {
        book_id: bookId,
        action_plan: plan,
      }, { chat })
      applied = true
      if (isCurrent?.() === false) return { ok: false, message: 'Workspace changed. Check the previous project for the accepted action.' }
      reviewChat(chat, false, () => setPendingChatAction(null))
      const acceptedChain = asChainRun(result)
      const settledChain = acceptedChain && !isChainSettled(acceptedChain.status)
        ? await pollChainRun(bookId, acceptedChain, isCurrent, chat)
        : acceptedChain
      if (settledChain?.status === 'awaiting-approval') {
        return openChainStepReview(settledChain, chat)
      }
      const chainResult = settledChain
      if (settledChain && settledChain.status !== 'completed') {
        throw new Error(settledChain.error ?? `Chain ${settledChain.status}`)
      }
      if (isCurrent?.() === false) return { ok: true, message: 'Action accepted in the previous workspace.' }
      if (isDownloadVideoResult(result)) {
        const outcome = await completeVideoDownload(
          result,
          urlFromText(plan.prompt),
          isCurrent, chat,
        )
        if (isCurrent?.() === false) return outcome
        presentChat(chat, () => setNotice(outcome.message, outcome.ok ? 'info' : 'error'))
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
          if (isCurrent?.() === false) return { ok: true, message: 'Action accepted in the previous workspace.' }
          const created = recordValue(await call('create_notebook_cell', {
            book_id: bookId,
            notebook_id: notebook.id,
            cell,
          }, { chat }))
          const cellId = asString(created?.id)
          if (!cellId) {
            throw new Error('The server did not return the new notebook cell')
          }
          firstCellId ??= cellId
          placements.push(notebookGridTag(cell.slot))
        }
        if (isCurrent?.() === false) return { ok: true, message: 'Action accepted in the previous workspace.' }
        selectCanvasCell(firstCellId, chat)
        await refreshBookData(bookId, notebook.id, isCurrent, chat)
        collapseComposerAfterCellCreation(chat)
        const message = `Created ${placements.join(' and ')}`
        if (isCurrent?.() !== false) presentChat(chat, () => setNotice(message))
        return { ok: true, message }
      }
      const resultRecord = recordValue(result)
      const createdCellId = asString(resultRecord?.cell_id)
      const refreshed = await refreshBookData(bookId, notebook?.id, isCurrent, chat)
      if (isCurrent?.() === false) return { ok: true, message: 'Action accepted in the previous workspace.' }
      if (createdCellId) selectCanvasCell(createdCellId, chat)
      if (notebookActionCreatedCells(notebook, refreshed)) collapseComposerAfterCellCreation(chat)
      const message = chainResult
        ? plan.message || 'Chain complete'
        : messageFor(result, plan.message || 'Action applied')
      presentChat(chat, () => setNotice(message))
      return { ok: true, message }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (isCurrent?.() === false) return { ok: false, message: detail }
      const message = applied
        ? `Action completed, but its notebook result could not be shown: ${detail}`
        : detail
      if (applied) {
        await refreshBookData(bookId, notebook?.id, isCurrent, chat).catch(() => undefined)
      }
      presentChat(chat, () => setNotice(message, 'error'))
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

  const prepareXPostThreadReview = async (
    plan: ChatActionPlan,
    maxCharacters: number,
    chat?: ChatExecution,
  ): Promise<XPostThreadReview | null> => {
    if (!bookId || !notebook) return null
    if (plan.tool !== 'post' && plan.routedTool !== 'post') return null
    const rawReference = asString(plan.params.asset_id)?.trim() ?? ''
    const reference = rawReference.replace(/^@/, '')
    const mention = commandMentionAssets.find((candidate) =>
      candidate.artifactId === reference
      || candidate.cellAddress.toLowerCase() === reference.toLowerCase())
    const assetId = mention?.artifactId ?? reference
    const targetAsset = assetById.get(assetId) ?? mention
    if (!assetId || (targetAsset?.type !== 'video' && targetAsset?.type !== 'final')) {
      return null
    }

    const targetPost = (notebook as NotebookSnapshot).posts?.find(post => post.id === plan.params.post_cell_id)
    const graph = discoverXPostThreadGraph(notebook, targetPost?.definition.source?.artifactId ?? assetId)
    const promptMentions: XPostPromptMention[] = [
      ...assets.map((asset) => ({ reference: asset.artifactId, type: asset.type })),
      ...commandMentionAssets.map((candidate) => ({
        reference: candidate.cellAddress,
        type: candidate.type,
      })),
    ]
    const steps = await Promise.all(graph.steps.map(async (step): Promise<XPostThreadStep> => {
      const payload = await call('list_cell_generations', {
        book_id: bookId,
        notebook_id: notebook.id,
        cell_id: step.outputCellId ?? step.producerCellId,
        limit: 20,
      }, { background: true, chat }).catch(() => null)
      const attemptValues = recordValue(payload)?.attempts
      const attempts = Array.isArray(attemptValues)
        ? attemptValues as CellGenerationAttempt[]
        : []
      const prompt = readableXPostPrompt(selectXPostGenerationPrompt({
        attempts,
        outputArtifactId: step.outputArtifactId,
        outputAssetPrompt: step.outputArtifactId
          ? assetById.get(step.outputArtifactId)?.prompt ?? null
          : null,
        producerResolvedPrompt: step.producerResolvedPrompt,
        producerPrompt: step.producerPrompt,
      }), promptMentions)
      const images = step.sourceArtifactIds.flatMap((sourceAssetId) => {
        const sourceAsset = assetById.get(sourceAssetId)
        if (sourceAsset?.type !== 'image') return []
        const sourceMention = commandMentionAssets.find((candidate) =>
          candidate.artifactId === sourceAssetId)
        return [{
          assetId: sourceAssetId,
          label: sourceMention ? `@${sourceMention.cellAddress}` : sourceAsset.id,
          mediaUrl: sourceAsset.mediaUrl,
          thumbnailUrl: sourceAsset.thumbnailUrl,
        }]
      })
      const model = selectXPostGenerationModel({
        attempts,
        outputArtifactId: step.outputArtifactId,
        producerTool: step.producerTool,
        producerModel: step.producerModel,
        producerProvider: step.producerProvider,
        actions: generationActions,
      })
      return { id: step.id, prompt, model, images }
    }))

    const creditValues = await Promise.all(graph.upstreamArtifactIds
      .filter((upstreamAssetId) => {
        const upstreamAsset = assetById.get(upstreamAssetId)
        return upstreamAsset?.origin === 'download'
          && (upstreamAsset.type === 'video' || upstreamAsset.type === 'final')
      })
      .map(async (upstreamAssetId): Promise<XPostSourceCredit | null> => {
        const metadata = await call('read_asset_metadata', {
          asset_id: upstreamAssetId,
          name: 'original',
          book_id: bookId,
        }, { background: true, chat }).catch(() => null)
        const record = recordValue(metadata)
        return record ? xPostSourceCredit(upstreamAssetId, record) : null
      }))
    const credits = dedupeXPostSourceCredits(
      creditValues.filter((value): value is XPostSourceCredit => value !== null),
    )
    return initialXPostThreadReview({ steps, credits }, maxCharacters)
  }

  const reviewPublicationOnX = async (post: PostView) => {
    const assetId = post.definition.source?.snapshotArtifactId
    if (!assetId) return
    const plan: ChatActionPlan = {
      kind: 'chat-action-plan', planId: uuidv7(), bookId, prompt: `Post ${post.address} to X`,
      routedTool: 'post', tool: 'post', params: { book_id: bookId, asset_id: assetId, post_cell_id: post.id, platform: 'x', text: post.definition.caption },
      message: 'Review your X publication', summary: 'Publish the saved clip to X', effect: 'mutation',
      confirmation: { required: true, reason: 'Publishes this clip to X' },
    }
    await previewRoutedChatAction(plan, plan.prompt)
    setComposerDockOpen(true)
  }

  const openColdOpenReview = (reference?: string, chat?: ChatExecution): ComposerOutcome => {
    if (mcp.state !== 'ready' || !bookId || !notebook) return { ok: false, message: 'Open a connected notebook before making a cold open.' }
    const normalized = reference?.replace(/^@/, '')
    const mention = normalized ? commandMentionAssets.find(item => item.artifactId === normalized || item.cellAddress.toLowerCase() === normalized.toLowerCase()) : null
    const assetId = mention?.artifactId ?? normalized ?? selectedNotebookCell?.outputArtifactId
    const asset = assetId ? assetById.get(assetId) : null
    if (!asset || !['video', 'final'].includes(asset.type) || !asset.mediaUrl) return { ok: false, message: 'Select a playable video or use /edit-cold-open @a1.' }
    const mediaUrl = asset.mediaUrl
    reviewChat(chat, false, () => setPendingCommandPlan(null))
    reviewChat(chat, false, () => setPendingWatermarkReview(null))
    reviewChat(chat, true, () => setPendingChatAction({
      kind: 'cold-open',
      review: { bookId, notebookId: notebook.id, assetId: asset.artifactId,
        label: mention ? `@${mention.cellAddress}` : asset.label ?? asset.id,
        mediaUrl, requestId: uuidv7(), suggestion: null },
    }))
    setComposerDockOpen(true)
    return applyReadyOutcome('Cold-open review opened')
  }

  const notebookPosts = (notebook as NotebookSnapshot | null)?.posts ?? []

  const deliveryStatusCall = (tool: string, args: Record<string, unknown>) => call(tool, args, { background: true })

  const updatePendingDelivery = (patch: Partial<PostDeliveryReview>) => setPendingChatAction(current =>
    current?.kind === 'post-delivery' ? { ...current, review: { ...current.review, ...patch } } : current)

  const checkPostDropboxConnection = async () => {
    try {
      updatePendingDelivery({ connection: await fetchDropboxConnection(deliveryStatusCall) })
    } catch (error) {
      updatePendingDelivery({ connection: { connected: false, pending: false, hasCredentials: true, error: error instanceof Error ? error.message : String(error) } })
    }
  }

  const checkPostIcloudStatus = async () => {
    try {
      const status = await fetchIcloudStatus(deliveryStatusCall)
      setPendingChatAction(current => current?.kind === 'post-delivery'
        ? { ...current, review: reviewWithIcloudStatus(current.review, status) }
        : current)
    } catch (error) {
      updatePendingDelivery({ icloud: { available: false, root: '', shared: null, role: null, reason: error instanceof Error ? error.message : String(error) } })
    }
  }

  const connectPostDropbox = async () => {
    const popup = window.open('about:blank', '_blank')
    updatePendingDelivery({ connecting: true })
    try {
      const authorizeUrl = await startDropboxConnection(call)
      if (popup) popup.location.href = authorizeUrl
      else window.open(authorizeUrl, '_blank', 'noopener,noreferrer')
      const scope = watchScopeRef.current.bookId
      const connection = await waitForDropboxConnection(deliveryStatusCall, delay, () => watchScopeRef.current.bookId === scope)
      updatePendingDelivery({ connection, connecting: false })
    } catch (error) {
      popup?.close()
      updatePendingDelivery({ connecting: false, connection: { connected: false, pending: false, hasCredentials: true, error: error instanceof Error ? error.message : String(error) } })
    }
  }

  const openPostDeliveryReview = (reference: string | undefined, entry: DeliveryDestination, chat?: ChatExecution): ComposerOutcome => {
    if (mcp.state !== 'ready' || !bookId || !notebook) return { ok: false, message: 'Open a connected notebook before delivering a Post.' }
    const post = resolveDeliveryPost(notebookPosts, notebook.cells, reference, selectedNotebookCell?.id ?? null)
    const hint = entry === 'dropbox' ? '/upload-post-to-dropbox @b1' : '/save-post-to-icloud @b1'
    if (!post) {
      return { ok: false, message: reference?.trim()
        ? `${reference.trim()} is not a Post or a clip. Select one or use ${hint}.`
        : `Select a Post cell or use ${hint}.` }
    }
    return openDeliveryReviewForPost(post, entry, chat)
  }

  const openSourceDeliveryReview = async (reference: string | undefined, entry: DeliveryDestination, chat?: ChatExecution): Promise<ComposerOutcome> => {
    const trimmed = reference?.trim()
    const source = trimmed && mcp.state === 'ready' && bookId && notebook
      && !resolveDeliveryPost(notebookPosts, notebook.cells, trimmed, null)
      ? resolveDeliverySource(notebook.cells, trimmed)
      : null
    if (!source || !bookId || !notebook) return openPostDeliveryReview(reference, entry, chat)
    const existing = latestPostForSource(notebookPosts, source.id)
    if (existing) return openDeliveryReviewForPost(existing, entry, chat)
    try {
      const created = await call('create_post', { book_id: bookId, notebook_id: notebook.id, source_cell_id: source.id }) as PostView
      await refreshBookData(bookId, notebook.id)
      return openDeliveryReviewForPost(created, entry, chat)
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  const draftPostCopyFor = async (targetBookId: string, postId: string, copy: PostCopyState, language: PostCopyLanguage, instruction: string | null) => {
    const requestId = uuidv7()
    const ownsRequest = (current: PendingChatAction | null) => current?.kind === 'post-delivery'
      && current.review.postId === postId && current.review.copy.drafting?.requestId === requestId
    setPendingChatAction(current => current?.kind === 'post-delivery' && current.review.postId === postId
      ? { ...current, review: { ...current.review, copy: { ...current.review.copy, drafting: { requestId, language }, error: null } } }
      : current)
    try {
      const draft = postCopyDraftFromTool(await call('draft_post_copy', copyDraftArgs(targetBookId, postId, copy, language, instruction)))
      setPendingChatAction(current => ownsRequest(current) && current?.kind === 'post-delivery'
        ? { ...current, review: { ...current.review, copy: appendCopyDraft(current.review.copy, language, draft, instruction) } }
        : current)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setPendingChatAction(current => ownsRequest(current) && current?.kind === 'post-delivery'
        ? { ...current, review: { ...current.review, copy: { ...current.review.copy, drafting: null, error: message } } }
        : current)
    }
  }

  const choosePostCopyLanguage = (post: PostView, review: PostDeliveryReview, language: PostCopyLanguage) => {
    const copy = { ...review.copy, language }
    updatePendingDelivery({ copy })
    if (copyNeedsDraft(copy, language, deliveryCaptionLocked(post))) void draftPostCopyFor(review.bookId, post.id, copy, language, null)
  }

  const regenPostCopy = (post: PostView, review: PostDeliveryReview) => {
    if (deliveryCaptionLocked(post) || review.copy.drafting) return
    void draftPostCopyFor(review.bookId, post.id, review.copy, review.copy.language, review.copy.prompt.trim() || null)
  }

  const openDeliveryReviewForPost = (post: PostView, entry: DeliveryDestination, chat?: ChatExecution): ComposerOutcome => {
    if (!bookId || !notebook) return { ok: false, message: 'Open a connected notebook before delivering a Post.' }
    const bookName = activeBook?.name ?? 'book'
    const copy = initialCopyState(post)
    reviewChat(chat, false, () => setPendingCommandPlan(null))
    reviewChat(chat, false, () => setPendingWatermarkReview(null))
    reviewChat(chat, true, () => setPendingChatAction({
      kind: 'post-delivery',
      review: {
        bookId,
        notebookId: notebook.id,
        postId: post.id,
        entry,
        destination: entry,
        pinnedDestination: false,
        copy,
        icloudFolder: defaultIcloudFolder(post, bookName),
        dropboxFolder: defaultDropboxFolder(post, bookName),
        connection: null,
        connecting: false,
        icloud: null,
        receipt: null,
        sync: null,
      },
    }))
    setComposerDockOpen(true)
    void checkPostIcloudStatus()
    if (entry === 'dropbox') void checkPostDropboxConnection()
    if (copyNeedsDraft(copy, copy.language, deliveryCaptionLocked(post))) void draftPostCopyFor(bookId, post.id, copy, copy.language, null)
    return applyReadyOutcome(entry === 'dropbox' ? 'Dropbox upload review opened' : 'Save to iPhone review opened')
  }

  const chooseDeliveryDestination = (destination: DeliveryDestination) => {
    updatePendingDelivery({ destination, pinnedDestination: true })
    if (destination === 'dropbox') void checkPostDropboxConnection()
  }

  const previewRoutedChatAction = async (
    plan: ChatActionPlan,
    originalInput: string,
    isCurrent?: () => boolean,
    chat?: ChatExecution,
  ): Promise<ComposerOutcome> => {
    const routedAssetReference = (value: unknown): string | null => {
      const assetId = asString(value)
      if (!assetId) return null
      return notebookChatGenerationReferences(restoreNotebookMentionAliases(
        assetId.startsWith('@') ? assetId : `@${assetId}`,
        commandMentionAssets,
      ))[0] ?? null
    }
    if (plan.tool === 'prepare_cold_open' || plan.tool === 'edit_cold_open') {
      return openColdOpenReview(asString(plan.params.asset_id) ?? undefined, chat)
    }
    if (plan.tool === 'upload_post_to_dropbox' || plan.tool === 'save_post_to_icloud') {
      return openSourceDeliveryReview(asString(plan.params.post_cell_id) ?? undefined, plan.tool === 'upload_post_to_dropbox' ? 'dropbox' : 'icloud', chat)
    }
    if (plan.tool === 'show_subtitles') {
      const assetId = asString(plan.params.asset_id)
      if (!assetId) return { ok: false, message: 'Name the video to caption.' }
      if (isCurrent?.() === false || chat?.isCurrent() === false) {
        return { ok: false, message: 'Workspace changed. Repeat the command in the current workspace.' }
      }
      return openSubtitles(assetId, chat)
    }
    if (plan.tool === 'show_media_fullscreen') {
      const target = resolveFullscreenTarget(plan.params, notebook?.cells ?? [], assets)
      if (!target.ok) return target
      if (isCurrent?.() === false || chat?.isCurrent() === false) {
        return { ok: false, message: 'Workspace changed. Repeat the command in the current workspace.' }
      }
      reviewChat(chat, false, () => setPendingChatAction(null))
      reviewChat(chat, false, () => setPendingCommandPlan(null))
      openMediaFullscreen(target.cell, target.asset)
      return { ok: true, message: `Opened ${target.address} fullscreen` }
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
      const qrStartSeconds = asNumber(plan.params.qr_start_seconds)
      const qrEndSeconds = asNumber(plan.params.qr_end_seconds)
      const handleStartSeconds = asNumber(plan.params.handle_start_seconds)
      const handleEndSeconds = asNumber(plan.params.handle_end_seconds)
      const qrOpacity = asNumber(plan.params.qr_opacity)
      const handleOpacity = asNumber(plan.params.handle_opacity)
      const handleVerticalPercent = asNumber(plan.params.handle_vertical_percent)
      const handlePadding = asNumber(plan.params.handle_padding)
      const handlePaddingY = asNumber(plan.params.handle_padding_y)
      const handleRounding = asNumber(plan.params.handle_rounding)
      const fadeSeconds = asNumber(plan.params.fade_seconds)
      const requestedPosition = plan.params.position
      const requestedHandlePlacement = plan.params.handle_position
      const requestedPlatformIcon = plan.params.include_platform_icon
      openWatermarkReview(target.artifactId, target.label, {
        ...(isWatermarkPlatform(plan.params.platform) ? { platform: plan.params.platform } : {}),
        ...(asString(plan.params.handle)
          ? { handle: asString(plan.params.handle) ?? undefined }
          : {}),
        ...(asString(plan.params.url)
          ? { url: asString(plan.params.url) ?? undefined }
          : {}),
        ...(typeof plan.params.include_qr === 'boolean'
          ? { includeQr: plan.params.include_qr }
          : {}),
        ...(typeof plan.params.include_handle === 'boolean'
          ? { includeHandle: plan.params.include_handle }
          : {}),
        ...(isWatermarkPosition(requestedPosition)
          ? { position: requestedPosition }
          : {}),
        ...(handleVerticalPercent !== null
          ? { handleVerticalPercent: clampHandleVerticalPercent(handleVerticalPercent) }
          : {}),
        ...(isWatermarkHandlePlacement(requestedHandlePlacement)
          ? { handlePlacement: requestedHandlePlacement }
          : {}),
        ...(typeof requestedPlatformIcon === 'boolean'
          ? { includePlatformIcon: requestedPlatformIcon }
          : {}),
        ...(typeof plan.params.include_handle_border === 'boolean'
          ? { includeHandleBorder: plan.params.include_handle_border }
          : {}),
        ...(handlePadding !== null
          ? { handlePadding: clampHandlePadding(handlePadding) }
          : {}),
        ...(handlePaddingY !== null
          ? { handlePaddingY: clampHandlePadding(handlePaddingY) }
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
        ...(fadeSeconds !== null
          ? { fadeSeconds: clampWatermarkFadeSeconds(fadeSeconds) }
          : {}),
        ...(typeof plan.params.save_default === 'boolean'
          ? { saveDefault: plan.params.save_default }
          : {}),
      }, chat)
      return applyReadyOutcome(`Watermark review ready for ${target.label}`)
    }
    if (plan.tool === 'transcribe' || plan.routedTool === 'transcribe') {
      return openTranscribeReview({
        assetRef: asString(plan.params.asset_id) ?? undefined,
        languageCode: asString(plan.params.language_code) ?? '',
        diarize: typeof plan.params.diarize === 'boolean' ? plan.params.diarize : true,
        tagAudioEvents: typeof plan.params.tag_audio_events === 'boolean' ? plan.params.tag_audio_events : true,
        chat,
      })
    }
    if (plan.tool === 'extract_audio') {
      const sourceReference = routedAssetReference(plan.params.asset_id)
      if (!sourceReference) {
        return { ok: false, message: 'The chat model did not select a video source.' }
      }
      return await runNotebookAudioCommandNow({ sourceReference }, isCurrent, chat)
    }
    if (plan.tool === 'extract_frame' && (plan.params.frame === 'first' || plan.params.frame === 'last')) {
      const sourceReference = routedAssetReference(plan.params.asset_id)
      if (!sourceReference) {
        return { ok: false, message: 'The chat model did not select a video source.' }
      }
      const command: NotebookFrameCommand = {
        frameMode: plan.params.frame,
        sourceReference,
      }
      if (plan.confirmation.required === false) {
        return await runNotebookFrameCommandNow(command, isCurrent, chat)
      }
      return await previewNotebookFrameCommand(command, isCurrent, chat)
    }
    if (plan.tool === 'extract_frame') {
      const sourceReference = routedAssetReference(plan.params.asset_id)
      const timestampSeconds = asNumber(plan.params.timestamp)
      if (!sourceReference || timestampSeconds === null || timestampSeconds < 0) {
        return {
          ok: false,
          message: 'The chat model did not select a valid video source and timestamp.',
        }
      }
      const command: NotebookFrameCommand = {
        frameMode: 'time',
        sourceReference,
        timestampSeconds,
      }
      if (plan.confirmation.required === false) {
        return await runNotebookFrameCommandNow(command, isCurrent, chat)
      }
      return await previewNotebookFrameCommand(command, isCurrent, chat)
    }
    if (plan.tool === 'split_video') {
      const sourceReference = routedAssetReference(plan.params.asset_id)
      const splitAtSeconds = asNumber(plan.params.chunk_a_end)
      if (!sourceReference || !splitAtSeconds || splitAtSeconds <= 0) {
        return { ok: false, message: 'The chat model did not select a valid split source and time.' }
      }
      return await previewNotebookSplitCommand({
        sourceReference,
        cutPointsSeconds: [splitAtSeconds],
      }, isCurrent, chat)
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
        return { ok: false, message: 'The chat model did not select valid split durations.' }
      }
      if (sourceReference) {
        return await previewNotebookSplitCommand({
          sourceReference,
          cutPointsSeconds: durationTargetsToCutPoints(targets as number[]),
        }, isCurrent, chat)
      }
    }
    if (plan.effect === 'generation') {
      const cellType = generationCellTypeForRoutedTool(
        plan.tool,
        plan.routedTool,
        generationActions,
      )
      const rawRoutedPrompt = asString(plan.params.prompt) ?? originalInput
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
        isCurrent,
        ...(asString(plan.params.model) ? { preferredModel: asString(plan.params.model)! } : {}),
        reason: plan.confirmation.reason,
        routedParams: plan.params,
      }, chat)
    }
    if (plan.confirmation.required === false) {
      return await executeRoutedChatActionNow(plan, isCurrent, chat)
    }
    const postPlan = plan.tool === 'post' || plan.routedTool === 'post'
    // Learn the account's post length before sizing the thread, so a Premium
    // account sees its whole prompt instead of a trimmed one.
    const xConnectionStatus = postPlan ? await refreshXConnection() : null
    const xPostReview = await prepareXPostThreadReview(
      plan,
      xPostMaxCharacters(xConnectionStatus ?? xConnection.status), chat,
    )
    const reviewedPlan = xPostReview
      ? {
          ...plan,
          params: reviseXPostFollowups(
            plan.params,
            xPostFollowupsFromThread(xPostReview),
          ),
        }
      : plan
    if (isCurrent?.() === false) return { ok: false, message: 'Workspace changed. Repeat the command in the current workspace.' }
    reviewChat(chat, false, () => setPendingCommandPlan(null))
    reviewChat(chat, true, () => setPendingChatAction({ kind: 'routed', plan: reviewedPlan, xPostReview }))
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
    chat?: ChatExecution,
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
      }, { chat }))
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
      reviewChat(chat, false, () => setPendingChatAction(null))
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
    presentChat(chat, () => setPendingChatAction((current) => current?.kind === 'generation'
      && current.draft.cell.id === preparedAction.draft.cell.id
      ? {
          ...current,
          draft: preparedAction.draft,
          previewError: null,
          previewLoading: true,
          previewStale: false,
        }
      : current))
    let validatedPreview: unknown
    try {
      pendingGenerationRefresh.cancel()
      pendingGenerationPreviewRequestRef.current += 1
      validatedPreview = await loadPendingGenerationPreview(
        preparedAction.draft,
        currentNotebook, chat,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      presentChat(chat, () => setPendingChatAction((current) => current?.kind === 'generation'
        && current.draft.cell.id === preparedAction.draft.cell.id
        ? {
            ...current,
            draft: preparedAction.draft,
            previewError: message,
            previewLoading: false,
            previewStale: false,
          }
        : current))
      return {
        ok: false,
        message,
        nextInput: retryInput,
        selectInput: false,
      }
    }
    presentChat(chat, () => setPendingChatAction((current) => current?.kind === 'generation'
      && current.draft.cell.id === preparedAction.draft.cell.id
      ? {
          ...current,
          draft: preparedAction.draft,
          preview: validatedPreview,
          previewError: null,
          previewLoading: false,
          previewStale: false,
        }
      : current))
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
    selectCanvasCell(cellId, chat, validatedPreview)
    showOptimisticGeneration(preparedAction.draft, currentNotebook)
    try {
      await materializeNotebookChatGeneration({
        bookId,
        callTool: (tool, args) => call(tool, args, { chat }),
        document: currentNotebook,
        draft: preparedAction.draft,
        ...(currentNotebook.revision
          ? { expectedRevision: currentNotebook.revision }
          : {}),
      })
      materialized = true
      const plan = await createGenerationPlan(cellId, 'chat', chat)
      const accepted = await call('run_notebook_cell', {
        book_id: bookId,
        notebook_id: currentNotebook.id,
        cell_id: cellId,
        plan,
        actor: 'videobook-user',
      }, { chat })
      runAccepted = true
      const acceptedRecord = recordValue(accepted)
      collapseComposerAfterCellCreation(chat)
      const runId = asString(acceptedRecord?.run_id)
      const jobOperationId = asString(acceptedRecord?.job_id)
      const outputCellId = asString(acceptedRecord?.output_cell_id)
      reviewChat(chat, false, () => setPendingChatAction(null))
      if (!voiceActiveRef.current) focusCommandComposer()
      setCellQueued(cellId, false)
      if (!runId || !jobOperationId) {
        await refreshBookData(bookId, currentNotebook.id, undefined, chat).catch(() => undefined)
        return {
          ok: true,
          message: `${cellAddress} was accepted; follow its status in Jobs`,
        }
      }
      presentChat(chat, () => setNotice(`${cellAddress} queued`))
      const watchCellId = outputCellId ?? cellId
      let address = notebookGridAddress(preparedAction.draft.cell.slot)
      if (outputCellId) {
        const refreshed = await refreshNotebook(bookId, currentNotebook.id, chat)
          .catch(() => null)
        presentChat(chat, () => {
          revealCells([outputCellId])
          highlightCells([outputCellId], { scroll: 'center' })
        })
        setCellRunError(outputCellId, null)
        setCellQueued(outputCellId, true)
        const output = refreshed?.cells.find((candidate) =>
          candidate.id === outputCellId)
        if (output) address = notebookGridAddress(output.slot)
      } else {
        highlightCells([cellId], { scroll: 'center' })
      }
      void watchGenerationRun({
        bookId,
        notebookId: currentNotebook.id,
        cellId: watchCellId,
        address,
        runId,
        jobOperationId,
      }, chat)
      await refreshBookData(bookId, currentNotebook.id, undefined, chat).catch(() => undefined)
      return { ok: true, message: `${cellAddress} queued` }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const stale = message.startsWith('Stale notebook revision:')
      if (materialized && !runAccepted) {
        await call('delete_notebook_cell', {
          book_id: bookId,
          notebook_id: currentNotebook.id,
          cell_id: cellId,
        }, { chat }).catch(() => undefined)
      }
      if (!runAccepted) {
        setNodes((current) => current.filter((node) => node.id !== cellId))
        setCellQueued(cellId, false)
      }
      setCellRunError(cellId, message)
      await refreshBookData(bookId, currentNotebook.id, undefined, chat).catch(() => undefined)
      if (stale) {
        reviewChat(chat, false, () => setPendingChatAction(null))
        presentChat(chat, () => setNotice('Notebook changed since this preview; prepare the action again.', 'error'))
        return {
          ok: false,
          message: 'Notebook changed since this preview; prepare the action again.',
        }
      }
      presentChat(chat, () => setNotice(message, 'error'))
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

  const applyPendingTranscribe = async (
    action: Extract<PendingChatAction, { kind: 'transcribe' }>,
    languageOverride: string | null,
    chat?: ChatExecution,
  ): Promise<ComposerOutcome> => {
    const languageCode = languageOverride ?? action.languageCode
    const validation = transcribeValidation({ assetId: action.assetId, languageCode })
    const retryInput = languageOverride ? `/apply ${languageOverride}` : '/apply '
    if (validation.blocking || !action.assetId || !bookId) {
      return {
        ok: false,
        message: validation.blocking ?? 'Choose a video or audio clip.',
        nextInput: retryInput,
        selectInput: false,
      }
    }
    const assetId = action.assetId
    const work = mediaInsightWork[assetId] ?? idleMediaInsightWork
    if (mediaInsightIsRunning(work, 'transcript')) {
      return {
        ok: false,
        message: 'Transcription is already running for this clip.',
        nextInput: retryInput,
        selectInput: false,
      }
    }
    if (languageOverride !== null && languageOverride !== action.languageCode) {
      presentChat(chat, () => setPendingChatAction((current) => current?.kind === 'transcribe'
        ? { ...current, languageCode }
        : current))
    }
    const notebookId = notebook?.id
    const hadInsight = assetHasInsight(assetById.get(assetId), 'transcript')
    const since = Date.now()
    updateMediaInsightWork(assetId, {
      ...mediaInsightRunningPatch('transcript', true),
      error: null,
    })
    try {
      await call('transcribe', transcribeToolArgs({
        bookId,
        assetId,
        languageCode,
        diarize: action.diarize,
        tagAudioEvents: action.tagAudioEvents,
      }), { chat })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      updateMediaInsightWork(assetId, {
        ...mediaInsightRunningPatch('transcript', false),
        error: message,
      })
      return {
        ok: false,
        message,
        nextInput: retryInput,
        selectInput: false,
      }
    }
    reviewChat(chat, false, () => setPendingChatAction(null))
    const address = commandMentionAssets.find((asset) => asset.artifactId === assetId)?.cellAddress
    const label = address ? `@${address}` : assetById.get(assetId)?.label ?? assetId
    const message = `Transcription queued for ${label}`
    presentChat(chat, () => setNotice(message))
    if (notebookId) {
      void watchAssetInsight({
        bookId,
        notebookId,
        artifactId: assetId,
        insight: 'transcript',
        since,
        hadInsight,
      }).then((step) => {
        updateMediaInsightWork(assetId, {
          ...mediaInsightRunningPatch('transcript', false),
          error: step.kind === 'failed' ? step.message : null,
        })
      }).catch((error: unknown) => {
        updateMediaInsightWork(assetId, {
          ...mediaInsightRunningPatch('transcript', false),
          error: error instanceof Error ? error.message : String(error),
        })
      })
    } else {
      updateMediaInsightWork(assetId, {
        ...mediaInsightRunningPatch('transcript', false),
        error: null,
      })
    }
    return { ok: true, message, nextInput: '' }
  }

  const applyPendingChatAction = async (
    promptOverride: string | null = null,
    chat?: ChatExecution,
  ): Promise<ComposerOutcome> => {
    if (!pendingChatAction || !bookId) {
      return { ok: false, message: 'There is no pending chat action.' }
    }
    if (pendingChatAction.kind === 'cold-open') {
      const review = pendingChatAction.review
      const current = () => watchScopeRef.current.bookId === review.bookId
        && watchScopeRef.current.notebookId === review.notebookId && (chat?.isCurrent() ?? true)
      const coldCall = (tool: string, args: Record<string, unknown>, options?: { background?: boolean }) => call(tool, args, { ...options, chat })
      if (!review.suggestion) {
        const prepared = await prepareColdOpenReview(coldCall, review, current)
        reviewChat(chat, true, () => setPendingChatAction({ kind: 'cold-open', review: prepared }))
        return applyReadyOutcome('Adjust the highlight, then create the copy')
      }
      const output = await renderColdOpenReview(coldCall, review, current)
      await refreshBookData(review.bookId, review.notebookId, current, chat)
      if (!current()) return { ok: true, message: `Cold-open copy created as ${output.address}` }
      reviewChat(chat, false, () => setPendingChatAction(null))
      selectCanvasCell(output.cellId)
      collapseComposerAfterCellCreation(chat)
      return { ok: true, message: `Cold-open copy created as ${output.address}` }
    }
    if (pendingChatAction.kind === 'subtitles') {
      const outcome = await subtitles.render()
      if (!outcome.ok) return { ok: false, message: outcome.message }
      await refreshBookData(bookId, notebook?.id, undefined, chat)
      reviewChat(chat, false, () => setPendingChatAction(null))
      subtitles.close()
      if (outcome.cellId) selectCanvasCell(outcome.cellId)
      collapseComposerAfterCellCreation(chat)
      return { ok: true, message: outcome.message }
    }
    if (pendingChatAction.kind === 'post-delivery') {
      const review = pendingChatAction.review
      const post = notebookPosts.find(item => item.id === review.postId) ?? null
      const validation = postDeliveryValidation(post, review)
      if (!post || validation.blocking) return { ok: false, message: validation.blocking ?? 'This Post is no longer on the canvas.' }
      const current = () => watchScopeRef.current.bookId === review.bookId
        && watchScopeRef.current.notebookId === review.notebookId && (chat?.isCurrent() ?? true)
      const platformArgs = postPlatformArgs(post, review)
      if (platformArgs) await call('update_post', platformArgs, { chat })
      const saved = await call(postDeliveryTool(review.destination), postDeliveryArgs(post, review), { chat }) as PostView
      await refreshBookData(review.bookId, review.notebookId, current, chat)
      const message = postDeliveryReceipt(saved, review.destination)
      if (current()) {
        reviewChat(chat, true, () => setPendingChatAction({
          kind: 'post-delivery',
          review: {
            ...review,
            icloudFolder: saved.runtime.icloud?.folder ?? review.icloudFolder,
            dropboxFolder: saved.runtime.dropbox?.folder ?? review.dropboxFolder,
            receipt: message,
            sync: null,
          },
        }))
      }
      return { ok: true, message }
    }
    if (pendingChatAction.kind === 'transcribe') {
      if (promptOverride) {
        const override = transcribeLanguageOverride(promptOverride)
        if (!override.ok) {
          return {
            ok: false,
            message: override.message,
            nextInput: `/apply ${promptOverride}`,
            selectInput: false,
          }
        }
        return await applyPendingTranscribe(pendingChatAction, override.languageCode, chat)
      }
      return await applyPendingTranscribe(pendingChatAction, null, chat)
    }
    if (pendingChatAction.kind === 'generation') {
      return await applyPendingGenerationAction(pendingChatAction, promptOverride, chat)
    }
    if (
      pendingChatAction.kind === 'routed'
      && (pendingChatAction.plan.tool === 'post'
        || pendingChatAction.plan.routedTool === 'post')
    ) {
      const error = xPostDraftError(
        xPostDraftFromParams(pendingChatAction.plan.params),
        undefined,
        xPostMaxLength,
      )
      const threadError = pendingChatAction.xPostReview?.options.enabled
        && xPostFollowupsFromThread(pendingChatAction.xPostReview).length === 0
        ? X_POST_EMPTY_THREAD_MESSAGE
        : null
      if (error || threadError) {
        return {
          ok: false,
          message: error ?? threadError ?? 'The post is not ready.',
          nextInput: '/apply',
          selectInput: false,
        }
      }
    }
    if (
      pendingChatAction.kind === 'frame'
      || pendingChatAction.kind === 'split'
      || pendingChatAction.kind === 'notebook'
    ) {
      const currentNotebook = asNotebook(await call('get_notebook', {
        book_id: bookId,
        notebook_id: pendingChatAction.notebookId,
      }, { chat }))
      if (!currentNotebook) {
        return { ok: false, message: 'The server returned an invalid notebook' }
      }
      const expectations = pendingChatAction.kind === 'notebook'
        ? pendingChatAction.plan.expectations
        : pendingChatAction.expectations
      if (notebookAddressExpectationsAreStale(currentNotebook, expectations)) {
        reviewChat(chat, false, () => setPendingChatAction(null))
        return {
          ok: false,
          message: 'Notebook changed since this preview; prepare the action again.',
        }
      }
      if (pendingChatAction.kind === 'frame') {
        const outcome = await executeNotebookFrameCommand(
          pendingChatAction.command,
          currentNotebook, undefined, chat,
        )
        if (outcome.ok) {
          reviewChat(chat, false, () => setPendingChatAction(null))
        } else if (outcome.message.startsWith('Stale notebook revision:')) {
          reviewChat(chat, false, () => setPendingChatAction(null))
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
          currentNotebook, chat,
        )
        if (outcome.ok) {
          reviewChat(chat, false, () => setPendingChatAction(null))
        } else if (outcome.message.startsWith('Stale notebook revision:')) {
          reviewChat(chat, false, () => setPendingChatAction(null))
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
        const outcome = await runCell(cell.id, currentNotebook, chat)
        if (!outcome?.ok) {
          if (outcome?.message.startsWith('Stale notebook revision:')) {
            reviewChat(chat, false, () => setPendingChatAction(null))
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
        reviewChat(chat, false, () => setPendingChatAction(null))
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
          }, { chat }))
          const cellId = asString(created?.id)
          if (cellId) selectCanvasCell(cellId, chat)
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
          }, { chat })
        } else if (action.kind === 'delete') {
          const cell = notebookCellAtSlot(currentNotebook, action.source)!
          await call('delete_notebook_cell', {
            book_id: bookId,
            notebook_id: currentNotebook.id,
            cell_id: cell.id,
            ...revisionInput,
          }, { chat })
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
          }, { chat })
        } else {
          throw new Error('Unsupported notebook action')
        }
        reviewChat(chat, false, () => setPendingChatAction(null))
        await refreshBookData(bookId, currentNotebook.id, undefined, chat)
        if (action.kind === 'create') collapseComposerAfterCellCreation(chat)
        presentChat(chat, () => setNotice(pendingChatAction.plan.summary))
        return { ok: true, message: pendingChatAction.plan.summary }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.startsWith('Stale notebook revision:')) {
          reviewChat(chat, false, () => setPendingChatAction(null))
          presentChat(chat, () => setNotice('Notebook changed since this preview; prepare the action again.', 'error'))
          return {
            ok: false,
            message: 'Notebook changed since this preview; prepare the action again.',
          }
        }
        presentChat(chat, () => setNotice(message, 'error'))
        return { ok: false, message, nextInput: '/apply', selectInput: true }
      } finally {
        setBusy(false)
      }
    }
    if (pendingChatAction.kind === 'chain-step') {
      return await approveChainStepNow(pendingChatAction, chat)
    }
    return await executeRoutedChatActionNow(pendingChatAction.plan, undefined, chat)
  }

  const completeWorkspaceToolResult = async (tool: string, result: unknown, args: Record<string, unknown>, title: string, chat?: ChatExecution): Promise<ComposerOutcome> => {
    if (tool === 'download_video' && notebook) {
      return await completeVideoDownload(result, asString(args.url) ?? '', undefined, chat)
    }
    const routedCells = notebook
      ? routedMediaCellInputs(tool, result, notebook.cells, lastWorkSlot)
      : []
    if (notebook && routedCells.length > 0) {
      const placements: string[] = []
      let firstCellId: string | null = null
      for (const cell of routedCells) {
        const created = recordValue(await call('create_notebook_cell', {
          book_id: bookId,
          notebook_id: notebook.id,
          cell,
        }, { chat }))
        const cellId = asString(created?.id)
        if (!cellId) {
          throw new Error('The server did not return the new notebook cell')
        }
        firstCellId ??= cellId
        placements.push(notebookGridTag(cell.slot))
      }
      if (watchScopeRef.current.bookId === bookId) {
        selectCanvasCell(firstCellId, chat)
        await refreshBookData(bookId, notebook.id, undefined, chat)
      }
      const message = `Created ${placements.join(' and ')}`
      collapseComposerAfterCellCreation(chat)
      presentChat(chat, () => setNotice(message))
      return { ok: true, message }
    }
    if (watchScopeRef.current.bookId === bookId) {
      const refreshed = await refreshBookData(bookId, notebook?.id, undefined, chat)
      if (notebookActionCreatedCells(notebook, refreshed)) collapseComposerAfterCellCreation(chat)
    }
    if (tool === 'rename_asset') {
      const renamed = recordValue(result)
      const newLabel = asString(renamed?.label)
      return {
        ok: true,
        message: newLabel ? `Renamed asset to ${newLabel}` : 'Asset renamed',
      }
    }
    return { ok: true, message: messageFor(result, `${title} complete`) }
  }

  const openWorkspaceMedia = async (asset: AssetRecord, orientation?: string, position?: number, chat?: ChatExecution) => {
    const targetBookId = bookId
    const manifest = recordValue(await call('asset_manifest', { book_id: targetBookId, asset_id: asset.artifactId }, { chat }))
    if (watchScopeRef.current.bookId !== targetBookId) return
    const files = (Array.isArray(manifest?.files) ? manifest.files : []).flatMap((entry) => {
      const name = asString(recordValue(entry)?.name)
      return name ? [{ name, url: `/files/${encodeURIComponent(targetBookId)}/${encodeURIComponent(asset.artifactId)}/${name.split('/').map(encodeURIComponent).join('/')}` }] : []
    })
    const selected = orientation === 'original' ? files.find((file) => file.name.startsWith('original.'))
      : orientation ? files.find((file) => file.name.startsWith(`${orientation}.`))
        : position ? files[position - 1] : undefined
    if ((orientation || position) && !selected) throw new Error(orientation ? `No ${orientation} file exists yet. Use render video to create it.` : 'That file position does not exist.')
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    presentChat(chat, () => setWorkspacePreview({ media: {
      label: asset.label, assetId: asset.artifactId, type: asset.type, url: asset.mediaUrl,
      thumbnailUrl: asset.thumbnailUrl, files, initialFile: selected?.name, opener,
    }, opener, turnId: chat?.id }))
  }

  const executeWorkspaceUiRoute = async (action: WorkspaceAction, values: Record<string, unknown>, chat?: ChatExecution): Promise<ComposerOutcome | null> => {
    if (action.handler.kind !== 'ui') return null
    const uiAction = action.handler.action
    const route = WORKSPACE_UI_ROUTES[uiAction]
    if (route.kind === 'existing') return null
    if (route.kind === 'library') {
      openNotebookLibrary()
      return { ok: true, message: 'Assets opened' }
    }
    if (route.kind === 'screen') {
      navigate(route.screen)
      return { ok: true, message: `${route.screen === 'jobs' ? 'Jobs' : 'Settings'} opened` }
    }
    const reference = asString(values.asset_id ?? values.asset_ref ?? values.artifact_id)
      ?? workspacePreview?.media?.assetId ?? mediaFullscreen?.asset.artifactId ?? selectedNotebookCell?.outputArtifactId
    const asset = assets.find((entry) => entry.artifactId === reference)
      ?? assets.find((entry) => commandMentionAssets.some((mention) => mention.artifactId === entry.artifactId && mention.cellAddress.toLowerCase() === reference?.replace(/^@/u, '').toLowerCase()))
    if (route.kind === 'search') {
      await openWorkspaceActions(undefined, undefined, route.query, undefined, chat)
      return { ok: true, message: 'Actions opened' }
    }
    if (route.kind === 'form') {
      const tool = action.command === '/storage' ? 'storage_status' : route.tool
      const frameRate = sequence ? sequence.frameRate.numerator / sequence.frameRate.denominator : 30
      const formValues = workspaceUiFormValues(uiAction, values, frameRate)
      if (asset) formValues.asset_id = asset.artifactId
      if (uiAction.startsWith('timeline_audio_') && uiAction !== 'timeline_audio_add' && values.audio_ref) {
        const audioTarget = resolveTimelineAudioTarget(
          String(values.audio_ref),
          sequence,
          assets,
          commandMentionAssets,
        )
        if (!audioTarget.ok) return audioTarget
        formValues.audio_id = audioTarget.clipId
      }
      if (uiAction === 'viewer_focus_file' && asset) {
        await openWorkspaceMedia(asset, undefined, parseFilePosition(values.position), chat)
      } else {
        await openWorkspaceActions(`tool.${tool}`, formValues, undefined, undefined, chat)
      }
      return { ok: true, message: `${action.title} options opened` }
    }
    if (route.action === 'upload') {
      actionUploadRef.current?.click()
      return { ok: true, message: 'Choose files to import' }
    }
    if (route.action === 'notebook') {
      const name = asString(values.name)?.trim()
      if (name) {
        const entries = asNotebooks(await call('list_notebooks', { book_id: bookId }, { chat }))
        const target = entries.find((entry) => entry.name === name || entry.id === name)
        if (!target) {
          await openWorkspaceActions('tool.create_notebook', { name }, undefined, undefined, chat)
          return { ok: true, message: 'Create notebook options opened' }
        }
        await refreshBookData(bookId, target.id, undefined, chat)
      } else if (!notebook) {
        await openWorkspaceActions('tool.create_notebook', { name: 'scratch' }, undefined, undefined, chat)
        return { ok: true, message: 'Create notebook options opened' }
      }
      navigate('notebook')
      return { ok: true, message: 'Notebook opened' }
    }
    if (route.action === 'save') {
      if (!notebook) throw new Error('Open a notebook first.')
      await refreshNotebook(bookId, notebook.id, chat)
      return { ok: true, message: 'Notebook changes are saved automatically. Saved state verified.' }
    }
    if (route.action === 'collapse' || route.action === 'expand') {
      const expand = route.action === 'expand'
      const side = normalizePanelSide(asString(values.side))
      if (side !== 'left' && (expand ? composerDockShouldOpen('expand') : true)) {
        setComposerDockOpen(expand)
      }
      if (side !== 'right') {
        if (expand) await openBookMenu()
        else setBookMenuOpen(false)
      }
      return { ok: true, message: expand ? 'Workspace panels opened' : 'Workspace panels closed' }
    }
    if (route.action === 'close') {
      closeMediaFullscreen()
      presentChat(chat, () => setWorkspacePreview(null))
      return { ok: true, message: 'Viewer closed' }
    }
    if (route.action === 'play') {
      const target = resolvePlaySlot(asString(values.slot), sequence)
      if (!target.ok) return { ok: false, message: target.message }
      presentChat(chat, () => setWorkspacePreview({ initialFrame: target.initialFrame, turnId: chat?.id, opener: document.activeElement instanceof HTMLElement ? document.activeElement : null }))
      return { ok: true, message: 'Sequence preview opened' }
    }
    if (!asset) {
      await openWorkspaceActions(action.id, values, undefined, undefined, chat)
      return { ok: true, message: 'Choose media for this action' }
    }
    if (route.action === 'copy') {
      await navigator.clipboard.writeText(asset.label)
      return { ok: true, message: 'Media label copied' }
    }
    if (route.action === 'history') {
      const cell = notebook?.cells.find((entry) => entry.outputArtifactId === asset.artifactId)
      if (cell) openCellHistory(cell.id, asset.artifactId)
      else await openWorkspaceActions('tool.asset_history', { asset_id: asset.artifactId }, undefined, undefined, chat)
      return { ok: true, message: 'Media history opened' }
    }
    if (route.action === 'skeleton') {
      if (asset.type !== 'image') throw new Error('Choose an image for a pose guide.')
      await openWorkspaceActions('tool.generate_image', {
        model: 'kie:qwen3/image-to-image',
        refs: { image: [asset.artifactId] },
        prompt: 'Create a pose skeleton guide from this reference image. Preserve the visible body poses, joint positions and framing. Show only clearly connected colored skeleton joints and limbs on a black background, without clothing, faces, scenery or text.',
      }, undefined, undefined, chat)
      return { ok: true, message: 'AI pose guide options opened. Review the provider and cost before generating.' }
    }
    await openWorkspaceMedia(asset, route.action === 'open' ? undefined : route.action, undefined, chat)
    return { ok: true, message: 'Media preview opened' }
  }

  const executeCommand = async (
    input: string,
    context?: { speakVoiceId?: string },
    chat?: ChatExecution,
  ): Promise<ComposerOutcome> => {
    try {
      const normalizedInput = input.trim().toLowerCase()
      const applyCommand = parsePendingApplyCommand(input)
      if (applyCommand) {
        if (
          applyCommand.promptOverride
          && (pendingWatermarkReview || (
            pendingChatAction?.kind !== 'generation'
            && pendingChatAction?.kind !== 'transcribe'
          ))
        ) {
          return {
            ok: false,
            message: 'A quick prompt can only revise a pending generation.',
            nextInput: input,
            selectInput: false,
          }
        }
        if (pendingWatermarkReview) return await submitWatermark(chat)
        if (pendingChatAction) {
          return await applyPendingChatAction(applyCommand.promptOverride, chat)
        }
        if (pendingCommandPlan) return await applyPendingCommandPlan(chat)
        return { ok: false, message: 'There is no pending action to apply.' }
      }
      if (normalizedInput === '/cancel') {
        if (!pendingWatermarkReview && !pendingChatAction && !pendingCommandPlan) {
          return { ok: false, message: 'There is no pending action to cancel.' }
        }
        reviewChat(chat, false, () => setPendingWatermarkReview(null))
        reviewChat(chat, false, () => setPendingChatAction(null))
        reviewChat(chat, false, () => setPendingCommandPlan(null))
        return { ok: true, message: 'Pending action cancelled' }
      }
      if (pendingWatermarkReview) reviewChat(chat, false, () => setPendingWatermarkReview(null))
      if (!bookId && !input.startsWith('/')) return { ok: false, message: 'Load or create a book first.' }
      if (!input.startsWith('/')) {
        const routed = await call('chat', {
          book_id: bookId,
          ...(notebook ? { notebook_id: notebook.id } : {}),
          prompt: input,
          model: chatModel,
        }, { chat })
        const routedRecord = recordValue(routed)
        if (routedRecord?.kind === 'chat-action-plan') {
          return await previewRoutedChatAction(
            asChatActionPlan(routed),
            input, undefined, chat,
          )
        }
        reviewChat(chat, false, () => setPendingChatAction(null))
        reviewChat(chat, false, () => setPendingCommandPlan(null))
        if (isDownloadVideoResult(routed)) {
          return await completeVideoDownload(routed, urlFromText(input), undefined, chat)
        }
        await refreshBookData(bookId, notebook?.id, undefined, chat)
        return {
          ok: true,
          message: messageFor(routed, 'Command complete'),
        }
      }
      const [rawCommandToken, ...restParts] = input.trim().split(/\s+/)
      const commandToken = rawCommandToken.toLowerCase()
      const rest = restParts.join(' ')
      if (commandToken === '/goal') return await startGoal(rest, chat)
      if (commandToken.toLowerCase() === '/actions') {
        await openWorkspaceActions(undefined, undefined, rest, undefined, chat)
        return { ok: true, message: 'Actions opened' }
      }
      const resolvedRest = commandToken.toLowerCase() === '/duplicate'
        ? [
            resolveNotebookMentionAliases(
              restParts[0] ?? '',
              gridMentionAssets,
            ),
            ...restParts.slice(1),
          ].filter(Boolean).join(' ')
        : resolveNotebookMentionAliases(
            rest,
            gridMentionAssets,
          )
      if (commandToken === '/transcribe') {
        const assetRef = resolvedRest.split(/\s+/).find((token) => token.length > 0)
        return openTranscribeReview({ assetRef, chat })
      }
      if (commandToken === '/subs' || commandToken === '/alive') {
        const target = subtitlesCommandTarget(resolvedRest)
        const selected = !resolvedRest.trim() ? selectedNotebookCell?.outputArtifactId ?? mediaFullscreen?.asset.artifactId : undefined
        const asset = target ? assets.find((candidate) => candidate.artifactId === target || candidate.id === target) : undefined
        if (target && !asset) return { ok: false, message: `Video ${target} was not found.` }
        if (asset || selected) return openSubtitles(asset?.artifactId ?? selected!, chat)
      }
      const availableActions = workspaceActions.length ? workspaceActions : asWorkspaceActionCatalog(await call('list_workspace_actions', { detail: 'full' }, { chat })).actions
      if (!workspaceActions.length) setWorkspaceActions(availableActions)
      const advertisedCommand = selectCommandForInput(workspaceActionCommands(availableActions, commands), commandToken, resolvedRest)
      const advertisedAction = availableActions.find((action) => [action.command, ...action.aliases].includes(commandToken))
      if (advertisedCommand?.workspaceActionId || (advertisedAction && !rest && (advertisedAction.inputSchema.required ?? []).some((name) => !['book_id', 'notebook_id', 'sequence_id'].includes(name)))) {
        const values = advertisedCommand ? parseCommandArgs(resolvedRest, advertisedCommand.params) : {}
        await openWorkspaceActions(advertisedAction?.id ?? advertisedCommand?.workspaceActionId, values, undefined, undefined, chat)
        return { ok: true, message: 'Action options opened' }
      }
      if (commandToken === '/extract-audio') {
        if (!notebook || restParts.length !== 1) {
          return { ok: false, message: 'Usage: /extract-audio @video' }
        }
        return await runNotebookAudioCommandNow({
          sourceReference: normalizeNotebookReference(restParts[0]),
        }, undefined, chat)
      }
      if (commandToken === '/split') {
        const command = parseNotebookSplitCommand(input)
        if (!command) {
          return { ok: false, message: 'Usage: /split @video [at 5s, 12.5s] | keep 0.03-0.11 | remove 0.03-0.11' }
        }
        return await previewNotebookSplitCommand(command, undefined, chat)
      }
      if (
        (commandToken === '/split-chunks' || commandToken === '/even-split')
        && new RegExp(`^@${NOTEBOOK_GRID_ADDRESS_SOURCE}$`, 'iu')
          .test(restParts[0] ?? '')
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
        }, undefined, chat)
      }
      if (commandToken === '/rough-cut') {
        return await prepareRoughCut('slash', chat)
      }
      if (commandToken === '/sound-effects') {
        return await prepareSoundEffects('slash', chat)
      }
      if (commandToken === '/generate-cell') {
        if (!notebook || restParts.length !== 1) {
          return { ok: false, message: 'Usage: /generate-cell @cell-id' }
        }
        const token = normalizeNotebookReference(restParts[0])
        const cell = notebook.cells.find((candidate) =>
          candidate.id.toLowerCase() === token || notebookGridTag(candidate.slot).slice(1).toLowerCase() === token)
        if (
          !cell
          || !notebookCellSupportsGenerateCellCommand(cell)
        ) {
          return { ok: false, message: 'Choose a configured generation cell' }
        }
        return await prepareGenerationPlan(cell.id, 'slash', chat)
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
          anchor, chat,
        )
      }
      if (commandToken === '/group-images') {
        const anchor = selectedNotebookCell?.slot ?? lastWorkSlot
        if (!anchor) {
          return { ok: false, message: 'Select a cell to anchor the grouping' }
        }
        return await groupImageCells(anchor, chat)
      }
      if (commandToken === '/track-add') {
        const parsedTrack = parseTrackAddCommand(restParts)
        if (!parsedTrack.ok) return parsedTrack
        return await addSequenceTrack(parsedTrack.kind, parsedTrack.name, chat)
      }
      if (commandToken === '/track-remove') {
        const track = sequenceTrackReference(sequence, restParts[0])
        if (!track || restParts.length !== 1) {
          return { ok: false, message: 'Usage: /track-remove @track-id' }
        }
        return await removeSequenceTrack(track.trackId, chat)
      }
      if (commandToken === '/export-sequence' || (commandToken === '/export' && restParts.some((value) => value === '@sequence-main' || value.startsWith('--') || value === `@${sequence?.sequenceId}`))) {
        if (!sequence) return { ok: false, message: 'Load the primary sequence first.' }
        const parsedExport = parseExportSequenceCommand(restParts, sequence.sequenceId)
        if (!parsedExport.ok) return parsedExport
        const { orientation, captions } = parsedExport
        const currentSequence = asSequence(await call('get_primary_sequence', { book_id: bookId }, { chat }))
        if (!currentSequence) return { ok: false, message: 'Load the primary sequence first.' }
        setSequence(currentSequence)
        const value = await call('plan_sequence_export', {
          book_id: bookId,
          source_surface: 'slash',
          actor: 'videobook-user',
          sequence_revision: currentSequence.revision,
          orientation,
          captions,
        }, { chat })
        const invalid = recordValue(value)
        if (invalid?.kind === 'invalid-export') {
          const validation = recordValue(invalid.validation)
          const errors = Array.isArray(validation?.errors)
            ? validation.errors.map((entry) =>
                asString(recordValue(entry)?.message)).filter(Boolean)
            : []
          return { ok: false, message: errors.join(' · ') || 'Export validation failed' }
        }
        return await previewCommandPlan(asCommandPlan(value), chat)
      }
      const sequenceSlash = parseSequenceSlashCommand(commandToken, restParts, {
        sequence,
        assets,
        mentionAssets: commandMentionAssets,
      })
      if (sequenceSlash.handled) {
        if (!sequenceSlash.ok) return sequenceSlash
        return await prepareSequenceEdit(sequenceSlash.request, 'slash', chat)
      }
      const command = selectCommandForInput(commands, commandToken, resolvedRest)
      if (!command) return { ok: false, message: `Unknown command: ${commandToken}` }
      if (advertisedAction?.handler.kind === 'ui') {
        const parsed = command.command === '/post'
          ? normalizePostCommandArgs(resolvedRest)
          : parseCommandArgs(resolvedRest, command.params)
        const outcome = await executeWorkspaceUiRoute(advertisedAction, parsed, chat)
        if (outcome) return outcome
      }
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
        showScreen('notebook')
        return { ok: true, message: 'Notebook opened' }
      }
      if (command.uiAction === 'x_connect') {
        showScreen('settings')
        return await connectX()
      }
      if (command.uiAction === 'open_provider_keys') {
        showScreen('settings')
        await refreshSettings()
        return { ok: true, message: 'Settings opened' }
      }
      if (command.uiAction === 'open_music_video') {
        if (!sequence) {
          return { ok: false, message: 'Load the primary sequence first.' }
        }
        const parsed = parseCommandArgs(resolvedRest, command.params)
        const audioReference = asString(parsed.audio_ref)
        const resolved = resolveMusicVideoCommandAsset(audioReference, assets)
        if (!resolved.ok) return resolved
        const audioAsset = resolved.asset
        const sessionKey = uuidv7()
        const returnFocus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
          ? document.activeElement
          : document.querySelector<HTMLElement>('[aria-label="Videobook command input"]')
        presentChat(chat, () => setMediaFullscreen(null))
        setTimelinePreview(null)
        void musicRhythm.load()
        setMusicVideoSession({
          key: sessionKey,
          audioArtifactId: audioAsset.artifactId,
          returnFocus,
          setup: { status: 'loading' },
        })
        if (composerDockShouldOpen('action')) setComposerDockOpen(true)
        void prepareMusicVideoSetup(
          sessionKey,
          audioAsset.artifactId,
          sequence, chat,
        ).catch(() => undefined)
        return { ok: true, message: `Music-video editor opened for ${audioAsset.label}` }
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
        return await runSpeakGeneration(action.text, action.voiceId, chat)
      }
      if (command.uiAction === 'open_cold_open') {
        const parsed = parseCommandArgs(resolvedRest, command.params)
        return openColdOpenReview(asString(parsed.asset_ref) ?? undefined, chat)
      }
      if (command.uiAction === 'open_post_dropbox' || command.uiAction === 'open_post_icloud') {
        return openSourceDeliveryReview(rest || undefined, command.uiAction === 'open_post_dropbox' ? 'dropbox' : 'icloud', chat)
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
        openWatermarkReview(target.artifactId, target.label, undefined, chat)
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
      if (advertisedAction && advertisedAction.confirmation !== 'none') {
        await openWorkspaceActions(advertisedAction.id, args, undefined, undefined, chat)
        return { ok: true, message: 'Review the action before running it' }
      }
      const result = await call(command.mcpTool.tool, args, { chat })
      return await completeWorkspaceToolResult(command.mcpTool.tool, result, args, command.command, chat)
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  const executeWorkspaceAction = async (action: WorkspaceAction, values: Record<string, unknown>): Promise<WorkspaceActionResult> => {
    const openedDialog = actionDialog
    if (action.handler.kind !== 'tool') {
      if (action.handler.kind === 'ui' && action.handler.action === 'open_actions') {
        await openWorkspaceActions()
        return { message: 'Actions opened' }
      }
      const uiResult = await executeWorkspaceUiRoute(action, values)
      if (uiResult) {
        if (!uiResult.ok) throw new Error(uiResult.message)
        setActionDialog((current) => current === openedDialog ? null : current)
        return { message: uiResult.message }
      }
      const args = Object.keys(action.inputSchema.properties ?? {}).map((name) => values[name])
        .filter((value) => value !== undefined && value !== null)
        .map((value) => Array.isArray(value) ? value.join(' ') : String(value)).join(' ')
      const input = action.command === '/export-sequence'
        ? `/export-sequence --aspect ${String(values.aspect ?? '16:9')} --captions ${String(values.captions ?? 'burned')}`
        : `${action.command}${args ? ` ${args}` : ''}`
      const result = await executeCommand(input)
      if (!result.ok) throw new Error(result.message)
      setActionDialog((current) => current === openedDialog ? null : current)
      return { message: result.message }
    }
    const tool = action.handler.tool
    if (tool === 'delete_asset' && values.forget === true) {
      const target = assets.find((asset) => asset.artifactId === values.asset_id)
      if (!target) throw new Error('Choose media from the current project.')
      const result = await forgetAsset({ ...target, errorMessage: null, lastUsedAt: null, owningBookId: bookId, owningBookName: activeBook?.name ?? bookId }, true)
      if (!result.ok) throw new Error(result.message)
      setActionDialog(null)
      return { message: result.message }
    }
    if (tool === 'create_book' || tool === 'rename_book' || tool === 'delete_book') {
      const result = tool === 'create_book'
        ? await createBookProject(String(values.name ?? ''))
        : tool === 'rename_book'
          ? await renameBookProject(String(values.book_id ?? bookId), String(values.name ?? ''))
          : await deleteBookProject(String(values.book_id ?? bookId), String(values.confirm_name ?? ''))
      if (!result.ok) throw new Error(result.error)
      return { message: `${action.title} complete` }
    }
    const value = await call(tool, values)
    if (recordValue(value)?.kind === 'chat-action-plan') {
      const result = await previewRoutedChatAction(asChatActionPlan(value), String(values.prompt ?? ''))
      if (!result.ok) throw new Error(result.message)
      setActionDialog(null)
      return { message: result.message }
    }
    if (tool === 'get_notebook' && typeof values.notebook_id === 'string') {
      await refreshBookData(String(values.book_id ?? bookId), values.notebook_id)
      navigate('notebook')
      setActionDialog(null)
      return { message: 'Notebook opened' }
    }
    if (recordValue(value)?.planVersion === 1 && Array.isArray(recordValue(value)?.stages)) {
      const result = await previewCommandPlan(asCommandPlan(value))
      if (!result.ok) throw new Error(result.message)
      setActionDialog(null)
      return { message: result.message }
    }
    const completed = await completeWorkspaceToolResult(tool, value, values, action.title)
    if (!completed.ok) throw new Error(completed.message)
    return { message: completed.message, value }
  }

  const reviewWorkspaceAction = async (action: WorkspaceAction, values: Record<string, unknown>): Promise<WorkspaceActionReview> => {
    if (action.confirmation === 'generation' && action.handler.kind === 'tool') {
      const result = recordValue(await call('estimate_cost', { calls: [{ tool_name: action.handler.tool, input: values }] }))
      const estimate = recordValue(result?.estimate)
      const warnings = Array.isArray(estimate?.warnings) ? estimate.warnings.filter((value): value is string => typeof value === 'string') : []
      const usd = typeof estimate?.usd === 'number' ? estimate.usd : null
      const historical = historicalAverageEstimate(warnings)
      const priced = usd !== null && usd > 0 && (warnings.length === 0 || historical)
      return {
        cost: priced ? `Estimated cost: $${usd.toFixed(4)}` : 'Cost estimate unavailable',
        message: `This action may send your prompt and selected media to a generation provider and incur charges.${warnings.length ? ` ${warnings.join(' ')}` : ''} Confirm to start.`,
      }
    }
    return { message: action.confirmation === 'external'
      ? `${action.title} sends the selected content outside this workspace. Review the destination and content before confirming.`
      : `${action.title} changes or removes the selected content. Review the target and values before confirming.` }
  }

  const runComposerCommand = async (
    input: string,
    context?: ComposerExecuteContext,
    chat?: ChatExecution,
  ): Promise<ComposerOutcome> => {
    if (context?.action) {
      const action = workspaceActions.find(entry => entry.id === context.action?.id)
      if (!action) return { ok: false, message: 'Reload Actions and choose the command again.', nextInput: input }
      if (action.handler.kind === 'ui' && (action.handler.action === 'open_post_dropbox' || action.handler.action === 'open_post_icloud')) {
        const reference = input.trim().slice(action.command.length).trim()
        return openSourceDeliveryReview(reference || undefined, action.handler.action === 'open_post_dropbox' ? 'dropbox' : 'icloud', chat)
      }
      if (action.handler.kind === 'tool' && action.handler.tool === 'transcribe') {
        const command = workspaceActionCommands([action], []).find((entry) => entry.command === action.command)
        const rest = resolveNotebookMentionAliases(input.trim().slice(action.command.length).trim(), gridMentionAssets)
        const parsed = command ? parseCommandArgs(rest, command.params) : {}
        const parsedAsset = asString(parsed.asset_id)?.trim()
        const seededAsset = asString(context.action.values?.asset_id)?.trim()
        return openTranscribeReview({
          assetRef: parsedAsset || seededAsset || undefined,
          languageCode: asString(context.action.values?.language_code) ?? '',
          diarize: typeof context.action.values?.diarize === 'boolean' ? context.action.values.diarize : true,
          tagAudioEvents: typeof context.action.values?.tag_audio_events === 'boolean' ? context.action.values.tag_audio_events : true,
          chat,
        })
      }
      const command = workspaceActionCommands([action], []).find(entry => entry.command === action.command)!
      const rest = resolveNotebookMentionAliases(input.trim().slice(action.command.length).trim(), gridMentionAssets)
      await openWorkspaceActions(action.id, { ...context.action.values, ...parseCommandArgs(rest, command.params) }, undefined, undefined, chat)
      return { ok: true, message: 'Action options opened' }
    }
    const outcome = await executeCommand(input, context, chat)
    if (parsePendingApplyCommand(input) || input.trim().toLowerCase() === '/cancel') {
      voiceOutcomeRef.current?.(pendingCommandVoiceOutcome(input, outcome))
    } else voiceTypedTurnRef.current?.(input, outcome.message)
    return outcome
  }

  const submitFullscreenImageEdit = async (
    session: MediaFullscreenSession,
    input: string,
    selection: ImageEditSelection,
  ): Promise<ComposerOutcome> => {
    const selectedSubjects = (session.subjectMap?.subjects ?? []).filter((subject) =>
      selection.subjectIds.includes(subject.id))
    const references = notebookReferences(input)
    const mentionResult = composerImageReplacementMentions(
      references,
      gridMentionAssets,
    )
    if (!mentionResult.ok) {
      return {
        ok: false,
        message: mentionResult.error,
        nextInput: input,
        selectInput: false,
      }
    }
    if (mentionResult.artifactIds.includes(session.asset.artifactId)) {
      return {
        ok: false,
        message: 'Mention a different image as the replacement.',
        nextInput: input,
        selectInput: false,
      }
    }
    const wantsReplace = mentionResult.artifactIds.length > 0
      || Object.keys(selection.replacements).length > 0
    if (wantsReplace) {
      const targets = imageReplacementTargets(selection.regions, selectedSubjects)
      const merged = mergeRegionReplacements(
        targets,
        selection.replacements,
        mentionResult.artifactIds,
      )
      if (!merged.ok) {
        return {
          ok: false,
          message: merged.error,
          nextInput: input,
          selectInput: false,
        }
      }
      const prompt = stripNotebookMentions(input, references).replace(/\s+/g, ' ').trim()
      const queued = await editFullscreenSubjects(session, {
        operation: 'replace',
        subjectIds: selectedSubjects.map((subject) => subject.id),
        ...(prompt ? { prompt } : {}),
        regions: regionReplacementPayload(targets, merged.replacements),
        ...(selection.model ? { model: selection.model } : {}),
      })
      if (!queued) {
        return {
          ok: false,
          message: 'The image replacement was not queued.',
          nextInput: input,
          selectInput: false,
        }
      }
      return {
        ok: true,
        message: `Region replacement queued for ${targets.length} ${targets.length === 1 ? 'region' : 'regions'}.`,
      }
    }
    if (selection.subjectIds.length === 0 && selection.regions.length === 0) {
      if (!input.trim()) {
        return {
          ok: false,
          message: 'Describe the whole-image edit first.',
          nextInput: input,
          selectInput: false,
        }
      }
      const queued = await editFullscreenSubjects(session, {
        operation: 'whole_image',
        subjectIds: [],
        prompt: input,
        ...(selection.model ? { model: selection.model } : {}),
      })
      if (!queued) {
        return {
          ok: false,
          message: 'The whole-image edit was not queued.',
          nextInput: input,
          selectInput: false,
        }
      }
      return {
        ok: true,
        message: 'Whole-image edit queued.',
      }
    }
    if (selection.subjectIds.length > 0 && session.subjectMap?.status !== 'ready') {
      return {
        ok: false,
        message: session.subjectMap?.status === 'analyzing'
          ? 'Wait for people and object analysis to finish before editing.'
          : 'Analyze the image before editing subjects, or draw a region to edit.',
        nextInput: input,
        selectInput: false,
      }
    }
    const queued = await editFullscreenSubjects(session, {
      operation: 'edit',
      subjectIds: selectedSubjects.map((subject) => subject.id),
      prompt: input,
      ...(selection.regions.length > 0
        ? { editRegions: selection.regions.map((region) => region.box) }
        : {}),
      ...(selection.model ? { model: selection.model } : {}),
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
      message: `Image edit queued for ${selection.regions.length + selectedSubjects.length} selected areas.`,
    }
  }

  const beginComposerTurn = (input: string): ChatExecution => {
    const continuingReview = /^\/(?:apply|cancel)(?:\s|$)/iu.test(input)
      && Boolean(pendingChatAction || pendingCommandPlan || pendingWatermarkReview)
    if (!continuingReview) {
      if (pendingChatAction || pendingCommandPlan || pendingWatermarkReview) dismissPendingCommandPlan()
      selectCanvasCell(null)
      setSourceViewCellId(null)
      setHistoryViewCellId(null)
      setWorkspacePreview(null)
      setActionDialog(null)
      if (mediaFullscreen) closeMediaFullscreen()
      setNoticeState(null)
    }
    return beginChatTurn(input)
  }

  const executeComposerCommand = async (input: string, context?: ComposerExecuteContext): Promise<ComposerOutcome> => {
    const chat = context?.chat ?? (parsePendingApplyCommand(input) || input.trim().toLowerCase() === '/cancel' ? beginChatTurn(input) : undefined)
    chat?.working()
    try {
      const outcome = await runComposerCommand(input, context, chat)
      chat?.finish({ ...outcome, ...(input.trim().toLowerCase() === '/cancel' && outcome.ok ? { status: 'cancelled' as const } : {}) })
      return outcome
    } catch (error) {
      const outcome = { ok: false, message: error instanceof Error ? error.message : String(error) }
      chat?.finish(outcome)
      return outcome
    }
  }

  const setHoveredMediaDropSlot = (slot: NotebookGridSlot | null) => {
    setMediaDropSlot((current) => (
      current?.row === slot?.row && current?.column === slot?.column
        ? current
        : slot
    ))
  }

  /* The grid board is pointer-events:none, so screen points are mapped back
     to a square here rather than read off a DOM target. Returns null for the
     gutters between squares and for squares a cell already occupies. */
  const emptyGridSlotAt = (
    clientX: number,
    clientY: number,
  ): NotebookGridSlot | null => {
    const point = flowRef.current?.screenToFlowPosition({ x: clientX, y: clientY })
    if (!point) return null
    const slot = notebookGridSquareAt(point, notebookMetrics)
    if (!slot) return null
    return notebookOccupiedSlots.some((occupied) =>
      occupied.row === slot.row && occupied.column === slot.column)
      ? null
      : slot
  }

  const openMediaDropSlotAt = (
    clientX: number,
    clientY: number,
  ): NotebookGridSlot | null =>
    busy ? null : emptyGridSlotAt(clientX, clientY)

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
    setActionDiscovery(null)
    setActionComposer(null)
    closeCellContextMenu()
    if (mediaLibraryPicker) closeMediaLibrary()
    showScreen(next)
    if (next === 'jobs' && bookId) {
      void refreshBookData(bookId, notebook?.id).catch((error: unknown) => {
        setNotice(error instanceof Error ? error.message : String(error), 'error')
      })
    }
  }

  const mediaSlotContextValue: MediaSlotContextValue = {
    ready: mcp.state === 'ready',
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
    : mediaLibraryPicker?.cellId === null ? 'all' : null
  const mediaLibraryPanelState: MediaLibraryPanelState | null = mediaLibraryPicker
    ? {
        ...mediaLibraryPicker,
        uploading: mediaLibraryPicker.cellId !== null && mediaSlotStates[mediaLibraryPicker.cellId]?.operation === 'upload',
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
    mediaLibraryRequestRef.current += 1
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
          loading: false,
          loadingMore: false,
          preparingIndex: false,
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
    mediaLibraryRequestRef.current += 1
    const mode = mediaLibraryReference.state.mode
    setMediaLibraryPicker((current) => current && current.cellId === picker.cellId
      ? { ...current, error: null, loading: false, loadingMore: false, preparingIndex: false }
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
    mediaLibraryRequestRef.current += 1
    const mode: ReverseSearchMode = asset.type === 'image'
      ? 'image-reverse'
      : 'video-reverse'
    setMediaLibraryPicker((current) => current && current.cellId === picker.cellId
      ? {
          ...current,
          error: null,
          loading: false,
          loadingMore: false,
          preparingIndex: false,
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
    mediaLibraryRequestRef.current += 1
    mediaLibraryReference.lifecycle.clearReference()
    setMediaLibraryPicker((current) => current ? { ...current, error: null, loading: false, loadingMore: false, preparingIndex: false } : current)
  }
  const repairMediaLibraryIndexes = async () => {
    if (!mediaLibraryPicker || !mediaLibraryKind || mediaLibraryKind === 'audio') return
    const picker = mediaLibraryPicker
    const requestId = ++mediaLibraryRequestRef.current
    setMediaLibraryPicker((current) => current ? { ...current, preparingIndex: true, error: null } : current)
    try {
      const result = await repairSearchIndexes({
        start: () => call('repair_library_search_indexes', { kinds: mediaLibraryKind === 'all' ? ['image', 'video'] : [mediaLibraryKind] }),
        listJobs: (bookId, jobIds) => call('list_jobs', { book_id: bookId, job_ids: jobIds }),
        isCancelled: () => mediaLibraryRequestRef.current !== requestId,
      })
      if (mediaLibraryRequestRef.current !== requestId) return
      const reloadId = mediaLibraryRequestRef.current + 1
      await loadMediaLibrary(picker.cellId, picker.query, 0, false)
      if (mediaLibraryRequestRef.current !== reloadId) return
      const failed = asNumber(result?.failed) ?? 0
      if (failed > 0) {
        const failures = Array.isArray(result?.failures) ? result.failures : []
        const detail = asString(recordValue(failures[0])?.message)
        const message = `Some media could not be indexed.${detail ? ` ${detail}` : ''}`
        setMediaLibraryPicker((current) => current ? { ...current, error: message } : current)
        setNotice(message, 'error')
      } else {
        setNotice(`Indexed ${asNumber(result?.indexed) ?? 0} media assets for Similar search`)
      }
    } catch (error) {
      if (mediaLibraryRequestRef.current !== requestId) return
      const message = error instanceof Error ? error.message : String(error)
      setMediaLibraryPicker((current) => current ? { ...current, preparingIndex: false, error: message } : current)
      setNotice(message, 'error')
    }
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

  /**
   * Applying or lifting a tag term re-runs the search from the first page:
   * an offset into the previous result set means nothing once the filter that
   * produced it has changed.
   */
  const toggleMediaLibraryTagFilter = (term: TagFilterTerm) => {
    if (!mediaLibraryPicker) return
    const next = toggleTagFilter(mediaLibraryPicker.tagFilters, term)
    if (sameTagFilter(next, mediaLibraryPicker.tagFilters)) return
    void loadMediaLibrary(
      mediaLibraryPicker.cellId,
      mediaLibraryPicker.query,
      0,
      false,
      undefined,
      next,
    )
  }

  const clearMediaLibraryTagFilters = () => {
    if (!mediaLibraryPicker || mediaLibraryPicker.tagFilters.length === 0) return
    void loadMediaLibrary(
      mediaLibraryPicker.cellId,
      mediaLibraryPicker.query,
      0,
      false,
      undefined,
      [],
    )
  }

  const loadMediaLibraryTagSuggestions = async (prefix: string) => {
    if (!mediaLibraryPicker || mcp.state !== 'ready') return
    const cellId = mediaLibraryPicker.cellId
    try {
      const response = await call('suggest_asset_tags', {
        book_id: bookId,
        ...(prefix.trim() ? { prefix: prefix.trim() } : {}),
        limit: 20,
      }, { background: true }) as { suggestions?: unknown }
      const suggestions = Array.isArray(response?.suggestions)
        ? response.suggestions.flatMap((entry) => {
            const row = entry as Record<string, unknown>
            return typeof row.facet === 'string'
              && typeof row.key === 'string'
              && typeof row.label === 'string'
              ? [{
                  facet: row.facet as TagFilterTerm['facet'],
                  key: row.key,
                  label: row.label,
                  assets: Number(row.assets) || 0,
                }]
              : []
          })
        : []
      setMediaLibraryPicker((current) => current && current.cellId === cellId
        ? { ...current, tagSuggestions: suggestions }
        : current)
    } catch {
      // Autocomplete never blocks a search someone can still type by hand.
    }
  }

  const openCellInspector = (cellId: string) => {
    if (emptyMediaSlotKind(cellId) && mcp.state === 'ready') {
      openMediaLibrary(cellId)
      return
    }
    selectCanvasCell(cellId)
    setSourceViewCellId(null)
    setHistoryViewCellId(null)
    if (composerDockShouldOpen('selection')) setComposerDockOpen(true)
  }

  const openCellSource = (cellId: string) => {
    selectCanvasCell(cellId)
    setHistoryViewCellId(null)
    setSourceViewCellId(cellId)
    if (composerDockShouldOpen('selection')) setComposerDockOpen(true)
    const cell = notebook?.cells.find((entry) => entry.id === cellId)
    if (cell?.outputArtifactId && !isNotebookGenerationCellType(cell.type)) {
      loadCellHistory(cellId, cell.outputArtifactId)
    }
  }

  /** Non-generation cells show history beside their Dolt row in Source. */
  const openCellHistory = (cellId: string, assetId: string) => {
    const cell = notebook?.cells.find((entry) => entry.id === cellId)
    if (cell && !isNotebookGenerationCellType(cell.type)) {
      openCellSource(cellId)
      return
    }
    selectCanvasCell(cellId)
    setSourceViewCellId(null)
    setHistoryViewCellId(cellId)
    if (composerDockShouldOpen('selection')) setComposerDockOpen(true)
    loadCellHistory(cellId, assetId)
  }

  const loadCellHistory = (cellId: string, assetId: string) => {
    if (!bookId) {
      setHistoryState({
        cellId,
        assetId,
        loading: false,
        error: 'Book is unavailable',
        revisions: [],
      })
      return
    }
    setHistoryState({
      cellId,
      assetId,
      loading: true,
      error: null,
      revisions: [],
    })
    void call('asset_history', {
      asset_id: assetId,
      book_id: bookId,
      limit: 20,
    }, { background: true })
      .then((payload) => {
        const revisions = asCellAssetRevisions(payload)
        setHistoryState((current) =>
          current?.cellId === cellId && current.assetId === assetId
            ? {
                cellId,
                assetId,
                loading: false,
                error: null,
                revisions,
              }
            : current)
      })
      .catch((cause: unknown) => {
        setHistoryState((current) =>
          current?.cellId === cellId && current.assetId === assetId
            ? {
                cellId,
                assetId,
                loading: false,
                error: cause instanceof Error ? cause.message : String(cause),
                revisions: [],
              }
            : current)
      })
  }

  const contextMenuCell = openContextMenuCellId
    ? notebook?.cells.find((cell) => cell.id === openContextMenuCellId) ?? null
    : null
  const contextMenuNode = openContextMenuCellId
    ? presentedNodes.find((node) => node.id === openContextMenuCellId) ?? null
    : null
  const contextMenuSlot = cellContextMenu?.target.kind === 'slot'
    ? cellContextMenu.target.slot
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
    && !notebookOccupiedSlots.some((slot) =>
      slot.row === contextMenuCell.slot.row + 1
      && slot.column === contextMenuCell.slot.column),
  )
  const contextMenuSplitSource = selectedCellId === openContextMenuCellId
    ? selectedSplitSource
    : null
  const contextMenuGenerationTypes = contextMenuCell && notebook && contextMenuCell.type !== 'goal'
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
    if (contextMenuCell.type === 'post') {
      const deliveryDisabled = busy || mcp.state !== 'ready'
      contextMenuActions.push(
        { id: 'save-iphone', label: 'Save to iPhone', icon: 'upload', disabled: deliveryDisabled },
        { id: 'upload-dropbox', label: 'Upload to Dropbox', icon: 'upload', disabled: deliveryDisabled },
      )
    }
    contextMenuActions.push({
      id: 'inspect',
      label: contextMenuCell.type === 'goal' ? 'Open goal' : 'Edit cell',
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
    if (contextMenuVisualAsset && contextMenuCell.type !== 'post' && ['video', 'image', 'final'].includes(contextMenuVisualAsset.type)) {
      contextMenuActions.push({ id: 'create-post', label: 'Create Post', icon: 'inspect', disabled: busy || mcp.state !== 'ready' })
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
      contextMenuActions.push({ id: 'subtitles', label: 'Subtitles', icon: 'subtitles', disabled: busy || mcp.state !== 'ready' || !contextMenuVisualAsset.mediaUrl })
      contextMenuActions.push({ id: 'cold-open', label: 'Edit cold open', icon: 'split', disabled: busy || mcp.state !== 'ready' || !contextMenuVisualAsset.mediaUrl })
      contextMenuActions.push({
        id: 'download',
        label: 'Download video',
        icon: 'download',
        disabled: busy || mcp.state !== 'ready' || !contextMenuVisualAsset.mediaUrl,
      })
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
    if (contextMenuSplitSource) {
      contextMenuActions.push({
        id: 'split',
        label: 'Split video',
        icon: 'split',
        disabled: busy,
      })
    }
  }
  /* Board-wide layout actions an empty square can anchor. Kept separate from
     contextMenuActions because none of the cell actions apply without a cell. */
  const slotContextMenuActions: NotebookCellContextAction[] = []
  if (notebookImageCellIds.size > 0) {
    slotContextMenuActions.push({
      id: 'group_images',
      label: 'Group images here',
      icon: 'group-images',
      disabled: busy,
    })
  }
  const handleSlotContextAction = (actionId: string) => {
    if (!contextMenuSlot) return
    if (actionId === 'group_images') void groupImageCells(contextMenuSlot)
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
      collapseComposerAfterCellCreation()
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
      const updatedNotebook = await refreshBookData(bookId, notebookId)
      openCellInspector(materialized.cellId)
      selectGenerationCellPreview(materialized.cellId, undefined, updatedNotebook)
      revealNotebookCanvasCell(materialized.cellId)
      setNotice(
        `Added ${materialized.cellAddress} ${cellType === 'generate_video' ? 'video' : 'image'} generation from ${materialized.sourceAddresses[0]}`,
      )
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setBusy(false)
    }
  }
  const downloadContextMenuVideo = async () => {
    if (!bookId || busy || mcp.state !== 'ready' || !contextMenuVisualAsset?.mediaUrl) return
    const artifactId = contextMenuVisualAsset.artifactId
    setBusy(true)
    try {
      const message = await performMediaFileAction(call, 'download', bookId, artifactId)
      if (watchScopeRef.current.bookId === bookId) setNotice(message)
    } catch (error) {
      if (watchScopeRef.current.bookId === bookId) {
        setNotice(error instanceof Error ? error.message : String(error), 'error')
      }
    } finally {
      if (watchScopeRef.current.bookId === bookId) setComposerDockOpen(true)
      setBusy(false)
    }
  }
  const handleCellContextAction = (actionId: string) => {
    if (!contextMenuCell) return
    if (actionId === 'save-iphone' || actionId === 'upload-dropbox') {
      const result = openPostDeliveryReview(contextMenuCell.id, actionId === 'upload-dropbox' ? 'dropbox' : 'icloud')
      if (!result.ok) setNotice(result.message, 'error')
      return
    }
    if (actionId === 'create-post') { void createPublication(contextMenuCell.id); return }
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
    if (actionId === 'subtitles' && contextMenuVisualAsset) {
      const result = openSubtitles(contextMenuVisualAsset.artifactId)
      if (!result.ok) setNotice(result.message, 'error')
      return
    }
    if (actionId === 'cold-open' && contextMenuVisualAsset) {
      const result = openColdOpenReview(contextMenuVisualAsset.artifactId)
      if (!result.ok) setNotice(result.message, 'error')
      return
    }
    if (actionId === 'download') {
      void downloadContextMenuVideo()
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
  }
  const deleteContextMenuCell = () => {
    if (contextMenuCell) void deleteNotebookCells([contextMenuCell])
  }
  const repairCell = async (cellId: string) => {
    if (!bookId || !notebook) return
    const cell = notebook.cells.find((candidate) => candidate.id === cellId)
    if (!cell) return
    const producer = mediaGenerationProducer(cell, notebook.cells, notebook.edges)
    const prompt = notebookCellRepairPrompt({
      address: notebookGridTag(cell.slot),
      error: presentedNodes.find((node) => node.id === cellId)?.data.statusError
        ?? 'the provider rejected the request',
      mediaLabel: notebookCellRepairMediaLabel(cell.type),
      producerAddress: producer ? notebookGridTag(producer.slot) : null,
      provider: producer?.provider ?? cell.provider ?? null,
      model: producer?.model ?? cell.model ?? null,
    })
    setComposerDockOpen(true)
    const chat = beginComposerTurn(prompt)
    const outcome = await executeComposerCommand(prompt, { chat })
    if (!outcome.ok) setNotice(outcome.message, 'error')
  }
  const retryCreditFailedCell = async (cellId: string) => {
    if (!bookId || !notebook || busy || mcp.state !== 'ready') return
    const error = presentedNodes.find((node) => node.id === cellId)?.data.statusError
    if (!isGenerationCreditError(error)) return
    const producer = creditRetryProducer(notebook, cellId)
    if (!producer) {
      setNotice('The generator for this failed output is no longer available', 'error')
      return
    }
    await runCell(producer.id, undefined, undefined, cellId)
  }
  const cellActionsContextValue: CellActionsContextValue = {
    ready: !busy && mcp.state === 'ready',
    deleteCell: async (cellId) => {
      const cell = notebook?.cells.find((candidate) => candidate.id === cellId)
      if (cell) await deleteNotebookCells([cell], { confirm: false })
    },
    repairCell,
    retryCell: retryCreditFailedCell,
  }
  const fullscreenImageEditor = mediaFullscreen?.asset.type === 'image'
    ? mediaFullscreen
    : null
  const imageEditMentionAssets = useMemo(() => {
    if (!fullscreenImageEditor) return []
    return commandMentionAssets.filter((asset) =>
      asset.type.toLowerCase() === 'image'
      && asset.artifactId !== fullscreenImageEditor.asset.artifactId)
  }, [commandMentionAssets, fullscreenImageEditor])
  const imageReplacementCandidates = useMemo((): ImageReplacementCandidate[] => (
    imageEditMentionAssets.map((asset) => ({
      artifactId: asset.artifactId,
      address: asset.cellAddress,
      label: asset.cellAddress,
      thumbnailUrl: asset.thumbnailUrl ?? asset.mediaUrl,
    }))
  ), [imageEditMentionAssets])
  const composerSession = fullscreenImageEditor ? `image-edit:${fullscreenImageEditor.key}` : `chat:${bookId}`
  const currentActionComposer = actionComposer?.bookId === bookId && actionComposer.session === composerSession ? actionComposer : null
  const currentActionDiscovery = actionDiscovery?.bookId === bookId && actionDiscovery.session === composerSession ? actionDiscovery : null
  const workspaceChatPreview = workspacePreview?.turnId !== undefined && workspacePreview.turnId === chatTurns.at(-1)?.id
  const temporaryActionComposer = Boolean(currentActionComposer && (workspacePreview || mediaFullscreen))
  const showCommandComposer = !timelinePreviewOpen && !musicVideoSession
  // A spoken decision about the review already on screen. Apply and cancel run
  // the same composer commands the sheet's own buttons do, so the two routes
  // cannot drift; revise changes the prompt and leaves the review open, which
  // is what lets someone shape a generation by voice before paying for it.
  // Every edit lands on one draft and one state write: two settings revised in
  // the same breath would otherwise each start from the draft as it was before
  // the call, and the second would drop the first.
  const applyVoiceReviewEdits = (edits: readonly VoiceReviewEdit[]) => {
    if (!pendingGenerationDraft) return
    let draft = pendingGenerationDraft
    let refreshPreview = false
    for (const edit of edits) {
      if (edit.kind === 'prompt') {
        draft = reviseNotebookChatGenerationPrompt(draft, edit.prompt)
        continue
      }
      if (edit.kind === 'model') {
        const action = pendingGenerationActionOptions.find((candidate) =>
          candidate.id === edit.actionId)
        if (!action) continue
        draft = reviseNotebookChatGenerationAction(
          draft,
          action,
          pendingGenerationConnectedInputs,
        )
        refreshPreview = true
        continue
      }
      draft = reviseNotebookChatGenerationSetting(draft, edit.name, edit.value)
      refreshPreview = true
    }
    setPendingGenerationDraft(draft, refreshPreview)
  }
  const runVoiceReviewCommand = async (
    command: VoiceReviewCommand,
  ): Promise<VoiceOutcome> => {
    const pending: PendingReview = pendingChatAction?.kind === 'generation'
      && pendingGenerationDraft
      ? {
          kind: 'generation',
          action: pendingGenerationDraft.action,
          models: pendingGenerationActionOptions,
        }
      : pendingChatAction?.kind === 'chain-step'
        ? { kind: 'chain-step' }
        : pendingChatAction?.kind === 'transcribe'
          ? { kind: 'transcribe' }
          : pendingChatAction || pendingCommandPlan || pendingWatermarkReview
            ? { kind: 'other' }
            : { kind: 'none' }
    const plan = planVoiceReviewCommand(command, pending)
    if (plan.kind === 'refused') return plan.outcome
    if (plan.kind === 'revise') {
      applyVoiceReviewEdits(plan.edits)
      // The sheet shows every change, so the outcome stays short rather than
      // handing the model its own edit to read back.
      return {
        status: 'review',
        message: 'The review on screen is updated. It is still waiting for apply or cancel.',
      }
    }
    return pendingCommandVoiceOutcome(
      plan.input,
      await executeComposerCommand(plan.input),
    )
  }
  const voice = useVoiceConversation({
    bookId,
    notebookId: notebook?.id,
    scope: composerSession,
    available: showCommandComposer && mcp.state === 'ready' && Boolean(bookId) && !mediaFullscreen && !workspacePreview && !musicVideoSession,
    disabled: busy || Boolean(pendingWatermarkReview || pendingCommandPlan || pendingChatAction),
    onUserTurn: () => {
      if (pendingWatermarkReview || pendingCommandPlan || pendingChatAction) return
      voiceChatRef.current = claimVoiceTurn()
      selectCanvasCell(null)
      setSourceViewCellId(null)
      setHistoryViewCellId(null)
    },
    onAction: async (event, isCurrent) => {
      const chat = voiceChatRef.current ?? claimVoiceTurn()
      const current = () => isCurrent() && chat.isCurrent()
      if (!current()) return { status: 'cancelled', message: 'A newer message replaced this request.' }
      if (busy || pendingChatAction || pendingCommandPlan || pendingWatermarkReview) return { status: 'failed', message: 'Finish the current command or use Apply or Cancel on screen first.' }
      const plan = asChatActionPlan(event.plan)
      if (plan.bookId !== bookId) return { status: 'cancelled', message: 'The project changed. Repeat the command here.' }
      const outcome = await previewRoutedChatAction(plan, event.prompt, current, chat)
      if (!current()) return { status: 'cancelled', message: 'Workspace changed. Check the previous project for accepted work.' }
      setNotice(outcome.message, outcome.ok ? 'info' : 'error')
      return {
        status: !outcome.ok ? 'failed' : outcome.nextInput?.startsWith('/apply') ? 'review' : /queued|started|running|processing/i.test(outcome.message) ? 'queued' : 'completed',
        message: outcome.message,
      }
    },
    onReviewCommand: runVoiceReviewCommand,
  })
  useLayoutEffect(() => {
    voiceOutcomeRef.current = voice.reportOutcome
    voiceTypedTurnRef.current = voice.shareTypedTurn
    voiceActiveRef.current = voice.active
  }, [voice.active, voice.reportOutcome, voice.shareTypedTurn])
  useCommandComposerFocus(
    `${screen}:${bookId}:${notebook?.id ?? ''}`,
    showCommandComposer && mcp.state === 'ready' && !busy && (Boolean(bookId) || Boolean(currentActionComposer)),
  )
  const revealSuccessfulComposerResult = () => {
    if (!mediaFullscreen) revealLatestNotebookResult()
  }

  // One confirm sheet for every pending action. The body varies; the shell,
  // the keyboard model and the footer status slot do not.
  const confirmSheet = (() => {
    if (pendingWatermarkReview) {
      const review = pendingWatermarkReview
      const title = review.includeQr && review.includeHandle
        ? 'Add handle and QR to the video'
        : review.includeQr
          ? 'Add a QR code to the video'
          : 'Add a handle to the video'
      return (
        <ConfirmSheet
          kind="watermark"
          ariaLabel="Watermark review"
          tag="WATERMARK · CHAT"
          title={title}
          address={review.targetLabel}
          effect={{ label: 'Rebuilds playable proxy', tone: 'default' }}
          validation={watermarkValidation({ ...review, handle: review.identities[review.platform].handle })}
          busy={busy}
          applyFormId={COMMAND_COMPOSER_FORM_ID}
          onCancel={dismissPendingCommandPlan}
        >
          <WatermarkBody
            busy={busy}
            state={review}
            onChange={({ handle, ...patch }) => {
              saveWatermarkReviewPreferences(bookId, review.platform, { handle, ...patch })
              setPendingWatermarkReview((current) => {
                if (!current) return current
                return {
                  ...current,
                  ...patch,
                  identities: handle === undefined ? current.identities : {
                    ...current.identities,
                    [current.platform]: { ...current.identities[current.platform], handle },
                  },
                  error: null,
                }
              })
            }}
            onMediaMetadata={(metadata) => setPendingWatermarkReview((current) =>
              current
                ? {
                    ...current,
                    ...(current.durationSeconds === null
                      ? fitWatermarkReviewTiming(current, metadata.durationSeconds)
                      : {}),
                    durationSeconds: metadata.durationSeconds,
                    width: metadata.width,
                    height: metadata.height,
                  }
                : current)}
          />
        </ConfirmSheet>
      )
    }
    if (pendingCommandPlan) {
      const plan = pendingCommandPlan.plan
      const previews = Object.values(pendingCommandPlan.previews)
      const warningCount = previews.reduce(
        (count, preview) => count + preview.warnings.length,
        0,
      )
      const stageCount = `${plan.stages.length} stage${plan.stages.length === 1 ? '' : 's'}`
      const warningLabel = warningCount > 0
        ? ` · ${warningCount} warning${warningCount === 1 ? '' : 's'}`
        : ''
      return (
        <ConfirmSheet
          kind="plan"
          ariaLabel="Command plan review"
          tag={`PLAN · ${plan.sourceSurface.toUpperCase()}`}
          title={plan.summary}
          effect={{
            label: `${stageCount}${warningLabel}`,
            tone: warningCount > 0 ? 'warning' : 'default',
          }}
          validation={commandPlanValidation({ suggestions: plan.suggestions, previews })}
          busy={busy}
          applyFormId={COMMAND_COMPOSER_FORM_ID}
          onCancel={dismissPendingCommandPlan}
          secondaryActions={lastEditActionId
            ? (
                <button
                  type="button"
                  className="confirm-sheet-secondary"
                  disabled={busy}
                  onClick={() => void restoreLastCommandPlan()}
                >
                  <Undo2 size={13} aria-hidden="true" />Restore last edit
                </button>
              )
            : null}
        >
          <CommandPlanBody
            busy={busy}
            plan={plan}
            previews={pendingCommandPlan.previews}
            onToggleSuggestion={(suggestionId) => void toggleCommandSuggestion(suggestionId)}
          />
        </ConfirmSheet>
      )
    }
    if (!pendingChatAction) return null
    if (pendingChatAction.kind === 'subtitles') {
      return <SubtitlesSheet editor={subtitles} applyFormId={COMMAND_COMPOSER_FORM_ID} onClose={dismissPendingCommandPlan} />
    }
    if (pendingChatAction.kind === 'transcribe') {
      const action = pendingChatAction
      const addressByArtifactId = new Map(commandMentionAssets.map((asset) => [asset.artifactId, asset.cellAddress]))
      const choices = transcribeClipChoices(assets, addressByArtifactId)
      const clip = choices.find((choice) => choice.artifactId === action.assetId) ?? null
      const patchTranscribe = (patch: Partial<typeof action>) => {
        setPendingChatAction((current) => current?.kind === 'transcribe' ? { ...current, ...patch } : current)
      }
      return (
        <ConfirmSheet
          kind="transcribe"
          ariaLabel="Transcribe review"
          tag="TRANSCRIBE · CHAT"
          title={clip ? `Transcribe ${clip.label}` : 'Transcribe a clip'}
          address={clip?.label ?? null}
          effect={{ label: 'Queues 1 transcription', tone: 'default' }}
          validation={transcribeValidation({
            assetId: action.assetId,
            languageCode: action.languageCode,
          })}
          busy={busy}
          applyFormId={COMMAND_COMPOSER_FORM_ID}
          onCancel={dismissPendingCommandPlan}
        >
          <TranscribeBody
            busy={busy}
            clip={clip}
            choices={choices}
            languageCode={action.languageCode}
            diarize={action.diarize}
            tagAudioEvents={action.tagAudioEvents}
            estimateUsd={action.estimateUsd}
            estimateLoading={action.estimateLoading}
            estimateUnavailable={action.estimateUnavailable}
            onClipChange={(assetId) => {
              patchTranscribe({
                assetId,
                estimateUsd: null,
                estimateLoading: assetId !== null,
                estimateUnavailable: false,
              })
              if (assetId) queueTranscribeEstimate(assetId, action.languageCode, action.diarize, action.tagAudioEvents)
              else transcribeEstimateRequestRef.current += 1
            }}
            onLanguageChange={(languageCode) => patchTranscribe({ languageCode })}
            onDiarizeChange={(diarize) => {
              patchTranscribe({
                diarize,
                estimateUsd: null,
                estimateLoading: action.assetId !== null,
                estimateUnavailable: false,
              })
              if (action.assetId) queueTranscribeEstimate(action.assetId, action.languageCode, diarize, action.tagAudioEvents)
            }}
            onTagAudioEventsChange={(tagAudioEvents) => {
              patchTranscribe({
                tagAudioEvents,
                estimateUsd: null,
                estimateLoading: action.assetId !== null,
                estimateUnavailable: false,
              })
              if (action.assetId) queueTranscribeEstimate(action.assetId, action.languageCode, action.diarize, tagAudioEvents)
            }}
          />
        </ConfirmSheet>
      )
    }
    if (pendingChatAction.kind === 'generation') {
      const action = pendingChatAction
      const firstSource = pendingGenerationSources[0]
      return (
        <ConfirmSheet
          kind="generation"
          ariaLabel="Generation action review"
          tag="GENERATION · CHAT"
          title={action.summary}
          address={firstSource ? `@${firstSource.address}` : null}
          effect={{ label: 'Queues 1 job · new cell', tone: 'default' }}
          validation={generationValidation({
            prompt: action.draft.cell.prompt,
            previewLoading: action.previewLoading,
            previewError: action.previewError,
            settingsError: insertVideoReviewError(action.draft.action.model, notebookChatGenerationSettings(action.draft), pendingGenerationSources),
            previewStale: action.previewStale,
            promptLeaks: providerPayloadPreviewMentions(action.preview).promptLeaks,
            estimateUnknown: generationEstimate(action.preview).unknown,
          })}
          busy={busy}
          applyFormId={COMMAND_COMPOSER_FORM_ID}
          onCancel={dismissPendingCommandPlan}
        >
          <GenerationBody
            actions={pendingGenerationActionOptions}
            busy={busy}
            draft={action.draft}
            modes={pendingGenerationModeOptions}
            preview={action.preview}
            previewError={action.previewError}
            previewLoading={action.previewLoading}
            previewStale={action.previewStale}
            sources={pendingGenerationSources}
            sourceOptions={pendingGenerationSourceOptions}
            voiceCatalog={elevenLabsVoices}
            promptHistory={pendingGenerationPromptHistory}
            onActionChange={updatePendingGenerationAction}
            onAddSource={addPendingGenerationSource}
            onModeChange={updatePendingGenerationMode}
            onPromptChange={updatePendingGenerationPrompt}
            onRefreshPreview={refreshPendingGenerationPreview}
            onRemoveSource={removePendingGenerationSource}
            onSelectSource={selectPendingGenerationSource}
            onSettingChange={updatePendingGenerationSetting}
          />
        </ConfirmSheet>
      )
    }
    if (pendingChatAction.kind === 'post-delivery') {
      const review = pendingChatAction.review
      const post = notebookPosts.find(item => item.id === review.postId) ?? null
      const postCell = notebook?.cells.find(cell => cell.id === review.postId)
      const postAsset = postCell?.outputArtifactId ? assetById.get(postCell.outputArtifactId) ?? null : null
      const icloud = review.destination === 'icloud'
      return (
        <ConfirmSheet
          kind="post-delivery"
          ariaLabel="Post delivery"
          tag="DELIVER"
          title={icloud ? 'Save to iPhone' : 'Upload to Dropbox'}
          address={post?.address ?? null}
          effect={{ label: icloud ? 'iCloud · shared folder' : 'Leaves workspace · private', tone: icloud ? 'default' : 'warning' }}
          validation={postDeliveryValidation(post, review)}
          busy={busy}
          busyLabel={icloud ? 'Saving to iPhone…' : 'Uploading to Dropbox…'}
          applyLabel="Upload"
          applyFormId={COMMAND_COMPOSER_FORM_ID}
          onCancel={dismissPendingCommandPlan}
        >
          {post && (
            <PostDeliveryBody
              post={post}
              asset={postAsset}
              review={review}
              busy={busy}
              onCopyChange={copy => updatePendingDelivery({ copy })}
              onLanguage={language => choosePostCopyLanguage(post, review, language)}
              onRegen={() => regenPostCopy(post, review)}
              onFolderChange={folder => updatePendingDelivery(icloud ? { icloudFolder: folder } : { dropboxFolder: folder })}
              onDestination={chooseDeliveryDestination}
              onConnect={() => void connectPostDropbox()}
              onCheckConnection={() => void checkPostDropboxConnection()}
              onOpenPost={() => openCellInspector(post.id)}
              onLink={async args => {
                const draftArgs = postReviewDraftArgs(post, review)
                if (draftArgs) await call('update_post', draftArgs)
                await call('link_post', { book_id: review.bookId, post_cell_id: post.id, ...args })
                await refreshBookData(review.bookId, review.notebookId)
                dismissPendingCommandPlan()
              }}
            />
          )}
        </ConfirmSheet>
      )
    }
    if (pendingChatAction.kind === 'cold-open') {
      const review = pendingChatAction.review
      const selection = review.suggestion
      return (
        <ConfirmSheet
          kind="cold-open"
          ariaLabel="Cold-open review"
          tag="COLD OPEN"
          title="Highlight, then the full clip"
          address={review.label}
          effect={{ label: 'New video copy', tone: 'default' }}
          validation={{ blocking: selection ? coldOpenRangeError(selection.startSeconds, selection.endSeconds, selection.durationSeconds) : null, notice: null }}
          busy={busy}
          busyLabel={selection ? 'Creating copy…' : 'Finding highlight…'}
          applyLabel={selection ? 'Create copy' : 'Find highlight'}
          applyFormId={COMMAND_COMPOSER_FORM_ID}
          onCancel={dismissPendingCommandPlan}
        >
          <ColdOpenBody review={review} disabled={busy} onChange={(startSeconds, endSeconds) => setPendingChatAction(current =>
            current?.kind === 'cold-open' && current.review.suggestion
              ? { ...current, review: { ...current.review, requestId: uuidv7(), suggestion: { ...current.review.suggestion, startSeconds, endSeconds } } }
              : current)} />
        </ConfirmSheet>
      )
    }
    if (pendingChatAction.kind === 'split' && pendingSplitReview) {
      const split = pendingSplitReview
      const pieces = splitSegments({
        cutPointsSeconds: split.cutPointsSeconds,
        sourceDurationSeconds: split.sourceDurationSeconds,
      })
      return (
        <ConfirmSheet
          kind="split"
          ariaLabel="Video split review"
          tag="SPLIT VIDEO · CHAT"
          title={splitSelectionTitle({ pieces, selectedIndex: split.selectedIndex })}
          address={split.sourceLabel}
          effect={{
            label: split.outputMode === 'all'
              ? `${pieces.length} new clip${pieces.length === 1 ? '' : 's'} · source preserved`
              : 'New clip · source preserved',
            tone: 'default',
          }}
          validation={splitValidation({
            availableEmptyCells: split.availableEmptyCells,
            cutPointsSeconds: split.cutPointsSeconds,
            outputMode: split.outputMode,
            sourceDurationSeconds: split.sourceDurationSeconds,
          })}
          busy={busy}
          applyLabel="Apply split"
          applyFormId={COMMAND_COMPOSER_FORM_ID}
          hints={(
            <span>
              <kbd>← →</kbd> 0.1s · <kbd>⇧← →</kbd> 1s · <kbd>⌥← →</kbd> 0.01s on the focused bound · <kbd>↵</kbd> apply · <kbd>Esc</kbd> cancel
            </span>
          )}
          onCancel={dismissPendingCommandPlan}
        >
          <SplitBody
            cutPointsSeconds={split.cutPointsSeconds}
            mediaUrl={split.mediaUrl}
            outputMode={split.outputMode}
            selectedIndex={split.selectedIndex}
            sourceDurationSeconds={split.sourceDurationSeconds}
            sourceFps={split.sourceFps}
            onChange={updatePendingSplitSelection}
          />
        </ConfirmSheet>
      )
    }
    if (pendingChatAction.kind === 'routed') {
      const plan = pendingChatAction.plan
      const review = pendingRoutedActionReview
      const source = review?.settings.find((setting) => setting.label === 'Source')?.value
      const tag = `CHAT · ${plan.routedTool.toUpperCase()}`
      if (pendingXPostPreview) {
        return (
          <ConfirmSheet
            kind="post"
            ariaLabel="Chat action review"
            tag={tag}
            title={review?.title ?? 'Post to X'}
            address={pendingXPostPreview.sourceLabel}
            effect={review?.effect ?? null}
            validation={pendingXPostPreview.validation}
            busy={busy}
            busyLabel="Posting…"
            applyLabel="Post to X"
            applyFormId={COMMAND_COMPOSER_FORM_ID}
            onCancel={dismissPendingCommandPlan}
          >
            <PostToXBody
              asset={pendingXPostPreview.asset}
              busy={busy}
              draft={pendingXPostPreview.draft}
              prompt={plan.prompt}
              settings={review?.settings ?? []}
              sourceLabel={pendingXPostPreview.sourceLabel}
              threadReview={pendingChatAction.xPostReview}
              connection={xConnection}
              onChange={updatePendingXPostDraft}
              onConnect={() => void connectX()}
              onThreadOptionsChange={updatePendingXPostThreadOptions}
              onThreadCreditsChange={updatePendingXPostThreadCredits}
              onThreadPromptChange={updatePendingXPostThreadPrompt}
            />
          </ConfirmSheet>
        )
      }
      return (
        <ConfirmSheet
          kind="routed"
          ariaLabel="Chat action review"
          tag={tag}
          title={review?.title ?? plan.summary}
          address={source?.startsWith('@') ? source : null}
          effect={review?.effect ?? null}
          validation={VALID_CONFIRMATION}
          busy={busy}
          applyFormId={COMMAND_COMPOSER_FORM_ID}
          onCancel={dismissPendingCommandPlan}
        >
          <RoutedBody
            prompt={plan.prompt}
            settings={review?.settings ?? []}
            speedPreview={pendingChangeSpeedPreview}
          />
        </ConfirmSheet>
      )
    }
    if (pendingChatAction.kind === 'chain-step') {
      const stepReview = chainStepReview(
        pendingChatAction.review,
        pendingChatAction.remaining,
      )
      return (
        <ConfirmSheet
          kind="routed"
          ariaLabel="Chain step review"
          tag={`CHAIN · ${pendingChatAction.review.tool.toUpperCase()}`}
          title={stepReview.title}
          address={pendingChatAction.review.address}
          effect={stepReview.effect}
          validation={VALID_CONFIRMATION}
          busy={busy}
          applyFormId={COMMAND_COMPOSER_FORM_ID}
          onCancel={dismissPendingCommandPlan}
        >
          <RoutedBody
            prompt={stepReview.postText ?? ''}
            settings={stepReview.settings}
            speedPreview={null}
          />
        </ConfirmSheet>
      )
    }
    const action = pendingChatAction
    const summary = action.kind === 'notebook' ? action.plan.summary : action.summary
    const reason = action.kind === 'notebook' ? action.plan.reason : action.reason
    const stageTitle = action.kind === 'notebook'
      ? `${action.plan.action.kind} notebook cell`
      : action.kind === 'split'
        ? 'Split video'
        : action.command.frameMode === 'time'
          ? `Extract frame at ${action.command.timestampSeconds ?? 0}s`
          : `Extract ${action.command.frameMode} frame`
    const effectLabel = action.kind === 'notebook'
      ? 'Edits the notebook graph'
      : action.kind === 'frame'
        ? 'New image cell'
        : 'New clips · source preserved'
    return (
      <ConfirmSheet
        kind={action.kind}
        ariaLabel="Chat action review"
        tag="NOTEBOOK · CHAT"
        title={summary}
        effect={{ label: effectLabel, tone: 'default' }}
        validation={VALID_CONFIRMATION}
        busy={busy}
        applyFormId={COMMAND_COMPOSER_FORM_ID}
        onCancel={dismissPendingCommandPlan}
      >
        <NotebookActionBody
          kindLabel={action.kind.toUpperCase()}
          reason={reason}
          stageTitle={stageTitle}
        />
      </ConfirmSheet>
    )
  })()

  const workspaceActionContext = useMemo(() => {
    const mediaChoices: ActionChoice[] = assets.map((asset) => {
      const cell = notebook?.cells.find((entry) => entry.outputArtifactId === asset.artifactId)
      return {
        value: asset.artifactId,
        label: cell ? `${notebookGridTag(cell.slot)} · ${asset.label}` : asset.label,
        detail: asset.type,
      }
    })
    const cellChoices: ActionChoice[] = notebook?.cells.map((cell) => ({
      value: cell.id, label: `${notebookGridTag(cell.slot)} · ${cell.label ?? cell.type}`,
    })) ?? []
    const trackChoices: ActionChoice[] = sequence?.tracks.map((track) => ({ value: track.trackId, label: track.name, detail: track.kind })) ?? []
    const clipChoices: ActionChoice[] = sequence?.clips.map((clip) => ({
      value: clip.clipId,
      label: `${clip.source.kind} · frame ${clip.timelineStartFrame}`,
      detail: sequence.tracks.find((track) => track.trackId === clip.trackId)?.name,
    })) ?? []
    const choices: Record<string, readonly ActionChoice[]> = {
      book_id: books.map((book) => ({ value: book.bookId, label: book.name })),
      notebook_id: notebook ? [{ value: notebook.id, label: notebook.name }] : [],
      cell_id: cellChoices, cell: cellChoices, source_cell_id: cellChoices, target_cell_id: cellChoices,
      clip_id: clipChoices, clip_ids: clipChoices, narration_clip_id: clipChoices,
      track_id: trackChoices, track_ids: trackChoices, audio_track_id: trackChoices,
      artifact_id: mediaChoices, artifact_ids: mediaChoices, artifact_ref: mediaChoices,
      asset_id: mediaChoices, asset_ref: mediaChoices, source_artifact_id: mediaChoices,
    }
    for (const kind of ['image', 'audio', 'video'] as const) {
      const selected = mediaChoices.filter((choice) => choice.detail === kind || (kind === 'video' && choice.detail === 'final'))
      choices[`${kind}_ref`] = selected
      choices[`${kind}_refs`] = selected
      choices[`${kind}_artifact_id`] = selected
      choices[`${kind}_asset_id`] = selected
      choices[`${kind}_asset_ids`] = selected
    }
    for (const name of ['source_asset_id', 'target_asset_id', 'first_asset_id', 'second_asset_id', 'additional_asset_ids', 'output_artifact_id', 'replacement_artifact_id', 'expected_output_artifact_id', 'exclude_artifact_ids']) choices[name] = mediaChoices
    for (const name of ['osg_asset_id', 'card_asset_id', 'qr_image_refs', 'character_image_refs', 'first_frame_ref', 'last_frame_ref', 'end_frame_ref']) choices[name] = choices.image_ref!
    choices.motion_video_refs = choices.video_ref!
    choices.layer_asset_id = choices.audio_ref!
    choices.sound_effect_ref = choices.audio_ref!
    choices.source_script_id = mediaChoices.filter((choice) => choice.detail === 'script')
    choices.cell_ids = cellChoices
    choices.audio_id = clipChoices
    choices.outgoing_clip_id = clipChoices
    choices.incoming_clip_id = clipChoices
    choices.source_book_id = choices.book_id!
    choices.target_book_id = choices.book_id!
    choices.edge_id = notebook?.edges.map((edge) => ({ value: edge.id, label: `${cellChoices.find((cell) => cell.value === edge.source)?.label ?? edge.source} → ${cellChoices.find((cell) => cell.value === edge.target)?.label ?? edge.target} · ${edge.targetInput}` })) ?? []
    const context: WorkspaceActionContext = {
      bookId, notebookId: notebook?.id, sequenceId: sequence?.sequenceId, sequenceRevision: sequence?.revision,
      cellId: selectedNotebookCell?.id, assetId: selectedNotebookCell?.outputArtifactId, choices,
      cellIds: selectedNotebookCells.map((cell) => cell.id),
      assetIds: selectedNotebookCells.flatMap((cell) => cell.outputArtifactId ? [cell.outputArtifactId] : []),
      media: Object.fromEntries(assets.map((asset) => [asset.artifactId, { url: asset.mediaUrl, type: asset.type, width: asset.width, height: asset.height, objectHash: asset.objectHash }])),
    }
    return context
  }, [assets, bookId, books, notebook, selectedNotebookCell, selectedNotebookCells, sequence])
  const composerCommands = useMemo(() => pendingWorkspaceCommands(commands, Boolean(pendingCommandPlan || pendingChatAction || pendingWatermarkReview)), [commands, pendingCommandPlan, pendingChatAction, pendingWatermarkReview])
  const openTimelinePreview = (cellId: string, frame = timeline.frame) => {
    if (!sequence) return
    selectCanvasCell(cellId)
    setMusicVideoSession(null)
    void musicRhythm.load()
    timeline.seek(frame)
    setTimelinePreview({
      bookId,
      cellId,
      initialFrame: frame,
      returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    })
  }
  const closeTimelinePreview = () => {
    timeline.closePicker()
    musicRhythm.stop()
    setTimelinePreview(null)
  }
  const timelineContext: TimelineContextValue = {
    sequence,
    assets,
    assembly: timelinePreviewOpen ? { ...timeline, picker: null } : timeline,
    disabled: busy || mcp.state !== 'ready',
    frame: timeline.frame,
    onSeek: openTimelinePreview,
    onPreview: openTimelinePreview,
    onExport: () => { void executeCommand('/export-sequence').then((outcome) => { if (!outcome.ok) setNotice(outcome.message, 'error') }) },
    onRemove: (cellId) => {
      const cell = notebook?.cells.find((candidate) => candidate.id === cellId)
      if (cell) void deleteNotebookCells([cell])
    },
  }
  const selectedMediaLibraryState = mediaLibraryPanelState
    && (mediaLibraryPanelState.cellId === null
      || (selectedNotebookCell?.id === mediaLibraryPanelState.cellId
        && !selectedNotebookCell.outputArtifactId))
    ? mediaLibraryPanelState
    : null
  const mediaLibraryContent = selectedMediaLibraryState && mediaLibraryKind ? (
    <MediaLibraryPanel
      disabled={busy || mcp.state !== 'ready'}
      state={selectedMediaLibraryState}
      kind={mediaLibraryKind}
      accept={mediaLibraryKind === 'all' ? Object.values(mediaFileAccept).join(',') : mediaFileAccept[mediaLibraryKind]}
      targetBookId={bookId}
      onClose={dismissMediaLibrary}
      onMode={changeMediaLibraryMode}
      onDraftQuery={updateMediaLibraryDraft}
      onSearch={searchMediaLibrary}
      onLoadMore={loadMoreMediaLibrary}
      onAttach={(asset) => void attachLibraryAsset(asset)}
      onUpload={(file) => {
        if (selectedMediaLibraryState.cellId) {
          void uploadMediaSlotFile(selectedMediaLibraryState.cellId, file)
          return
        }
        const kind = mediaKindForFile(file)
        if (!kind || !notebook) return
        try {
          const slot = mediaLibraryPicker?.slot ?? nextNotebookCreationSlot(kind, notebook.cells, lastWorkSlot)
          void createMediaCellFromFile(slot, file)
        } catch (error) {
          setNotice(error instanceof Error ? error.message : String(error), 'error')
        }
      }}
      onReferenceFile={(file) => void prepareMediaLibraryFile(file)}
      onClearReference={clearMediaLibraryReference}
      onReferenceStart={mediaLibraryReference.lifecycle.setStartSeconds}
      onReferenceDuration={mediaLibraryReference.lifecycle.setDurationSeconds}
      onSimilar={(asset) => void prepareMediaLibrarySimilar(asset)}
      onRepairIndexes={() => void repairMediaLibraryIndexes()}
      onToggleTagFilter={toggleMediaLibraryTagFilter}
      onClearTagFilters={clearMediaLibraryTagFilters}
      onTagQuery={(prefix) => void loadMediaLibraryTagSuggestions(prefix)}
    />
  ) : null
  const libraryDockContent = selectedMediaLibraryState?.cellId === null && mediaLibraryContent ? (
    <div className="composer-notebook-dock inspector">
      <header>
        <span className="inspector-cell-title"><Library size={15} /><strong>Assets</strong></span>
        <div className="inspector-header-actions"><ComposerDockClose /></div>
      </header>
      {mediaLibraryContent}
    </div>
  ) : null
  const selectedGoal = selectedNotebookCell?.type === 'goal' ? goalTiles.get(selectedNotebookCell.id) ?? null : null
  const goalDockContent = !timelinePreviewOpen && selectedNotebookCell?.type === 'goal' ? (
    selectedGoal ? (
      <GoalPanel
        key={selectedGoal.goalId}
        goal={selectedGoal}
        connected={mcp.state === 'ready'}
        onAction={runGoalAction}
        onPreview={previewGoalSequence}
        onSelectCell={openCellInspector}
        resolveAsset={(artifactId) => assetById.get(artifactId) ?? null}
        onPreviewCell={(cellId) => {
          const cell = notebook?.cells.find((candidate) => candidate.id === cellId)
          const asset = cell?.outputArtifactId ? assetById.get(cell.outputArtifactId) : null
          if (cell && asset) openMediaFullscreen(cell, asset)
        }}
      />
    ) : <GoalPanelPlaceholder />
  ) : null
  const notebookDockContent = libraryDockContent ?? goalDockContent ?? (!timelinePreviewOpen && selectedCell && selectedNotebookCell && selectedNotebookCell.type !== 'timeline' ? (
    <div
      className={[
        'composer-notebook-dock',
        'inspector',
        deletingCellIds.has(selectedCell.id) ? 'inspector-deleting' : '',
      ].filter(Boolean).join(' ')}
    >
      <header>
        <span
          key={selectedCell.id}
          className="inspector-cell-title"
          title={cellTypeLabel(selectedCell.data.kind)}
        >
          <CellIcon kind={selectedCell.data.kind} />
          <strong>{cellTypeLabel(selectedCell.data.kind)}</strong>
          <code className="inspector-cell-address">
            {notebookGridTag(selectedNotebookCell.slot)}
          </code>
          {(selectedGenerationState?.kind === 'queued'
            || selectedGenerationState?.kind === 'generating') && (
            <span className="inspector-generating-badge" role="status">
              {selectedGenerationState.kind === 'queued' ? 'Queued' : 'Generating'}
            </span>
          )}
        </span>
        <div className="inspector-header-actions">
          {selectedNotebookCell.outputArtifactId
            && isNotebookGenerationCellType(selectedNotebookCell.type) && (
            <button
              type="button"
              className={historyViewCellId === selectedCell.id
                ? 'inspector-source-toggle active'
                : 'inspector-source-toggle'}
              title={historyViewCellId === selectedCell.id
                ? 'View cell'
                : 'View history'}
              aria-label={historyViewCellId === selectedCell.id
                ? 'View cell'
                : 'View history'}
              aria-pressed={historyViewCellId === selectedCell.id}
              onClick={() => {
                if (historyViewCellId === selectedCell.id) {
                  setHistoryViewCellId(null)
                  return
                }
                openCellHistory(
                  selectedCell.id,
                  selectedNotebookCell.outputArtifactId!,
                )
              }}
            >
              <History size={15} />
            </button>
          )}
          {!selectedPost && <button
            type="button"
            className={[
              'inspector-source-toggle',
              isNotebookGenerationCellType(selectedNotebookCell.type)
                ? ''
                : 'inspector-source-toggle-labeled',
              sourceViewCellId === selectedCell.id ? 'active' : '',
            ].filter(Boolean).join(' ')}
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
            {isNotebookGenerationCellType(selectedNotebookCell.type)
              ? <Braces size={15} />
              : (
                  <>
                    <Code size={13} aria-hidden="true" />
                    <span>Source</span>
                  </>
                )}
          </button>}
          {selectedNotebookCell.type.startsWith('generate_') && (
            <span className="composer-dock-close-divider" aria-hidden="true" />
          )}
          <div ref={setInspectorActionHost} className="inspector-header-action-host" />
          <ComposerDockClose
            label={selectedNotebookCell.type.startsWith('generate_') ? 'Close' : undefined}
            shortcut={selectedNotebookCell.type.startsWith('generate_')}
            divider={!selectedNotebookCell.type.startsWith('generate_')}
          />
        </div>
      </header>
      {mediaLibraryContent ?? (selectedPost ? (
        <PostInspector key={selectedPost.id} post={selectedPost} cells={notebook?.cells ?? []}
          asset={selectedCell.data.asset} bookId={bookId} call={mcp.state === 'ready' ? call : undefined}
          onRefresh={() => refreshBookData(bookId, notebook?.id)} onSelectCell={openCellInspector}
          onDeliver={destination => {
            const result = openPostDeliveryReview(selectedPost.id, destination)
            if (!result.ok) setNotice(result.message, 'error')
          }}
          onReviewX={reviewPublicationOnX} onDelete={() => void deleteNotebookCells([selectedNotebookCell])} />
      ) : (
        <NotebookCellInspector
          key={`${selectedNotebookCell.id}:${selectedNotebookCell.prompt ?? ''}`}
          headerActionHost={inspectorActionHost}
          notebookId={notebook?.id ?? ''}
          bookId={bookId}
          assetTools={mcp.state === 'ready' ? call : undefined}
          cell={selectedNotebookCell}
          cells={notebook?.cells ?? []}
          edges={notebook?.edges ?? []}
          asset={selectedCell.data.asset}
          cellAssets={notebookCellAssets}
          versionAssets={selectedCellVersionAssets}
          status={selectedCell.data.status}
          error={selectedCellError}
          queuedCellIds={queuedCellIds}
          runErrors={cellRunErrors}
          jobs={inspectorJobViews}
          onCancelJob={cancelJob}
          generationActions={generationActions}
          generationSettingsMemory={(notebook as NotebookSnapshot | null)?.generationSettingsMemory}
          mentionAssets={commandMentionAssets}
          voiceCatalog={elevenLabsVoices}
          busy={busy || Boolean(selectedMediaSlotState?.operation)}
          deleting={deletingCellIds.has(selectedNotebookCell.id)}
          sourceVisible={sourceViewCellId === selectedNotebookCell.id}
          historyVisible={
            historyViewCellId === selectedNotebookCell.id
          }
          history={
            historyState
            && historyState.cellId === selectedNotebookCell.id
            && historyState.assetId === selectedNotebookCell.outputArtifactId
              ? {
                  revisions: historyState.revisions,
                  loading: historyState.loading,
                  error: historyState.error,
                }
              : historyViewCellId === selectedNotebookCell.id
                || (sourceViewCellId === selectedNotebookCell.id
                  && selectedNotebookCell.outputArtifactId)
                ? {
                    revisions: [],
                    loading: true,
                    error: null,
                  }
                : undefined
          }
          onUpdate={updateCell}
          onSetInput={setSelectedCellInput}
          onRun={runCell}
          onDelete={deleteSelectedCell}
          onOpenFullscreen={(asset, mode) => {
            openMediaFullscreen(selectedNotebookCell, asset, undefined, mode)
          }}
          onPreviewPayload={previewGenerationPayload}
          initialGenerationPreview={generationCellPreview?.cellId === selectedNotebookCell.id
            ? generationCellPreview
            : undefined}
          onSelectSource={selectCanvasCell}
          onLoadGenerationPayload={loadGenerationPayload}
          onInspectGenerationRequest={inspectGenerationRequest}
          onDownloadGenerationHar={downloadGenerationHar}
          onOpenSettings={() => navigate('settings')}
          mediaInsightWork={mediaInsightWork}
          onTranscribeAsset={transcribeAsset}
          onLoadTranscriptJson={loadTranscriptJson}
          onDownloadTranscriptSrt={exportTranscriptSrt}
        />
      ))}
    </div>
  ) : null)
  /* Whichever contextual panel is on screen draws the dock's close control in
     its own header row, so the composer only drops its strip once one has. */
  const composerPanelHasHeader = composerPanelDrawsClose({
    musicSession: Boolean(musicVideoSession),
    cellInspector: Boolean(notebookDockContent),
  })
  const composerContextualContent = notebookDockContent || musicVideoSession ? (
    <div
      hidden={Boolean(musicVideoSession)}
      inert={musicVideoSession ? true : undefined}
    >
      {notebookDockContent}
    </div>
  ) : null

  return (
    <main
      className={`app-shell app-screen-${screen} ${mediaFullscreen ? 'media-fullscreen-open' : ''}`}
      onDragEnter={handleAppFileDragEnter}
      onDragLeave={handleAppFileDragLeave}
      onDragOver={handleAppFileDragOver}
      onDropCapture={handleAppFileDropCapture}
      onDrop={handleAppFileDrop}
      onKeyDownCapture={(event) => {
        if (event.defaultPrevented) return
        if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'k' && !event.nativeEvent.isComposing) {
          event.preventDefault()
          event.stopPropagation()
          void openWorkspaceActions()
        }
      }}
    >
      <header className="topbar">
        <div className="topbar-book-controls">
          <div className="brand-project">
            <div className="brand-project-trigger">
              <button
                type="button"
                className="brand-project-home"
                data-composer-focus="return"
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
        </div>
        {screen === 'notebook' && notebook && (
          <NotebookToolbar
            busy={busy || mcp.state !== 'ready'}
            arrangeDisabled={busy || mcp.state !== 'ready' || notebook.cells.length === 0}
            selectedCount={selectedNotebookCells.length}
            activeAddress={selectedNotebookCell ? notebookGridTag(selectedNotebookCell.slot) : null}
            onAdd={createCell}
            onAddDragEnd={() => setPreviewSlot(null)}
            onArrange={autoArrangeNotebook}
            assetsOpen={mediaLibraryPicker?.cellId === null && composerDockOpen}
            assetsDisabled={busy || mcp.state !== 'ready'}
            onAssets={() => openNotebookLibrary()}
            onDeleteSelection={deleteSelectedCells}
            onSelectionActions={() => void openWorkspaceActions(undefined, {
              cell_id: selectedNotebookCell?.id,
              cell_ids: selectedNotebookCells.map((cell) => cell.id),
              artifact_ids: selectedNotebookCells.flatMap((cell) => cell.outputArtifactId ? [cell.outputArtifactId] : []),
            })}
            onClearSelection={() => {
              selectCanvasCell(null)
              setSourceViewCellId(null)
              notebookScrollRef.current?.focus()
            }}
          />
        )}
        <div className="topbar-tools">
          <nav className="header-navigation" aria-label="Workspace navigation">
            {screenNavigation.map((item) => {
              const Icon = item.icon
              return (
                <button key={item.id} type="button" className={screen === item.id ? 'active' : ''} title={item.label} aria-label={`Open ${item.label}`} aria-current={screen === item.id ? 'page' : undefined} onClick={() => navigate(item.id)}>
                  <Icon size={17} />
                </button>
              )
            })}
          </nav>
          <BookUsageCounter
            key={bookId}
            bookName={activeBook?.name ?? ''}
            enabled={!!bookId}
            snapshot={bookUsage.snapshot}
            stale={bookUsage.stale}
            onRetry={bookUsage.retry}
          />
        </div>
      </header>
      {!online && (
        <div className="offline-banner" role="status">
          Offline · local import, search, editing, playback, history, and export remain available
        </div>
      )}
      <>
          {screen === 'notebook' && (
            <>
              <section className="canvas" style={notebookCanvasStyle}>
                {!notebook ? (
                  <div className="canvas-empty-state">
                    <strong>No notebook available</strong>
                    <button type="button" onClick={() => void loadBooks(bookId)}>Reload book</button>
                  </div>
                ) : (
                  <div
                    className="notebook-horizontal-scroll"
                    data-composer-focus="return"
                    ref={notebookScrollRef}
                    tabIndex={0}
                    aria-label="Notebook canvas"
                    onKeyDown={handleNotebookCanvasKeyDown}
                  >
                    <div
                      className="notebook-flow-frame"
                      style={notebookFlowStyle}
                    >
                      <TimelineContext.Provider value={timelineContext}>
                      <MediaSlotContext.Provider value={mediaSlotContextValue}>
                        <CellRunContext.Provider value={runCell}>
                        <CellActionsContext.Provider value={cellActionsContextValue}>
                          <PrimaryCellContext.Provider value={selectedCellId}>
                            <GenerationTitlesContext.Provider value={generationTitleByTool}>
                              <CellContextMenuContext.Provider value={cellContextMenuContextValue}>
                                <GoalTileContext.Provider value={goalTiles}>
                                <GoalMediaContext.Provider value={assetById}>
                                <GoalMarksContext.Provider value={goalMarks}>
                                <ReactFlow<CanvasNode, NotebookFlowEdge>
                          className="notebook-flow"
                      nodes={canvasPresentationNodes}
                      edges={focusedEdges}
                      nodeTypes={nodeTypes}
                      edgeTypes={edgeTypes}
                      viewport={notebookViewport}
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
                          const activeId = selectedCellId && nextSelection.has(selectedCellId)
                            ? selectedCellId
                            : nextId
                          setSelectedCellId(activeId)
                          selectGenerationCellPreview(activeId)
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
                      onNodeClick={(event, node) => {
                        const currentSelection = selectedCellIdsRef.current
                        const nextId = currentSelection.has(node.id)
                          ? node.id
                          : [...currentSelection].at(-1) ?? null
                        setSelectedCellId(nextId)
                        selectGenerationCellPreview(nextId)
                        if (nextId === node.id) {
                          rememberLastWorkSlot(node.data.slot)
                        }
                        setSourceViewCellId(null)
                        if (node.type !== 'timeline' && composerDockShouldOpen('selection')) setComposerDockOpen(true)
                        if (node.type !== 'timeline' && currentSelection.size === 1
                          && nextId === node.id && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
                          revealNotebookCanvasCell(node.id)
                          if (mediaLibraryPicker?.cellId !== node.id) openMediaLibrary(node.id)
                        }
                      }}
                      onPaneClick={() => {
                        closeCellContextMenu()
                        selectCanvasCell(null)
                        setSourceViewCellId(null)
                      }}
                      onPaneContextMenu={(event) => {
                        if (slotContextMenuActions.length === 0) return
                        const slot = emptyGridSlotAt(event.clientX, event.clientY)
                        if (!slot) return
                        event.preventDefault()
                        openSlotContextMenu(
                          slot,
                          { x: event.clientX, y: event.clientY },
                          document.activeElement instanceof HTMLElement
                            ? document.activeElement
                            : null,
                        )
                      }}
                      onNodeDrag={(_event, node) => {
                        closeCellContextMenu()
                        setPreviewSlot(notebookGridSlot(node.position))
                      }}
                      onNodeDragStop={(_event, node, draggedNodes) => {
                        const settledNodes = applyNodeChanges<CanvasNode>(
                          draggedNodes.map(({ id }) => ({
                            id,
                            type: 'position',
                            dragging: false,
                          })),
                          nodes,
                        )
                        const nextNodes = resolveNotebookGridGroupMove(
                          settledNodes,
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
                      isValidConnection={(connection) => notebook
                        ? isValidNotebookFlowConnection(notebook.edges, connection, notebook.cells)
                        : false}
                      onConnect={(connection) => void connectCells(connection)}
                      onDrop={handleNotebookFlowDrop}
                      onDragLeave={handleNotebookFlowDragLeave}
                      onDragOver={handleNotebookFlowDragOver}
                      minZoom={notebookZoom}
                      maxZoom={notebookZoom}
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
                      zoomOnPinch={false}
                      zoomActivationKeyCode={null}
                      zoomOnDoubleClick={false}
                      preventScrolling={false}
                      deleteKeyCode={null}
                      proOptions={flowProOptions}
                    >
                            <NotebookGridBoard
                              sections={notebookLaneSections}
                              metrics={notebookMetrics}
                              occupiedSlots={notebookOccupiedSlots}
                              previewSlot={previewSlot}
                              mediaDropActive={mediaDropActive && !busy}
                              mediaDropSlot={mediaDropSlot}
                              reviewRoles={pendingReviewRoles}
                            />
                            {nodes.length === 0 && (
                              <NotebookStartTiles
                                busy={busy || mcp.state !== 'ready'}
                                compact={notebookGridDetailScale(notebookZoom) > 1.8}
                                dimmed={mediaDropActive || previewSlot !== null}
                                onUpload={(slot, file) => void createMediaCellFromFile(slot, file)}
                                onPick={(kind, slot) => void createCell(kind, notebookGridPosition(slot))}
                                onDownload={downloadClipToSlot}
                                onBrowseLibrary={openNotebookLibrary}
                              />
                            )}
                                </ReactFlow>
                                </GoalMarksContext.Provider>
                                </GoalMediaContext.Provider>
                                </GoalTileContext.Provider>
                              </CellContextMenuContext.Provider>
                            </GenerationTitlesContext.Provider>
                          </PrimaryCellContext.Provider>
                        </CellActionsContext.Provider>
                        </CellRunContext.Provider>
                      </MediaSlotContext.Provider>
                      </TimelineContext.Provider>
                    </div>
                  </div>
                )}
              </section>
            </>
          )}

          {screen === 'jobs' && (
            <JobsScreen
              bookName={activeBook?.name ?? null}
              jobs={jobs}
              plans={generationPlans}
              assets={assets}
              cells={notebook?.cells ?? EMPTY_NOTEBOOK_CELLS}
              now={jobSnapshotAt}
              busy={busy}
              onRefresh={() => bookId && void refreshBookData(bookId, notebook?.id)}
              onCancelJob={(jobId) => void cancelJob(jobId)}
              onRetryJob={(jobId) => void retryJob(jobId)}
              onContinuePlan={(planId) => {
                const plan = generationPlans.find((candidate) => candidate.planId === planId)
                if (plan) void continueGenerationPlan(plan)
              }}
              onRevisePlan={(planId, action) => {
                const plan = generationPlans.find((candidate) => candidate.planId === planId)
                if (plan) void reviseGenerationPlan(plan, action)
              }}
            />
          )}

          {screen === 'settings' && (
            <SettingsScreen
              call={mcp.state === 'ready' ? call : undefined}
              providers={providers}
              loading={settingsLoading}
              error={settingsError}
              refreshed={settingsRefreshed}
              storage={storage}
              bookId={bookId}
              bookName={activeBook?.name ?? null}
              connection={xConnection}
              busy={busy || mcp.state !== 'ready'}
              onRefresh={refreshSettings}
              onSave={storeSecret}
              onConnect={() => void connectX()}
            />
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

      {cellContextMenu && contextMenuSlot && slotContextMenuActions.length > 0 && (
        <NotebookCellContextMenu
          actions={slotContextMenuActions}
          address={notebookGridTag(contextMenuSlot)}
          cellType="EMPTY"
          menuId={slotContextMenuId(contextMenuSlot)}
          menuLabel={`Slot actions for ${notebookGridTag(contextMenuSlot)}`}
          position={cellContextMenu.position}
          returnFocus={cellContextMenu.returnFocus}
          onAction={handleSlotContextAction}
          onClose={closeCellContextMenu}
        />
      )}

      {musicVideoSession && sequence && (
        <Suspense fallback={<div role="status">Loading music-video editor…</div>}>
          <MusicVideoEditor
            key={musicVideoSession.key}
            assembly={timeline}
            rhythm={musicRhythm}
            onFrameUpdate={timeline.seek}
            onExport={() => { closeMusicVideoEditor(); timelineContext.onExport() }}
            sequence={sequence}
            assets={assets}
            audioArtifactId={musicVideoSession.audioArtifactId}
            setup={musicVideoSession.setup}
            returnFocus={musicVideoSession.returnFocus}
            onApplySetup={applyMusicVideoSetup}
            onClose={() => { musicRhythm.stop(); closeMusicVideoEditor() }}
            onCommit={commitMusicVideoEdit}
            onPlanDraft={planMusicDraft}
            onApplyDraft={applyMusicDraft}
            onCreateTrack={createMusicVideoTrack}
            onRefreshAssets={async () => {
              if (!bookId) throw new Error('Load or create a book first.')
              await refreshBookData(bookId, notebook?.id)
            }}
            onRestore={restoreMusicVideoRevision}
            onReviewSetup={(nextSequence) => prepareMusicVideoSetup(
              musicVideoSession.key,
              musicVideoSession.audioArtifactId,
              nextSequence ?? sequence,
            )}
          />
        </Suspense>
      )}

      {timelinePreviewOpen && timelinePreview && timelinePreviewCell && sequence && (
        <Suspense fallback={<div role="status">Opening timeline preview…</div>}>
          <MusicVideoEditor
            key={`${bookId}:${timelinePreviewCell.id}`}
            sequence={sequence}
            assets={assets}
            assembly={timeline}
            rhythm={musicRhythm}
            setup={{ status: 'timeline' }}
            address={notebookGridTag(timelinePreviewCell.slot)}
            initialFrame={timelinePreview.initialFrame}
            returnFocus={timelinePreview.returnFocus}
            onFrameUpdate={timeline.seek}
            onExport={() => { closeTimelinePreview(); timelineContext.onExport() }}
            onClose={closeTimelinePreview}
            onApplySetup={applyMusicVideoSetup}
            onCommit={commitMusicVideoEdit}
            onPlanDraft={planMusicDraft}
            onApplyDraft={applyMusicDraft}
            onCreateTrack={createMusicVideoTrack}
            onRefreshAssets={async () => { await refreshBookData(bookId, notebook?.id) }}
            onRestore={restoreMusicVideoRevision}
            onReviewSetup={async () => { await musicRhythm.load() }}
          />
        </Suspense>
      )}

      {mediaFullscreen && (
        <NotebookMediaFullscreen
          key={mediaFullscreen.key}
          asset={mediaFullscreen.asset}
          address={mediaFullscreen.address}
          initialMode={mediaFullscreen.mode}
          initialInstruction={mediaFullscreen.initialInstruction}
          onInstructionChange={(instruction) => {
            imageEditInstructionsRef.current.set(mediaFullscreen.bookId, instruction)
            saveValue(`videobook.image-edit-instruction:${mediaFullscreen.bookId}`, instruction)
          }}
          composerPortalRef={setMediaFullscreenComposerTarget}
          actionsOpen={Boolean(currentActionComposer)}
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
          imageEditModels={imageEditModels.models}
          imageEditModelsLoading={imageEditModels.loading}
          defaultImageEditModelId={imageEditModels.defaultModelId}
          onEstimateImageEditCost={estimateImageEditCost}
          onEditSubjects={(input) =>
            editFullscreenSubjects(mediaFullscreen, input)}
          onSubmitEditInstruction={(instruction, selection) =>
            submitFullscreenImageEdit(mediaFullscreen, instruction, selection)}
          onClose={closeMediaFullscreen}
        />
      )}

      <input ref={actionUploadRef} type="file" multiple hidden aria-label="Import files from actions" onChange={upload} />
      {workspacePreview && <WorkspacePreviewDialog media={workspacePreview.media}
        sequence={workspacePreview.media ? undefined : sequence ?? undefined}
        assets={assets.flatMap((asset) => asset.mediaUrl ? [{ artifactId: asset.artifactId, mediaUrl: asset.mediaUrl }] : [])}
        opener={workspacePreview.opener} initialFrame={workspacePreview.initialFrame}
        composerPortalRef={setPreviewComposerTarget} actionsOpen={Boolean(currentActionComposer || workspaceChatPreview)}
        onClose={() => { setWorkspacePreview(null); setActionDiscovery(null); setActionComposer(null) }}
        onActions={() => void openWorkspaceActions(undefined, workspacePreview.media ? { asset_id: workspacePreview.media.assetId } : undefined)} />}
      {actionDialog?.actionId && <WorkspaceActionsDialog key={actionDialog.key} actions={workspaceActions} context={{
        ...workspaceActionContext,
        entities: actionDialog.resources?.entities,
        choices: { ...workspaceActionContext.choices, ...actionDialog.resources?.choices },
      }}
        initialActionId={actionDialog.actionId} initialValues={actionDialog.values}
        initialResult={actionDialog.result}
        returnFocus={actionDialog.opener} loading={actionCatalogStatus.loading} error={actionCatalogStatus.error}
        onClose={() => { actionCatalogRequestRef.current += 1; setActionDialog(null) }}
        onBack={() => void openWorkspaceActions(undefined, actionDialog.values, actionDialog.query, actionDialog.opener)}
        onOpenAction={(actionId, values) => void openWorkspaceActions(actionId, { ...actionDialog.values, ...values })}
        onExecute={executeWorkspaceAction} onReview={reviewWorkspaceAction} />}

      <CommandComposer
        chatTurns={chatTurns}
        goalEvents={goalEvents}
        previewTurnId={previewTurnId}
        connected={mcp.state === 'ready' && online}
        onBeginTurn={beginComposerTurn}
        onCommandRowHeightChange={setCommandRowHeight}
        onHeightChange={setComposerHeight}
        hidden={!showCommandComposer}
        dockOpen={composerDockOpen && screen !== 'settings'}
        onDockOpenChange={setComposerDockOpen}
        contextualContent={composerContextualContent}
        contextualHasHeader={composerPanelHasHeader}
        goalStatus={activeComposerGoal ? (
          <GoalComposerStatus
            goal={activeComposerGoal}
            disabled={mcp.state !== 'ready'}
            onOpen={() => openGoalTile(activeComposerGoal.cellId)}
          />
        ) : null}
        commands={composerCommands}
        references={composerReferenceMap}
        actions={workspaceActions}
        actionContext={workspaceActionContext}
        actionDiscovery={currentActionDiscovery}
        actionStatus={actionCatalogStatus}
        actionsDisabled={busy || mcp.state !== 'ready'}
        onOpenActions={() => void openWorkspaceActions()}
        onCloseActionSearch={prepared => {
          setActionDiscovery(null)
          if (!prepared && temporaryActionComposer) dismissActionComposer()
        }}
        onDismissComposer={temporaryActionComposer ? dismissActionComposer : undefined}
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
        mcpCalls={mcpCalls}
        mcpFlash={mcpFlash}
        onToggleMcpCall={handleToggleMcpCall}
        selectedModel={chatModel}
        inputSession={composerSession}
        portalTarget={workspacePreview && (currentActionComposer || workspaceChatPreview) ? previewComposerTarget
          : mediaFullscreen && currentActionComposer ? mediaFullscreenComposerTarget : null}
        pendingInput={pendingWatermarkReview
            ? '/apply'
            : pendingChatAction?.kind === 'generation' || pendingChatAction?.kind === 'transcribe'
            ? '/apply '
            : pendingCommandPlan || pendingChatAction
              ? '/apply'
              : undefined}
        replacePendingInput={pendingChatAction?.kind === 'transcribe'}
        notice={notice
          ? { message: notice.text, tone: notice.tone }
          : null}
        outcomeSlot={confirmSheet ? 'sheet' : 'composer'}
        onEnsureCatalog={refreshComposerCatalog}
        onDismissNotice={() => setNoticeState(null)}
        onDismissPanel={(
          pendingWatermarkReview
          || pendingCommandPlan
          || pendingChatAction
        )
          ? dismissPendingCommandPlan
          : undefined}
        onExecute={executeComposerCommand}
        voiceCatalog={elevenLabsVoices}
        voice={voice}
        onStartVoice={() => {
          selectCanvasCell(null)
          closeCellContextMenu()
          setActionComposer(null)
          setSourceViewCellId(null)
          setHistoryViewCellId(null)
        }}
        onModelChange={changeChatModel}
        onSuccessfulExecute={revealSuccessfulComposerResult}
      >
        {confirmSheet}
      </CommandComposer>
    </main>
  )
}

export default App
