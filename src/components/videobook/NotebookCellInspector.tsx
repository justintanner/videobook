import {
  ArrowRight,
  Ban,
  Braces,
  Captions,
  Check,
  ChevronDown,
  CircleAlert,
  CircleX,
  Copy,
  History,
  Layers2,
  Maximize2,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  X,
} from 'lucide-react'
import {
  Fragment,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { useGenerationPreviewRefresh } from '@/videobook/useGenerationPreviewRefresh'
import type { MediaFullscreenMode } from '@/videobook/image-editor-copy'
import type { CSSProperties } from 'react'
import type {
  GenerationStatus,
  NotebookCell,
  NotebookCellExecution,
  NotebookEdge,
} from 'videobook-engine'
import { ArtifactThumb } from './ArtifactThumb'
import { CellWaveform, CellWaveformSkeleton } from './CellWaveform'
import { MediaLibraryAssetPreview } from './MediaLibraryAssetPreview'
import type { ElevenLabsVoicesState } from '@/videobook/use-elevenlabs-voices'
import {
  notebookGridAddress,
  notebookGridTag,
} from 'videobook-engine/notebook-grid'
import {
  doltCellDisplayValue,
  doltCellRows,
} from '@/videobook/dolt-cell-source'
import {
  formatMediaTime,
  notebookAnalysisLlmExchanges,
  notebookCellActionPresentation,
  notebookCellInspectorActionLabel,
  notebookCellIsActiveStatus,
  notebookOutputVersionArtifactIds,
  type NotebookAnalysisInfo,
  type NotebookAnalysisLlmExchange,
  type NotebookAnalysisResponseFormat,
  type NotebookAudioInfo,
} from '@/videobook/notebook-cell-presentation'
import {
  mediaDockAspect,
  mediaDockFacts,
  mediaDockKind,
  mediaDockKindLabel,
  type MediaDockKind,
} from '@/videobook/media-dock'
import {
  mediaCellGenerationState,
  mediaGenerationProducer,
  type MediaCellGenerationState,
} from '@/videobook/media-cell-generation-state'
import type { NotebookRunJobView } from '@/videobook/notebook-run-watch'
import {
  persistAndRunNotebookCell,
  type NotebookCellUpdate,
} from '@/videobook/notebook-cell-actions'
import {
  generationInputMentionRows,
  mentionMenuRows,
  type AssetMentionCandidate,
} from '@/videobook/mention-suggestions'
import { generationInputMentions } from '../../../server/src/generation-input-mentions'
import {
  providerPayloadPreviewMentions,
} from '@/videobook/provider-payload-preview'
import {
  abbreviateGenerationPhrases,
  compatibleGenerationActions,
  compatibleGenerationModes,
  effectiveGenerationControlValue,
  effectiveGenerationSettings,
  generationActionForSelection,
  generationActionIsCompatible,
  generationConnectedInputs,
  generationInputAttachments,
  generationModeIsCompatible,
  generationSelectionForAction,
  initialGenerationSelection,
  initialGenerationMode,
  type GenerationControl,
  type GenerationControlValue,
  type GenerationInputAttachment,
  type GenerationPreviewDraft,
  type GenerationSelection,
  type NotebookGenerationAction,
} from '@/videobook/notebook-generation-actions'
import { isNotebookGenerationCellType } from '@/videobook/notebook-cell-types'
import { GenerationBody, type GenerationReviewSource } from './confirm/bodies/GenerationBody'
import { useConfirmSheetKeys } from './confirm/useConfirmSheetKeys'
import { ComposerDockContext } from './composer-dock-context'
import type { GenerationCellPreview } from '@/videobook/use-generation-cell-preview'
import { NotebookMediaMetadata } from './NotebookMediaMetadata'
import { PublishedPostInspectorDetails } from './PublishedPostChrome'
import { MediaInsightsPanel } from './MediaInsightsPanel'
import { AssetTagEditor } from './AssetTagEditor'
import { useAssetTags } from '@/videobook/use-asset-tags'
import type { AssetTags } from '@/videobook/asset-tags'
import type { TagEdit } from '@/videobook/asset-tag-editing'
import {
  idleMediaInsightWork,
  mediaCellHasSpokenAudio,
  type MediaInsightWork,
  type MediaTranscriptSources,
  type MediaVisionAnalysis,
  type TranscriptSidecarSource,
} from '@/videobook/media-insights'
import {
  notebookConnectionEdges,
  notebookCyclicInputMentionValues,
} from '@/videobook/notebook-graph'
import { RichJson } from './RichJson'
import {
  AutocompleteDropdown,
  type AutocompleteItem,
} from '@/components/ui/AutocompleteDropdown'

const actionCellTypes = new Set<NotebookCell['type']>([
  'extract_audio',
  'split_video',
  'prompt',
  'analyze',
  'concat',
  'splice',
])

function isActionCellType(
  type: NotebookCell['type'],
): boolean {
  return actionCellTypes.has(type)
}

type CellFormDraft = {
  prompt: string
  provider: string
  model: string
  operation: string
  tool: string
  startSeconds: string
  endSeconds: string
  overlap: string
  frameMode: 'first' | 'time' | 'last'
  timestampSeconds: string
  generationMode: string
  generationSettings: Record<string, GenerationControlValue>
}

const cellFormDraftFields = [
  'prompt',
  'provider',
  'model',
  'operation',
  'tool',
  'startSeconds',
  'endSeconds',
  'overlap',
  'frameMode',
  'timestampSeconds',
  'generationMode',
] as const satisfies readonly (keyof CellFormDraft)[]

function draftNumber(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? String(value)
    : '0'
}

function persistedGenerationSettings(
  cell: NotebookCell,
  controls: readonly GenerationControl[] = [],
): Record<string, GenerationControlValue> {
  const value = cell.inputs?.generationSettings
  const nested = !value || typeof value !== 'object' || Array.isArray(value)
    ? {}
    : Object.fromEntries(Object.entries(value).filter((entry): entry is [
        string,
        GenerationControlValue,
      ] => {
        const setting = entry[1]
        return typeof setting === 'string'
          || typeof setting === 'number'
          || typeof setting === 'boolean'
      }))
  const legacy = Object.fromEntries(controls.flatMap((control) => {
    const setting = cell.inputs?.[control.name]
    return typeof setting === 'string'
      || typeof setting === 'number'
      || typeof setting === 'boolean'
      ? [[control.name, setting] as const]
      : []
  }))
  return { ...legacy, ...nested }
}

function persistedCellFormDraft(
  cell: NotebookCell,
  controls: readonly GenerationControl[] = [],
): CellFormDraft {
  const configuredFrameMode = cell.inputs?.frameMode
  return {
    prompt: cell.prompt ?? '',
    provider: cell.provider ?? '',
    model: cell.model ?? '',
    operation: cell.operation ?? '',
    tool: cell.tool ?? '',
    startSeconds: draftNumber(cell.inputs?.startSeconds),
    endSeconds: draftNumber(cell.inputs?.endSeconds),
    overlap: draftNumber(cell.inputs?.overlap),
    frameMode: configuredFrameMode === 'time' || configuredFrameMode === 'last'
      ? configuredFrameMode
      : 'first',
    timestampSeconds: draftNumber(cell.inputs?.timestampSeconds),
    generationMode: typeof cell.inputs?.generationMode === 'string'
      ? cell.inputs.generationMode
      : '',
    generationSettings: persistedGenerationSettings(cell, controls),
  }
}

function cellFormDraft(
  cell: NotebookCell,
  actions: readonly NotebookGenerationAction[],
  inputs: Parameters<typeof initialGenerationSelection>[2] = [],
): CellFormDraft {
  const selection = initialGenerationSelection(cell, actions, inputs)
  if (!selection || !isNotebookGenerationCellType(cell.type)) {
    return persistedCellFormDraft(cell)
  }
  const action = generationActionForSelection(actions, cell.type, selection)
  const draft = persistedCellFormDraft(cell, action?.controls)
  return { ...draft, ...selection }
}

function cellFormIsDirty(
  cell: NotebookCell,
  draft: CellFormDraft,
  controls: readonly GenerationControl[] = [],
): boolean {
  const persisted = persistedCellFormDraft(cell, controls)
  return cellFormDraftFields.some((field) => draft[field] !== persisted[field])
    || JSON.stringify(draft.generationSettings)
      !== JSON.stringify(persisted.generationSettings)
}

function validTimingValue(value: string): boolean {
  if (!value.trim()) return false
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0
}

function cellFormIsValid(cell: NotebookCell, draft: CellFormDraft): boolean {
  if (isNotebookGenerationCellType(cell.type)) {
    return Boolean(
      draft.provider.trim()
      && draft.model.trim()
      && draft.operation.trim()
      && draft.tool.trim(),
    )
  }
  if (cell.type === 'split_video') {
    return validTimingValue(draft.startSeconds)
      && validTimingValue(draft.endSeconds)
  }
  if (cell.type === 'splice' && draft.operation === 'splice_video') {
    return validTimingValue(draft.overlap)
  }
  return true
}

function generationInputsForDraft(
  cell: NotebookCell,
  draft: CellFormDraft,
  controls: readonly GenerationControl[] = [],
): Record<string, unknown> {
  const inputs = { ...(cell.inputs ?? {}) }
  delete inputs.generationMode
  delete inputs.generationSettings
  for (const control of controls) delete inputs[control.name]
  return {
    ...inputs,
    ...(draft.generationMode
      ? { generationMode: draft.generationMode }
      : {}),
    ...(Object.keys(draft.generationSettings).length > 0
      ? { generationSettings: draft.generationSettings }
      : {}),
  }
}

function generationControlIsValid(
  control: GenerationControl,
  settings: Record<string, GenerationControlValue>,
): boolean {
  const value = effectiveGenerationControlValue(control, settings)
  if (value === undefined || value === '') return !control.required
  if (
    control.options.length > 0
    && !control.options.some((option) => option === value)
  ) return false
  if (control.valueType === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false
    if (control.minimum !== undefined && value < control.minimum) return false
    if (control.maximum !== undefined && value > control.maximum) return false
  }
  return typeof value === control.valueType
}

function generationControlsAreValid(
  controls: readonly GenerationControl[],
  settings: Record<string, GenerationControlValue>,
): boolean {
  return controls.every((control) =>
    generationControlIsValid(control, settings))
}

function cellFormPatch(
  cell: NotebookCell,
  draft: CellFormDraft,
  controls: readonly GenerationControl[] = [],
  controlsToClear: readonly GenerationControl[] = controls,
): Record<string, unknown> {
  const persisted = persistedCellFormDraft(cell, controls)
  const patch: Record<string, unknown> = {}
  if (draft.prompt !== persisted.prompt) patch.prompt = draft.prompt
  if (!isActionCellType(cell.type)) {
    if (draft.provider !== persisted.provider) {
      patch.provider = draft.provider || undefined
    }
    if (draft.model !== persisted.model) patch.model = draft.model || undefined
    if (draft.operation !== persisted.operation) {
      patch.operation = draft.operation || undefined
    }
    if (draft.tool !== persisted.tool) patch.tool = draft.tool || undefined
  }
  if (
    isNotebookGenerationCellType(cell.type)
    && (
      draft.generationMode !== persisted.generationMode
      || JSON.stringify(draft.generationSettings)
        !== JSON.stringify(persisted.generationSettings)
    )
  ) {
    patch.inputs = generationInputsForDraft(cell, draft, controlsToClear)
  }
  if (
    cell.type === 'split_video'
    && (
      draft.startSeconds !== persisted.startSeconds
      || draft.endSeconds !== persisted.endSeconds
    )
  ) {
    patch.inputs = {
      ...(cell.inputs ?? {}),
      startSeconds: Number(draft.startSeconds),
      endSeconds: Number(draft.endSeconds),
    }
  }
  if (
    cell.type === 'splice'
    && draft.operation === 'splice_video'
    && draft.overlap !== persisted.overlap
  ) {
    patch.inputs = {
      ...(cell.inputs ?? {}),
      overlap: Number(draft.overlap),
    }
  }
  return patch
}

export type NotebookCellInspectorAsset = {
  artifactId: string
  id: string
  objectHash?: string | null
  type: string
  mediaUrl: string | null
  thumbnailUrl: string | null
  width: number | null
  height: number | null
  duration: number | null
  audioInfo: NotebookAudioInfo | null
  /** Peaks for an audio poster; null before `extract_waveform` has run. */
  waveform?: number[] | null
  analysisInfo?: NotebookAnalysisInfo | null
  transcript?: MediaTranscriptSources | null
  visionAnalysis?: MediaVisionAnalysis | null
  tags?: AssetTags | null
}

type CellGenerationTransition = {
  status: GenerationStatus
  commitHash: string
  commitDate: string
}

export type CellGenerationAttempt = {
  attemptId: string
  status: GenerationStatus
  runId: string | null
  tool: string
  provider: string | null
  model: string | null
  prompt: string | null
  resolvedPrompt: string | null
  artifactId: string | null
  providerArtifactId: string | null
  error: string | null
  mediaUrl: string | null
  thumbnailUrl: string | null
  payloadAvailable: boolean
  payload?: unknown
  commandPlan: unknown
  transitions: readonly CellGenerationTransition[]
  createdAt: number
  updatedAt: number
}

export type CellAssetRevision = {
  hash: string
  message: string
  date: string
  author?: string
  operation?: string
}

type NotebookCellInspectorProps = {
  headerActionHost?: HTMLElement | null
  notebookId: string
  /** Book that owns the inspected asset; tag edits are scoped to it. */
  bookId: string
  /**
   * Tag tools, or undefined while the MCP connection is not ready. The
   * inspector talks to them through useAssetTags rather than receiving one
   * callback per operation.
   */
  tagTools?: (
    tool: string,
    args: Record<string, unknown>,
    options?: { background?: boolean },
  ) => Promise<unknown>
  cell: NotebookCell
  cells: NotebookCell[]
  edges: NotebookEdge[]
  asset: NotebookCellInspectorAsset | undefined
  cellAssets?: ReadonlyMap<string, NotebookCellInspectorAsset>
  versionAssets?: readonly NotebookCellInspectorAsset[]
  status: string
  error: string | null
  busy: boolean
  deleting: boolean
  /** Cell ids with an accepted-but-unstarted run; drives generating docks. */
  queuedCellIds?: ReadonlySet<string>
  /** Live run error messages by cell id; drives failed generation docks. */
  runErrors?: Readonly<Record<string, string>>
  /** Persistent job snapshot, already narrowed for run watching. */
  jobs?: readonly NotebookRunJobView[]
  /** Cancel a queued or running job by its numeric id, when available. */
  onCancelJob?: (jobId: number) => void
  sourceVisible: boolean
  historyVisible?: boolean
  generationsVisible?: boolean
  generationActions?: readonly NotebookGenerationAction[]
  mentionAssets?: readonly AssetMentionCandidate[]
  voiceCatalog?: ElevenLabsVoicesState
  /** Transcribe / analyze progress, keyed by artifact id. */
  mediaInsightWork?: Readonly<Record<string, MediaInsightWork>>
  onUpdate: NotebookCellUpdate
  onSetInput: (targetInput: string, sourceCellId: string | null) => Promise<void>
  onRun: (cellId: string) => Promise<unknown>
  onDelete: () => Promise<void>
  onTranscribeAsset?: (artifactId: string) => void
  onLoadTranscriptJson?: (
    artifactId: string,
    source: TranscriptSidecarSource,
  ) => Promise<{ text: string; file: string }>
  onDownloadTranscriptSrt?: (artifactId: string) => void
  onOpenFullscreen: (asset: NotebookCellInspectorAsset, mode?: MediaFullscreenMode) => void
  initialGenerationPreview?: GenerationCellPreview
  onSelectSource?: (cellId: string) => void
  onPreviewPayload?: (
    cellId: string,
    draft: GenerationPreviewDraft,
  ) => Promise<unknown>
  onLoadGenerationPayload?: (assetId: string) => Promise<unknown>
  generations?: {
    attempts: readonly CellGenerationAttempt[]
    currentExecution: NotebookCellExecution | null
    loading: boolean
    error: string | null
  }
  history?: {
    revisions: readonly CellAssetRevision[]
    loading: boolean
    error: string | null
  }
}

function defaultInputNames(cell: NotebookCell): string[] {
  if (cell.type === 'extract_audio') return ['video']
  if (cell.type === 'split_video') return ['video', 'analysis']
  if (cell.type === 'analysis') return ['result']
  if (cell.type === 'image') return ['media', 'segment']
  if (cell.type === 'audio' || cell.type === 'video') return ['media']
  return []
}

function cellInputNames(cell: NotebookCell, edges: NotebookEdge[]): string[] {
  const connected = edges
    .filter((edge) => edge.target === cell.id)
    .map((edge) => edge.targetInput)
  return [...new Set([...defaultInputNames(cell), ...connected])]
}

function isVideoProducingSource(cell: NotebookCell): boolean {
  return cell.type === 'video'
    || cell.type === 'generate_video'
    || cell.type === 'concat'
    || cell.type === 'splice'
}

function inspectorInputRowVisible(
  connected: boolean,
  compatibleCandidateCount: number,
): boolean {
  return connected || compatibleCandidateCount > 0
}

function positionOpenSourcePicker(details: HTMLDetailsElement): void {
  details.classList.remove('inspector-source-picker-above')
  if (!details.open) return
  const summary = details.querySelector('summary')
  summary?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  const options = details.querySelector<HTMLElement>('.inspector-source-picker-options')
  const container = details.closest<HTMLElement>('.inspector-media-content')
    ?? details.closest<HTMLElement>('.inspector-analysis-body')
    ?? details.closest<HTMLElement>('.inspector-body')
  if (!options || !container) return
  const containerRect = container.getBoundingClientRect()
  const summaryRect = (summary ?? details).getBoundingClientRect()
  const spaceBelow = containerRect.bottom - summaryRect.bottom
  const spaceAbove = summaryRect.top - containerRect.top
  const needed = Math.min(252, options.scrollHeight || 160)
  if (spaceBelow < needed && spaceAbove > spaceBelow) {
    details.classList.add('inspector-source-picker-above')
  }
}

function compatibleSource(
  target: NotebookCell,
  targetInput: string,
  source: NotebookCell,
): boolean {
  if (source.id === target.id) return false
  if (target.type === 'analysis') {
    return targetInput === 'result' && source.type === 'analyze'
  }
  if (target.type === 'extract_audio') {
    return targetInput === 'video' && isVideoProducingSource(source)
  }
  if (target.type === 'split_video') {
    if (targetInput === 'analysis') return source.type === 'analysis'
    if (targetInput === 'video') return isVideoProducingSource(source)
    return false
  }
  if (target.type === 'prompt' && targetInput === 'analysis') {
    return source.type === 'analysis'
  }
  if (target.type === 'audio' && targetInput === 'media') {
    return source.type === 'extract_audio' || source.type === 'generate_audio'
  }
  if (target.type === 'video' && targetInput === 'media') {
    return source.type === 'split_video'
  }
  if (target.type === 'image' && targetInput === 'media') {
    return source.type === 'generate_image'
  }
  if (target.type === 'image' && targetInput === 'segment') {
    return isVideoProducingSource(source)
  }
  return true
}

/** Video's preview action bar; an image carries its Edit on the picture. */
function CellMediaActions({
  address,
  onOpen,
}: {
  address: string
  onOpen: () => void
}) {
  return (
    <div
      className="inspector-media-actions"
      role="group"
      aria-label="Video preview actions"
    >
      <span className="inspector-media-action-slot">
        <button
          type="button"
          className="inspector-fullscreen-button"
          aria-label={`Open @${address} fullscreen`}
          title={`Open @${address} fullscreen`}
          onClick={onOpen}
        >
          <Maximize2 size={14} />Fullscreen
        </button>
      </span>
    </div>
  )
}

/**
 * The picture opens fullscreen; Edit sits on it beside the Full badge so the
 * image's actions stay on the image instead of across the dock. The badge
 * lets clicks fall through to the picture, so it stays a single tab stop.
 */
function InspectorImageOpen({
  address,
  previewUrl,
  onOpen,
  onEdit,
}: {
  address: string
  previewUrl: string
  onOpen: () => void
  onEdit: () => void
}) {
  return (
    <div className="inspector-cell-media-frame">
      <button
        type="button"
        className="inspector-cell-media-open"
        aria-label={`Open @${address} fullscreen`}
        onClick={onOpen}
      >
        <img key={previewUrl} src={previewUrl} alt={`@${address}`} />
      </button>
      <span className="inspector-cell-media-overlay">
        <button
          type="button"
          className="inspector-edit-button"
          aria-label={`Edit @${address} image`}
          title={`Edit @${address} image`}
          onClick={onEdit}
        >
          <Pencil size={13} />Edit
        </button>
        <span className="inspector-cell-media-zoom" aria-hidden="true">
          <Maximize2 size={13} />Full
        </span>
      </span>
    </div>
  )
}

/**
 * Audio's dock preview: the peaks the asset already carries, with the native
 * transport under them. The grid tile's play ring only starts and stops, so
 * scrubbing lives here — and the playhead the transport moves is drawn on the
 * same waveform the tile shows, rather than on a bare pill.
 */
function InspectorAudioStage({
  address,
  waveform,
  mediaUrl,
}: {
  address: string
  waveform: number[]
  mediaUrl: string
}) {
  const [progress, setProgress] = useState(0)

  return (
    <div className="inspector-audio-stage">
      <span className="inspector-audio-waveform">
        {waveform.length > 0
          ? <CellWaveform peaks={waveform} progress={progress} />
          : <CellWaveformSkeleton />}
      </span>
      <audio
        key={mediaUrl}
        src={mediaUrl}
        aria-label={`@${address} audio`}
        controls
        preload="metadata"
        onTimeUpdate={(event) => {
          const element = event.currentTarget
          setProgress(
            Number.isFinite(element.duration) && element.duration > 0
              ? Math.min(1, Math.max(0, element.currentTime / element.duration))
              : 0,
          )
        }}
        onEnded={() => setProgress(0)}
      />
    </div>
  )
}

function NotebookCellMedia({
  asset,
  address,
  allowFullscreen,
  inlineActions = true,
  overlayMetadata = true,
  onOpenFullscreen,
}: {
  asset: NotebookCellInspectorAsset
  address: string
  allowFullscreen: boolean
  inlineActions?: boolean
  overlayMetadata?: boolean
  onOpenFullscreen: (asset: NotebookCellInspectorAsset, mode?: MediaFullscreenMode) => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const mediaUrl = asset.mediaUrl
  const previewUrl = asset.thumbnailUrl ?? mediaUrl
  const isVideo = asset.type === 'video' || asset.type === 'final'
  const isAudio = asset.type === 'audio'
  const isImage = asset.type === 'image'
  const canOpenFullscreen = allowFullscreen && (isImage || isVideo)
  const openFullscreen = (mode: MediaFullscreenMode = 'view') => {
    videoRef.current?.pause()
    onOpenFullscreen(asset, mode)
  }

  if (!previewUrl) return null

  return (
    <section
      className={`inspector-cell-preview${isAudio ? ' inspector-cell-preview-audio' : ''}`}
      aria-label="Cell output media"
    >
      <div className="inspector-cell-media">
        {isVideo && mediaUrl ? (
          <video
            ref={videoRef}
            key={mediaUrl}
            src={asset.thumbnailUrl ? mediaUrl : `${mediaUrl}#t=0.1`}
            poster={asset.thumbnailUrl ?? undefined}
            controls
            controlsList="nofullscreen nodownload noremoteplayback"
            disablePictureInPicture
            playsInline
            preload="metadata"
          />
        ) : isAudio && mediaUrl ? (
          <InspectorAudioStage
            address={address}
            waveform={asset.waveform ?? []}
            mediaUrl={mediaUrl}
          />
        ) : isImage && canOpenFullscreen ? (
          <InspectorImageOpen
            address={address}
            previewUrl={previewUrl}
            onOpen={() => openFullscreen('view')}
            onEdit={() => openFullscreen('edit')}
          />
        ) : (
          <img key={previewUrl} src={previewUrl} alt={`@${address}`} />
        )}
        {!isAudio && overlayMetadata && (
          <NotebookMediaMetadata
            className="inspector-cell-metadata"
            width={asset.width}
            height={asset.height}
            durationSeconds={isVideo ? asset.duration : null}
            fallbackLabel={asset.type.toUpperCase()}
          />
        )}
      </div>
      {inlineActions && canOpenFullscreen && isVideo && (
        <CellMediaActions
          address={address}
          onOpen={() => openFullscreen('view')}
        />
      )}
    </section>
  )
}

function inspectorArtifactAssets(
  asset: NotebookCellInspectorAsset | undefined,
  cellAssets: ReadonlyMap<string, NotebookCellInspectorAsset> | undefined,
  versionAssets: readonly NotebookCellInspectorAsset[] | undefined,
): ReadonlyMap<string, NotebookCellInspectorAsset> {
  const assets = new Map<string, NotebookCellInspectorAsset>()
  for (const versionAsset of versionAssets ?? []) {
    assets.set(versionAsset.artifactId, versionAsset)
  }
  for (const cellAsset of cellAssets?.values() ?? []) {
    assets.set(cellAsset.artifactId, cellAsset)
  }
  if (asset) assets.set(asset.artifactId, asset)
  return assets
}

function DoltArtifactExpansion({
  asset,
}: {
  asset: NotebookCellInspectorAsset
}) {
  return (
    <div className="inspector-dolt-artifact">
      <ArtifactThumb asset={asset} />
      <div className="inspector-dolt-artifact-facts">
        <strong>{asset.type.replaceAll('_', ' ').toUpperCase()}</strong>
        <NotebookMediaMetadata
          className="inspector-dolt-artifact-metadata"
          width={asset.width}
          height={asset.height}
          durationSeconds={asset.duration}
        />
      </div>
      {asset.mediaUrl && (
        <a href={asset.mediaUrl} target="_blank" rel="noreferrer">
          Open media
        </a>
      )}
    </div>
  )
}

function DoltCellSource({
  notebookId,
  cell,
  artifactAssets,
}: {
  notebookId: string
  cell: NotebookCell
  artifactAssets: ReadonlyMap<string, NotebookCellInspectorAsset>
}) {
  const rows = doltCellRows(notebookId, cell)
  const [expandedColumns, setExpandedColumns] = useState<ReadonlySet<string>>(
    new Set(),
  )
  const toggleColumn = (column: string) => {
    setExpandedColumns((current) => {
      const next = new Set(current)
      if (next.has(column)) next.delete(column)
      else next.add(column)
      return next
    })
  }

  return (
    <section className="inspector-source inspector-dolt-source">
      <header className="inspector-source-meta">
        <span>Dolt source</span>
        <code>cells · {rows.length} columns</code>
      </header>
      <table className="inspector-dolt-table" aria-label="Raw Dolt cells row">
        <thead>
          <tr>
            <th>Column</th>
            <th>Type</th>
            <th>Raw value</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const displayValue = doltCellDisplayValue(row)

            if (displayValue.kind === 'json') {
              return (
                <Fragment key={row.column}>
                  <tr className="inspector-dolt-json-meta">
                    <th scope="row">{row.column}</th>
                    <td>{row.type}</td>
                    <td><code className="dolt-json-kind">JSON</code></td>
                  </tr>
                  <tr className="inspector-dolt-json-value">
                    <td colSpan={3}>
                      <RichJson
                        value={displayValue.value}
                        ariaLabel={`${row.column} JSON`}
                        artifactAssets={artifactAssets}
                      />
                    </td>
                  </tr>
                </Fragment>
              )
            }

            const artifactAsset = displayValue.kind === 'raw'
              && typeof displayValue.value === 'string'
              ? artifactAssets.get(displayValue.value)
              : undefined

            if (artifactAsset) {
              const expanded = expandedColumns.has(row.column)
              return (
                <Fragment key={row.column}>
                  <tr
                    className={expanded
                      ? 'inspector-dolt-artifact-meta'
                      : undefined}
                  >
                    <th scope="row">{row.column}</th>
                    <td>{row.type}</td>
                    <td>
                      <button
                        type="button"
                        className="inspector-dolt-artifact-toggle"
                        aria-expanded={expanded}
                        onClick={() => toggleColumn(row.column)}
                      >
                        <code>{artifactAsset.artifactId}</code>
                        <ChevronDown size={12} aria-hidden="true" />
                      </button>
                    </td>
                  </tr>
                  {expanded && (
                    <tr className="inspector-dolt-artifact-value">
                      <td colSpan={3}>
                        <DoltArtifactExpansion asset={artifactAsset} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            }

            return (
              <tr key={row.column}>
                <th scope="row">{row.column}</th>
                <td>{row.type}</td>
                <td>
                  <code className={displayValue.kind === 'null' ? 'dolt-null' : undefined}>
                    {displayValue.kind === 'null' ? 'NULL' : String(displayValue.value)}
                  </code>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </section>
  )
}

function sourceCellTypeLabel(cell: NotebookCell): string {
  return cell.type.replaceAll('_', ' ')
}

function SourceCellThumb({
  cell,
  asset,
}: {
  cell: NotebookCell
  asset: NotebookCellInspectorAsset | undefined
}) {
  return <ArtifactThumb asset={asset} kindHint={cell.type} />
}

function SourceCellPicker({
  input,
  candidates,
  selectedCellId,
  cellAssets,
  busy,
  onSelect,
}: {
  input: string
  candidates: NotebookCell[]
  selectedCellId: string | null
  cellAssets?: ReadonlyMap<string, NotebookCellInspectorAsset>
  busy: boolean
  onSelect: (sourceCellId: string | null) => Promise<void>
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null)
  const selectedCell = candidates.find((candidate) =>
    candidate.id === selectedCellId)
  const choose = (sourceCellId: string | null) => {
    detailsRef.current?.removeAttribute('open')
    if (sourceCellId === selectedCellId) return
    void onSelect(sourceCellId)
  }

  return (
    <details
      ref={detailsRef}
      className="inspector-source-picker"
      onToggle={(event) => {
        positionOpenSourcePicker(event.currentTarget)
      }}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
          return
        }
        event.currentTarget.removeAttribute('open')
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        detailsRef.current?.removeAttribute('open')
        detailsRef.current?.querySelector<HTMLElement>('summary')?.focus()
      }}
    >
      <summary
        data-composer-focus="preserve"
        aria-label={`${input.replaceAll('_', ' ')} input`}
        title={`${input.replaceAll('_', ' ')} input`}
        aria-disabled={busy}
        tabIndex={busy ? -1 : 0}
        onClick={(event) => {
          if (busy) event.preventDefault()
        }}
      >
        {selectedCell ? (
          <>
            <SourceCellThumb
              cell={selectedCell}
              asset={cellAssets?.get(selectedCell.id)}
            />
            <span className="inspector-source-picker-copy">
              <strong>{notebookGridTag(selectedCell.slot)}</strong>
              <small>{sourceCellTypeLabel(selectedCell)}</small>
            </span>
          </>
        ) : (
          <>
            <span
              className="inspector-source-thumb inspector-source-thumb-empty"
              aria-hidden="true"
            >
              <CircleX size={15} />
            </span>
            <span className="inspector-source-picker-copy">
              <strong>No source</strong>
              <small>Optional input</small>
            </span>
          </>
        )}
        <ChevronDown
          className="inspector-source-picker-chevron"
          size={15}
          aria-hidden="true"
        />
      </summary>
      <div
        className="inspector-source-picker-options"
        role="listbox"
        aria-label={`${input.replaceAll('_', ' ')} input options`}
      >
        <button
          type="button"
          role="option"
          aria-selected={selectedCellId === null}
          disabled={busy}
          onClick={() => choose(null)}
        >
          <span
            className="inspector-source-thumb inspector-source-thumb-empty"
            aria-hidden="true"
          >
            <CircleX size={15} />
          </span>
          <span className="inspector-source-picker-copy">
            <strong>No source</strong>
            <small>Disconnect input</small>
          </span>
        </button>
        {candidates.map((candidate) => (
          <button
            type="button"
            role="option"
            aria-selected={candidate.id === selectedCellId}
            disabled={busy}
            key={candidate.id}
            onClick={() => choose(candidate.id)}
          >
            <SourceCellThumb
              cell={candidate}
              asset={cellAssets?.get(candidate.id)}
            />
            <span className="inspector-source-picker-copy">
              <strong>{notebookGridTag(candidate.slot)}</strong>
              <small>{sourceCellTypeLabel(candidate)}</small>
            </span>
          </button>
        ))}
      </div>
    </details>
  )
}

function attachmentTargetLabel(target: string): string {
  if (target === 'input') return 'input'
  if (target === 'first_frame') return 'first frame input'
  if (target === 'last_frame') return 'last frame input'
  if (target === 'replace_audio') return 'replacement audio'
  return `${target.replaceAll('_', ' ')} input`
}

function AttachSourcePicker({
  attachments,
  cells,
  cellAssets,
  busy,
  onAttach,
}: {
  attachments: readonly GenerationInputAttachment[]
  cells: NotebookCell[]
  cellAssets?: ReadonlyMap<string, NotebookCellInspectorAsset>
  busy: boolean
  onAttach: (targetInput: string, sourceCellId: string) => Promise<void>
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null)
  const cellsById = new Map(cells.map((cell) => [cell.id, cell]))
  const choose = (attachment: GenerationInputAttachment) => {
    detailsRef.current?.removeAttribute('open')
    void onAttach(attachment.targetInput, attachment.sourceCellId)
  }

  return (
    <details
      ref={detailsRef}
      className="inspector-source-picker inspector-attach-source-picker"
      onToggle={(event) => {
        positionOpenSourcePicker(event.currentTarget)
      }}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
          return
        }
        event.currentTarget.removeAttribute('open')
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        detailsRef.current?.removeAttribute('open')
        detailsRef.current?.querySelector<HTMLElement>('summary')?.focus()
      }}
    >
      <summary
        data-composer-focus="preserve"
        aria-label="Attach media input"
        title="Attach media input"
        aria-disabled={busy}
        tabIndex={busy ? -1 : 0}
        onClick={(event) => {
          if (busy) event.preventDefault()
        }}
      >
        <span
          className="inspector-source-thumb inspector-source-thumb-empty"
          aria-hidden="true"
        >
          <Plus size={15} />
        </span>
        <span className="inspector-source-picker-copy">
          <strong>Attach media</strong>
          <small>{attachments.length} available</small>
        </span>
        <ChevronDown
          className="inspector-source-picker-chevron"
          size={15}
          aria-hidden="true"
        />
      </summary>
      <div
        className="inspector-source-picker-options"
        role="listbox"
        aria-label="Media input options"
      >
        {attachments.map((attachment) => {
          const source = cellsById.get(attachment.sourceCellId)
          if (!source) return null
          return (
            <button
              type="button"
              role="option"
              aria-selected="false"
              disabled={busy}
              key={`${attachment.sourceCellId}:${attachment.target}`}
              onClick={() => choose(attachment)}
            >
              <SourceCellThumb
                cell={source}
                asset={cellAssets?.get(source.id)}
              />
              <span className="inspector-source-picker-copy">
                <strong>{notebookGridTag(source.slot)}</strong>
                <small>
                  {sourceCellTypeLabel(source)} · {attachmentTargetLabel(attachment.target)}
                </small>
              </span>
            </button>
          )
        })}
      </div>
    </details>
  )
}

function generationInputMentionSources(
  cellId: string,
  cells: readonly NotebookCell[],
  edges: readonly NotebookEdge[],
): Array<{ token: string; cell: NotebookCell }> {
  const cellsById = new Map(cells.map((candidate) => [candidate.id, candidate]))
  return generationInputMentions(cellId, cells, edges).flatMap((mention) => {
    const source = cellsById.get(mention.sourceCellId)
    return source ? [{ token: mention.token, cell: source }] : []
  })
}

function InputSources({
  cell,
  cells,
  edges,
  busy,
  cellAssets,
  attachments = [],
  onSetInput,
}: {
  cell: NotebookCell
  cells: NotebookCell[]
  edges: NotebookEdge[]
  busy: boolean
  cellAssets?: ReadonlyMap<string, NotebookCellInspectorAsset>
  attachments?: readonly GenerationInputAttachment[]
  onSetInput: (targetInput: string, sourceCellId: string | null) => Promise<void>
}) {
  const inputs = cellInputNames(cell, edges)
  const rows = inputs.flatMap((input) => {
    const edge = edges.find((candidate) =>
      candidate.target === cell.id && candidate.targetInput === input)
    const retainedEdges = edges.filter((candidate) =>
      candidate.target !== cell.id || candidate.targetInput !== input)
    const sourceCell = edge
      ? cells.find((candidate) => candidate.id === edge.source)
      : undefined
    const candidates = cells
      .filter((candidate) =>
        (compatibleSource(cell, input, candidate)
          && notebookConnectionEdges(
            cells,
            retainedEdges,
            candidate.id,
            cell.id,
          ) !== null)
        || candidate.id === edge?.source)
      .sort((left, right) =>
        left.slot.row - right.slot.row
        || left.slot.column - right.slot.column)
    if (!inspectorInputRowVisible(Boolean(edge), candidates.length)) return []
    return [{
      input,
      edge,
      sourceCell,
      candidates,
      inputLabel: input === 'input'
        ? 'input'
        : `${input.replaceAll('_', ' ')} input`,
    }]
  })

  if (rows.length === 0 && attachments.length === 0) return null

  return (
    <section className="inspector-input-sources">
      <h3>Inputs</h3>
      <div className="inspector-input-source-rows">
        {rows.map(({ input, edge, sourceCell, candidates, inputLabel }) => (
            <div
              className={edge
                ? 'inspector-input-source-row connected'
                : 'inspector-input-source-row'}
              key={input}
            >
              <SourceCellPicker
                input={input}
                candidates={candidates}
                selectedCellId={edge?.source ?? null}
                cellAssets={cellAssets}
                busy={busy}
                onSelect={(sourceCellId) => onSetInput(input, sourceCellId)}
              />
              {edge && (
                <button
                  type="button"
                  className="inspector-input-remove-button"
                  aria-label={`Remove ${sourceCell
                    ? notebookGridTag(sourceCell.slot)
                    : 'source'} from ${inputLabel}`}
                  title="Remove input"
                  disabled={busy}
                  onClick={() => void onSetInput(input, null)}
                >
                  <X size={15} aria-hidden="true" />
                </button>
              )}
            </div>
        ))}
        {attachments.length > 0 && (
          <div className="inspector-input-source-row">
            <AttachSourcePicker
              attachments={attachments}
              cells={cells}
              cellAssets={cellAssets}
              busy={busy}
              onAttach={onSetInput}
            />
          </div>
        )}
      </div>
    </section>
  )
}

function DeleteCellButton({
  busy,
  deleting,
  onDelete,
}: {
  busy: boolean
  deleting: boolean
  onDelete: () => Promise<void>
}) {
  return (
    <button
      type="button"
      className="danger-button inspector-delete-cell-button"
      aria-busy={deleting}
      title="Delete cell"
      onClick={() => void onDelete()}
      disabled={busy || deleting}
    >
      <CircleX size={13} />
      <span>
        {deleting ? 'Deleting…' : 'Delete cell'}
      </span>
    </button>
  )
}

function CellCleanupActions({
  busy,
  deleting,
  onDelete,
}: Pick<
  NotebookCellInspectorProps,
  | 'busy'
  | 'deleting'
  | 'onDelete'
>) {
  return (
    <section
      className="inspector-cell-actions inspector-compact-actions"
      aria-label="Cell cleanup actions"
    >
      <DeleteCellButton
        busy={busy}
        deleting={deleting}
        onDelete={onDelete}
      />
    </section>
  )
}

function OutputVersionSelector({
  artifactIds,
  availableArtifactIds,
  currentArtifactId,
  selectedArtifactId,
  outputLabel,
  onSelect,
}: {
  artifactIds: readonly string[]
  availableArtifactIds: ReadonlySet<string>
  currentArtifactId: string | undefined
  selectedArtifactId: string
  outputLabel: string
  onSelect: (artifactId: string) => void
}) {
  const selectedVersion = artifactIds.indexOf(selectedArtifactId) + 1
  const viewingCurrent = selectedArtifactId === currentArtifactId

  return (
    <section
      className="inspector-audio-versions"
      aria-label={`${outputLabel} versions`}
    >
      <span className="inspector-audio-version-label">
        <Layers2 size={13} aria-hidden="true" />
        Version
      </span>
      <select
        value={selectedArtifactId}
        aria-label={`${outputLabel} version`}
        onChange={(event) => onSelect(event.target.value)}
      >
        {artifactIds.map((artifactId, index) => (
          <option
            key={artifactId}
            value={artifactId}
            disabled={!availableArtifactIds.has(artifactId)}
          >
            Version {index + 1} of {artifactIds.length}
            {artifactId === currentArtifactId ? ' · current' : ''}
          </option>
        ))}
      </select>
      <span
        className={`inspector-audio-version-state${viewingCurrent ? ' current' : ''}`}
        aria-live="polite"
      >
        {viewingCurrent
          ? 'Current output'
          : `Viewing version ${selectedVersion}`}
      </span>
    </section>
  )
}

/**
 * Binds the tag editor to whichever asset version the inspector is showing.
 * Keeping it in its own component means switching versions remounts the
 * editor's local state instead of carrying one asset's pending edit onto
 * another.
 */
function CellAssetTags({
  bookId,
  tagTools,
  asset,
}: {
  bookId: string
  tagTools: NotebookCellInspectorProps['tagTools']
  asset: NotebookCellInspectorAsset
}) {
  const controller = useAssetTags({
    call: tagTools ?? null,
    target: { bookId, assetId: asset.artifactId },
    tags: asset.tags ?? null,
  })
  return (
    <AssetTagEditor
      tags={controller.tags}
      busy={controller.busy}
      error={controller.error}
      canEdit={controller.canEdit}
      suggestions={controller.suggestions}
      onAdd={(edit: TagEdit) => void controller.addTag(edit)}
      onRemove={(edit: TagEdit) => void controller.removeTag(edit)}
      onRestore={(edit: TagEdit) => void controller.restoreTag(edit)}
      onQueryChange={(prefix: string) => void controller.loadSuggestions(prefix)}
    />
  )
}

/** A take's thumb: its poster, or the peaks audio carries in place of one. */
function MediaVersionThumb({
  asset,
}: {
  asset: NotebookCellInspectorAsset | undefined
}) {
  const thumbUrl = asset?.thumbnailUrl ?? asset?.mediaUrl ?? null
  if (asset?.type !== 'audio' && thumbUrl) {
    return <img src={thumbUrl} alt="" />
  }
  return (
    <span className="inspector-media-version-blank">
      {(asset?.waveform?.length ?? 0) > 0 && (
        <CellWaveform peaks={asset?.waveform ?? []} progress={0} />
      )}
    </span>
  )
}

/* The dock is wider than any single take needs, so versions show as a rail of
   thumbs rather than hiding behind a select. Narrower docks hide this and fall
   back to OutputVersionSelector; both are rendered, CSS picks one. */
function MediaVersionRail({
  kind,
  artifactIds,
  assetsById,
  currentArtifactId,
  selectedArtifactId,
  onSelect,
}: {
  kind: MediaDockKind
  artifactIds: readonly string[]
  assetsById: ReadonlyMap<string, NotebookCellInspectorAsset>
  currentArtifactId: string | undefined
  selectedArtifactId: string
  onSelect: (artifactId: string) => void
}) {
  return (
    <section
      className="inspector-media-versions"
      aria-label={`${mediaDockKindLabel(kind)} versions`}
    >
      <span className="inspector-media-field-label">Versions</span>
      <ul className="inspector-media-version-list">
        {artifactIds.map((artifactId, index) => {
          const versionAsset = assetsById.get(artifactId)
          const isCurrent = artifactId === currentArtifactId
          const isSelected = artifactId === selectedArtifactId
          return (
            <li key={artifactId}>
              <button
                type="button"
                className={isSelected
                  ? 'inspector-media-version selected'
                  : 'inspector-media-version'}
                disabled={!versionAsset}
                aria-current={isSelected ? 'true' : undefined}
                aria-label={`Version ${index + 1} of ${artifactIds.length}${
                  isCurrent ? ', current output' : ''
                }`}
                onClick={() => onSelect(artifactId)}
              >
                <MediaVersionThumb asset={versionAsset} />
                <span className="inspector-media-version-label">
                  v{index + 1}
                  {isCurrent && (
                    <span className="inspector-media-version-now">now</span>
                  )}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** Size, shape, run time — what the preview shows without saying it. */
function MediaCellFacts({
  kind,
  address,
  asset,
  inputs,
}: {
  kind: MediaDockKind
  address: string
  asset: NotebookCellInspectorAsset
  inputs: Record<string, unknown> | undefined
}) {
  const facts = mediaDockFacts(kind, address, asset, inputs)
    .filter((fact) => fact.key !== 'address')

  return (
    <dl className="inspector-media-facts">
      {facts.map((fact) => (
        <div key={fact.key}>
          <dt>{fact.term}</dt>
          <dd>{fact.value}</dd>
        </div>
      ))}
    </dl>
  )
}

type MediaTrackStyle = CSSProperties & { '--media-aspect'?: string }

/** Seconds since the run started, ticking once a second while mounted. */
function useElapsedSeconds(startedAt: string | null): number | null {
  const [elapsed, setElapsed] = useState<number | null>(null)
  useEffect(() => {
    if (!startedAt) return
    const start = Date.parse(startedAt)
    if (!Number.isFinite(start)) return
    const compute = () =>
      setElapsed(Math.max(0, Math.round((Date.now() - start) / 1000)))
    // Async first sample: setState inside the effect body would cascade.
    const first = window.setTimeout(compute, 0)
    const timer = window.setInterval(compute, 1000)
    return () => {
      window.clearTimeout(first)
      window.clearInterval(timer)
    }
  }, [startedAt])
  return startedAt ? elapsed : null
}

function GenerationMediaPlaceholder({
  kind,
  failed,
}: {
  kind: MediaDockKind
  failed: boolean
}) {
  const placeholderStyle: MediaTrackStyle = {
    '--media-aspect': String(mediaDockAspect(kind, null)),
  }
  return (
    <div
      className={failed
        ? 'inspector-media-placeholder failed'
        : 'inspector-media-placeholder'}
      style={placeholderStyle}
    >
      <span className="inspector-media-placeholder-label">
        {failed ? 'Failed' : 'Generating…'}
      </span>
    </div>
  )
}

function GenerationProducerLink({
  producer,
  onSelectSource,
}: {
  producer: NotebookCell
  onSelectSource?: (cellId: string) => void
}) {
  return (
    <div className="inspector-media-from">
      <span className="inspector-media-field-label">From</span>
      <button
        type="button"
        className="inspector-generation-from-link"
        onClick={() => onSelectSource?.(producer.id)}
      >
        <span className="inspector-generation-from-tag">
          {notebookGridTag(producer.slot)}
        </span>
        <span>
          Generate {producer.type === 'generate_image' ? 'image' : 'video'}
        </span>
        <ArrowRight size={12} aria-hidden="true" />
      </button>
    </div>
  )
}

function GenerationInputChips({
  producerId,
  cells,
  edges,
  cellAssets,
  onSelectSource,
}: {
  producerId: string
  cells: NotebookCell[]
  edges: NotebookEdge[]
  cellAssets?: ReadonlyMap<string, NotebookCellInspectorAsset>
  onSelectSource?: (cellId: string) => void
}) {
  const mentions = generationInputMentions(producerId, cells, edges)
  if (mentions.length === 0) return null
  const cellsById = new Map(cells.map((candidate) => [candidate.id, candidate]))
  return (
    <div className="inspector-media-generation-inputs">
      <span className="inspector-media-field-label">Inputs</span>
      <div className="inspector-generation-input-chips">
        {mentions.map((mention) => {
          const inputCell = cellsById.get(mention.sourceCellId)
          const asset = inputCell?.outputArtifactId
            ? cellAssets?.get(inputCell.outputArtifactId)
            : undefined
          return (
            <button
              key={mention.token}
              type="button"
              className="inspector-generation-input-chip"
              onClick={() => inputCell && onSelectSource?.(inputCell.id)}
            >
              {asset?.thumbnailUrl && (
                <img src={asset.thumbnailUrl} alt="" />
              )}
              <span>{mention.token}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function GeneratingPrompt({ prompt }: { prompt: string }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="inspector-media-generating-prompt">
      <span className="inspector-media-field-label">Prompt</span>
      <blockquote className={expanded ? 'expanded' : undefined}>
        {prompt}
      </blockquote>
      <button
        type="button"
        className="inspector-prompt-copy"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <ChevronDown
          size={12}
          aria-hidden="true"
          style={expanded ? { transform: 'rotate(180deg)' } : undefined}
        />
        {expanded ? 'Less' : 'More'}
      </button>
    </div>
  )
}

function GeneratingMediaLayout({
  kind,
  address,
  state,
  cells,
  edges,
  cellAssets,
  busy,
  deleting,
  cancelJobId,
  onSelectSource,
  onRunProducer,
  onCancelJob,
  onDelete,
}: {
  kind: MediaDockKind
  address: string
  state: MediaCellGenerationState
  cells: NotebookCell[]
  edges: NotebookEdge[]
  cellAssets?: ReadonlyMap<string, NotebookCellInspectorAsset>
  busy: boolean
  deleting: boolean
  cancelJobId?: number
  onSelectSource?: (cellId: string) => void
  onRunProducer: (cellId: string) => Promise<unknown>
  onCancelJob?: (jobId: number) => void
  onDelete: () => Promise<void>
}) {
  const failed = state.kind === 'failed'
  const elapsed = useElapsedSeconds(
    state.kind === 'queued' || state.kind === 'generating'
      ? state.startedAt
      : null,
  )
  const producerCellId = state.kind === 'ready' ? null : state.producerCellId
  const producer = producerCellId
    ? cells.find((candidate) => candidate.id === producerCellId) ?? null
    : null
  // The failed variant carries only the error; prompt and model come from
  // the producer so failed keeps the same layout as queued and generating.
  const model = producer?.model ?? null
  const prompt = producer?.prompt ?? null

  return (
    <div className="inspector-media-generating" data-generation={state.kind}>
      <div className="inspector-media-generating-preview">
        <GenerationMediaPlaceholder kind={kind} failed={failed} />
      </div>
      <div className="inspector-media-generating-summary">
        <div className="inspector-media-generating-status">
          <span className="inspector-media-generating-state">
            {failed
              ? 'FAILED'
              : state.kind === 'queued'
              ? 'QUEUED'
              : 'GENERATING'}
            {model && ` · ${model}`}
            {elapsed !== null && ` · ${formatMediaTime(elapsed)} elapsed`}
          </span>
          {failed
            ? (
              <>
                <button
                  type="button"
                  className="inspector-generation-action"
                  disabled={busy || !producerCellId}
                  onClick={() => {
                    if (producerCellId) void onRunProducer(producerCellId)
                  }}
                >
                  <RotateCcw size={13} aria-hidden="true" />
                  Retry
                </button>
                <button
                  type="button"
                  className="inspector-generation-action danger"
                  disabled={deleting}
                  onClick={() => void onDelete()}
                >
                  <Trash2 size={13} aria-hidden="true" />
                  Delete
                </button>
              </>
            )
            : (typeof onCancelJob === 'function' && typeof cancelJobId === 'number'
              ? (
                <button
                  type="button"
                  className="inspector-generation-action danger"
                  onClick={() => onCancelJob(cancelJobId)}
                >
                  <Ban size={13} aria-hidden="true" />
                  Cancel run
                </button>
              )
              : null)}
        </div>
        {failed && state.kind === 'failed' && (
          <p className="inspector-media-generating-error" role="alert">
            <CircleAlert size={13} aria-hidden="true" />
            <span>{state.message}</span>
          </p>
        )}
        {prompt && <GeneratingPrompt prompt={prompt} />}
        {producer
          ? (
            <GenerationProducerLink
              producer={producer}
              onSelectSource={onSelectSource}
            />
          )
          : null}
        {producerCellId && (
          <GenerationInputChips
            producerId={producerCellId}
            cells={cells}
            edges={edges}
            cellAssets={cellAssets}
            onSelectSource={onSelectSource}
          />
        )}
        <span className="sr-only">{`@${address} ${state.kind}`}</span>
      </div>
    </div>
  )
}

function MediaCellInspector({
  kind,
  cell,
  cells,
  edges,
  asset,
  cellAssets,
  versionAssets,
  busy,
  deleting,
  mediaInsightWork,
  generationState,
  cancelJobId,
  onSetInput,
  onRun,
  onCancelJob,
  onSelectSource,
  onDelete,
  onOpenFullscreen,
  onTranscribeAsset,
  onLoadTranscriptJson,
  onDownloadTranscriptSrt,
  bookId,
  tagTools,
}: Pick<
  NotebookCellInspectorProps,
  | 'cell'
  | 'cells'
  | 'edges'
  | 'asset'
  | 'cellAssets'
  | 'versionAssets'
  | 'busy'
  | 'deleting'
  | 'mediaInsightWork'
  | 'onUpdate'
  | 'onSetInput'
  | 'onRun'
  | 'onCancelJob'
  | 'onDelete'
  | 'onOpenFullscreen'
  | 'onTranscribeAsset'
  | 'onLoadTranscriptJson'
  | 'onDownloadTranscriptSrt'
  | 'bookId'
  | 'tagTools'
> & {
  /** Which dock this is; the caller has already ruled out every other type. */
  kind: MediaDockKind
  /** Derived run state; ready falls through to the media grid below. */
  generationState: MediaCellGenerationState
  /** Numeric id of the active run's job, for Cancel run. */
  cancelJobId?: number
  /** Select a connected cell (the producer, or one of its inputs). */
  onSelectSource?: (cellId: string) => void
}) {
  const address = notebookGridAddress(cell.slot)
  const producer = mediaGenerationProducer(cell, cells, edges)
  const versionArtifactIds = cell.type === 'audio'
    || (
      (cell.type === 'image' || cell.type === 'video')
      && cell.inputs?.mediaRole !== 'generate-image-output'
      && cell.inputs?.mediaRole !== 'generate-video-output'
    )
    ? notebookOutputVersionArtifactIds(cell.inputs, cell.outputArtifactId)
    : []
  const versionKey = versionArtifactIds.join(':')
  const currentVersionArtifactId = cell.outputArtifactId
    ?? versionArtifactIds.at(-1)
    ?? ''
  const [versionSelection, setVersionSelection] = useState<{
    artifactId: string
    cellId: string
    currentArtifactId: string
    versionKey: string
  } | null>(null)
  if (generationState.kind !== 'ready') {
    return (
      <div className="inspector-body inspector-media-body">
        <GeneratingMediaLayout
          kind={kind}
          address={address}
          state={generationState}
          cells={cells}
          edges={edges}
          cellAssets={cellAssets}
          busy={busy}
          deleting={deleting}
          cancelJobId={cancelJobId}
          onSelectSource={onSelectSource}
          onRunProducer={onRun}
          onCancelJob={onCancelJob}
          onDelete={onDelete}
        />
      </div>
    )
  }
  const selectedVersionArtifactId = (
    versionSelection?.cellId === cell.id
    && versionSelection.currentArtifactId === currentVersionArtifactId
    && versionSelection.versionKey === versionKey
  )
    ? versionSelection.artifactId
    : currentVersionArtifactId
  const versionAssetById = new Map(
    (versionAssets ?? []).map((versionAsset) => [
      versionAsset.artifactId,
      versionAsset,
    ]),
  )
  if (asset) versionAssetById.set(asset.artifactId, asset)
  const selectedVersionAvailable = versionAssetById.has(
    selectedVersionArtifactId,
  )
  const effectiveVersionArtifactId = (
    versionArtifactIds.includes(selectedVersionArtifactId)
    && selectedVersionAvailable
  )
    ? selectedVersionArtifactId
    : currentVersionArtifactId
  const previewAsset = versionArtifactIds.length > 0
    ? versionAssetById.get(effectiveVersionArtifactId) ?? asset
    : asset
  const availableVersionArtifactIds = new Set(versionAssetById.keys())
  const selectVersion = (artifactId: string) => {
    setVersionSelection({
      artifactId,
      cellId: cell.id,
      currentArtifactId: currentVersionArtifactId,
      versionKey,
    })
  }
  const insightWork = previewAsset
    ? mediaInsightWork?.[previewAsset.artifactId] ?? idleMediaInsightWork
    : idleMediaInsightWork

  const canOpenFullscreen = kind === 'image' || kind === 'video'
  const showVersions = versionArtifactIds.length > 1 && Boolean(previewAsset)
  const mediaPreview = previewAsset ? (
    <NotebookCellMedia
      asset={previewAsset}
      address={address}
      allowFullscreen={canOpenFullscreen}
      inlineActions={false}
      overlayMetadata={false}
      onOpenFullscreen={onOpenFullscreen}
    />
  ) : (
    <div className="inspector-media-empty">
      <span>Output pending</span>
      <p>Connect a source and rerun its producer to populate this preview.</p>
    </div>
  )
  const versionSelector = showVersions && previewAsset ? (
    <OutputVersionSelector
      artifactIds={versionArtifactIds}
      availableArtifactIds={availableVersionArtifactIds}
      currentArtifactId={cell.outputArtifactId}
      selectedArtifactId={effectiveVersionArtifactId}
      outputLabel={mediaDockKindLabel(kind)}
      onSelect={selectVersion}
    />
  ) : null
  const assetTags = previewAsset ? (
    <CellAssetTags bookId={bookId} tagTools={tagTools} asset={previewAsset} />
  ) : null
  const hasTranscriptSidecar = Boolean(
    previewAsset?.transcript?.plain || previewAsset?.transcript?.elevenlabs,
  )
  const insights = previewAsset && mediaCellHasSpokenAudio(previewAsset.type)
    ? (hasTranscriptSidecar ? (
      <MediaInsightsPanel
        artifactId={previewAsset.artifactId}
        transcript={previewAsset.transcript ?? null}
        busy={busy}
        transcribing={insightWork.transcribing}
        error={insightWork.error}
        onTranscribe={onTranscribeAsset
          ? () => onTranscribeAsset(previewAsset.artifactId)
          : undefined}
        onLoadTranscriptJson={onLoadTranscriptJson
          ? (source) => onLoadTranscriptJson(previewAsset.artifactId, source)
          : undefined}
        onDownloadTranscriptSrt={onDownloadTranscriptSrt
          ? () => onDownloadTranscriptSrt(previewAsset.artifactId)
          : undefined}
      />
    ) : (
      <div className="inspector-media-insights">
        {onTranscribeAsset && (
          <button
            type="button"
            className="inspector-generation-action"
            disabled={busy || insightWork.transcribing}
            onClick={() => onTranscribeAsset(previewAsset.artifactId)}
          >
            <Captions size={13} aria-hidden="true" />
            {insightWork.transcribing ? 'Transcribing…' : 'Transcribe'}
          </button>
        )}
        {insightWork.error && (
          <p className="inspector-insight-error" role="alert">
            <CircleAlert size={12} aria-hidden="true" />
            <span>{insightWork.error}</span>
          </p>
        )}
      </div>
    ))
    : null
  const inputSources = producer ? (
    <GenerationProducerLink producer={producer} onSelectSource={onSelectSource} />
  ) : (
    <InputSources
      cell={cell}
      cells={cells}
      edges={edges}
      busy={busy}
      cellAssets={cellAssets}
      onSetInput={onSetInput}
    />
  )
  const trackStyle: MediaTrackStyle = {
    '--media-aspect': String(mediaDockAspect(kind, previewAsset ?? null)),
  }

  return (
    <div className="inspector-body inspector-media-body">
      <div
        className={[
          'inspector-media-content',
          'inspector-compact-media-content',
          'inspector-media-row-content',
          `inspector-media-row-${kind}`,
          showVersions ? '' : 'inspector-media-row-single-version',
        ].filter(Boolean).join(' ')}
        style={trackStyle}
      >
        <div className="inspector-media-row-track inspector-media-row-preview">
          {mediaPreview}
        </div>
        {showVersions && (
          <div className="inspector-media-row-track inspector-media-row-versions">
            <MediaVersionRail
              kind={kind}
              artifactIds={versionArtifactIds}
              assetsById={versionAssetById}
              currentArtifactId={cell.outputArtifactId}
              selectedArtifactId={effectiveVersionArtifactId}
              onSelect={selectVersion}
            />
          </div>
        )}
        <div className="inspector-media-row-meta">
          <div className="inspector-media-summary">
            {previewAsset && (
              <MediaCellFacts
                kind={kind}
                address={address}
                asset={previewAsset}
                inputs={cell.inputs}
              />
            )}
            {previewAsset && kind === 'video' && (
              <div className="inspector-media-summary-actions">
                <CellMediaActions
                  address={address}
                  onOpen={() => onOpenFullscreen(previewAsset)}
                />
              </div>
            )}
          </div>
          <div className="inspector-media-row-track inspector-media-row-details">
            {versionSelector}
            {assetTags}
            {inputSources}
            {/* Deleting is the last thing in the reading order, under what the
                cell is and where it came from, not a stray icon in a corner. */}
            <CellCleanupActions
              busy={busy}
              deleting={deleting}
              onDelete={onDelete}
            />
          </div>
          <div className="inspector-media-row-track inspector-media-row-actions">
            <PublishedPostInspectorDetails inputs={cell.inputs} />
            {insights}
          </div>
        </div>
      </div>
    </div>
  )
}

function AnalysisJsonDisclosure({
  label,
  summary,
  className,
  value,
  loadValue,
  ariaLabel,
  artifactAssets,
}: {
  label: string
  summary?: string
  className?: string
  value?: unknown
  loadValue?: () => Promise<unknown>
  ariaLabel: string
  artifactAssets?: ReadonlyMap<string, NotebookCellInspectorAsset>
}) {
  const [open, setOpen] = useState(false)
  const [resolvedValue, setResolvedValue] = useState(value)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mentions = providerPayloadPreviewMentions(resolvedValue)

  return (
    <details
      className={[
        'inspector-analysis-json-disclosure',
        className,
      ].filter(Boolean).join(' ')}
      aria-busy={loading}
      onToggle={(event) => {
        const nextOpen = event.currentTarget.open
        setOpen(nextOpen)
        if (
          !nextOpen
          || resolvedValue !== undefined
          || !loadValue
          || loading
        ) {
          return
        }
        setLoading(true)
        setError(null)
        void loadValue()
          .then((nextValue) => setResolvedValue(nextValue))
          .catch((loadError: unknown) => {
            setError(
              loadError instanceof Error
                ? loadError.message
                : String(loadError),
            )
          })
          .finally(() => setLoading(false))
      }}
    >
      <summary>
        <Braces size={12} aria-hidden="true" />
        <span>{label}</span>
        {summary && <code className="inspector-json-summary">{summary}</code>}
      </summary>
      {open && resolvedValue !== undefined && (
        <>
          {(mentions.promptLeaks.length > 0
            || mentions.urlPlaceholders.length > 0) && (
            <div className="inspector-payload-mentions">
              {mentions.promptLeaks.map((leak) => (
                <span
                  className="inspector-payload-mention leak"
                  key={`${leak.token}:${leak.code}`}
                  title={leak.message}
                >
                  <CircleAlert size={11} aria-hidden="true" />
                  <code>{leak.token}</code>
                  {leak.message}
                </span>
              ))}
              {mentions.urlPlaceholders.map((placeholder) => (
                <span
                  className="inspector-payload-mention placeholder"
                  key={`${placeholder.path}:${placeholder.url}`}
                  title={placeholder.path}
                >
                  <Check size={11} aria-hidden="true" />
                  <code>{placeholder.reference}</code>
                  resolves at dispatch
                </span>
              ))}
            </div>
          )}
          <div className="inspector-analysis-json-scroll" tabIndex={0}>
            <RichJson
              value={resolvedValue}
              ariaLabel={ariaLabel}
              artifactAssets={artifactAssets}
            />
          </div>
        </>
      )}
      {open && resolvedValue === undefined && (
        <div className="inspector-analysis-json-status" role="status">
          {loading
            ? 'Loading complete JSON…'
            : error ?? 'Complete JSON is unavailable for this run.'}
        </div>
      )}
    </details>
  )
}

function analysisStageLabel(stage: string): string {
  return stage
    .replace(/^notebook_/, '')
    .replace(/^legacy_/, '')
    .replaceAll('_', ' ')
}

function analysisResponseFormatLabel(
  format: NotebookAnalysisResponseFormat,
): string {
  if (format.type === 'json_schema') {
    return format.strict ? 'Strict JSON schema' : 'JSON schema'
  }
  if (format.type === 'json_object') return 'JSON object'
  if (format.type === 'text') return 'Text'
  return format.type.replaceAll('_', ' ')
}

function AnalysisLlmExchanges({
  analysisInfo,
}: {
  analysisInfo: NotebookAnalysisInfo
}) {
  const inlineExchanges = notebookAnalysisLlmExchanges(
    analysisInfo.outputJson,
  )
  const exchanges = analysisInfo.llmExchanges?.length
    ? analysisInfo.llmExchanges.map((exchange) => ({
        ...exchange,
        complete: true,
        input: undefined,
        response: undefined,
      }))
    : inlineExchanges
  const exchangeLoadRef = useRef<
    Promise<NotebookAnalysisLlmExchange[]> | null
  >(null)
  const loadExchanges = (): Promise<NotebookAnalysisLlmExchange[]> => {
    if (!analysisInfo.outputUrl) {
      return Promise.reject(
        new Error('Complete JSON is unavailable for this run.'),
      )
    }
    if (!exchangeLoadRef.current) {
      const load = fetch(analysisInfo.outputUrl)
        .then(async (response) => {
          if (!response.ok) {
            throw new Error(`Unable to load complete JSON (${response.status})`)
          }
          return response.json() as Promise<unknown>
        })
        .then((outputJson) => {
          const loaded = notebookAnalysisLlmExchanges(outputJson)
          if (loaded.length === 0) {
            throw new Error('The saved analysis has no recorded LLM exchange.')
          }
          return loaded
        })
      exchangeLoadRef.current = load.catch((loadError: unknown) => {
        exchangeLoadRef.current = null
        throw loadError
      })
    }
    return exchangeLoadRef.current
  }
  const loadExchangeValue = (
    index: number,
    key: 'input' | 'response',
  ) => async (): Promise<unknown> => {
    const loaded = await loadExchanges()
    const exchange = loaded[index]
    if (!exchange) {
      throw new Error('The saved LLM exchange could not be found.')
    }
    return exchange[key]
  }
  if (exchanges.length === 0) return null

  return (
    <section
      className="inspector-analysis-llm"
      aria-label="LLM exchanges"
    >
      <header className="inspector-analysis-llm-heading">
        <span>LLM exchange</span>
        <code>{exchanges.length} {exchanges.length === 1 ? 'call' : 'calls'}</code>
      </header>
      <div className="inspector-analysis-llm-calls">
        {exchanges.map((exchange, index) => {
          const stage = analysisStageLabel(exchange.stage)
          const ordinal = String(index + 1).padStart(2, '0')

          return (
            <article
              className="inspector-analysis-llm-call"
              key={`${exchange.stage}-${index}`}
            >
              <header>
                <span>{ordinal}</span>
                <strong>{stage}</strong>
              </header>
              <dl className="inspector-analysis-llm-meta">
                <div>
                  <dt>Provider</dt>
                  <dd>{exchange.provider}</dd>
                </div>
                <div>
                  <dt>Model</dt>
                  <dd>{exchange.model}</dd>
                </div>
                {exchange.responseFormat && (
                  <div className="inspector-analysis-llm-format">
                    <dt>Response format</dt>
                    <dd>
                      <span>
                        <Braces size={11} aria-hidden="true" />
                        {analysisResponseFormatLabel(exchange.responseFormat)}
                      </span>
                      {exchange.responseFormat.name && (
                        <code>{exchange.responseFormat.name}</code>
                      )}
                    </dd>
                  </div>
                )}
              </dl>
              {!exchange.complete && (
                <p className="inspector-analysis-llm-incomplete">
                  This older run retained summary payloads only. Re-run the
                  Analyze cell to record the complete provider exchange.
                </p>
              )}
              <div className="inspector-analysis-json-disclosures">
                <AnalysisJsonDisclosure
                  label="LLM input"
                  value={exchange.input}
                  loadValue={
                    exchange.input === undefined
                      ? loadExchangeValue(index, 'input')
                      : undefined
                  }
                  ariaLabel={`LLM input JSON for ${stage}`}
                />
                <AnalysisJsonDisclosure
                  label="LLM response"
                  value={exchange.response}
                  loadValue={
                    exchange.response === undefined
                      ? loadExchangeValue(index, 'response')
                      : undefined
                  }
                  ariaLabel={`LLM response JSON for ${stage}`}
                />
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}

function AnalysisCellInspector({
  cell,
  cells,
  edges,
  asset,
  cellAssets,
  versionAssets,
  busy,
  deleting,
  onSetInput,
  onDelete,
}: Pick<
  NotebookCellInspectorProps,
  | 'cell'
  | 'cells'
  | 'edges'
  | 'asset'
  | 'cellAssets'
  | 'versionAssets'
  | 'busy'
  | 'deleting'
  | 'onUpdate'
  | 'onSetInput'
  | 'onDelete'
>) {
  const artifactIds = notebookOutputVersionArtifactIds(
    cell.inputs,
    cell.outputArtifactId,
  )
  const versionKey = artifactIds.join(':')
  const currentArtifactId = cell.outputArtifactId ?? artifactIds.at(-1) ?? ''
  const [selection, setSelection] = useState<{
    artifactId: string
    cellId: string
    currentArtifactId: string
    versionKey: string
  } | null>(null)
  const selectedArtifactId = (
    selection?.cellId === cell.id
    && selection.currentArtifactId === currentArtifactId
    && selection.versionKey === versionKey
  )
    ? selection.artifactId
    : currentArtifactId
  const assetById = new Map(
    (versionAssets ?? []).map((versionAsset) => [
      versionAsset.artifactId,
      versionAsset,
    ]),
  )
  if (asset) assetById.set(asset.artifactId, asset)
  const effectiveArtifactId = (
    artifactIds.includes(selectedArtifactId)
    && assetById.has(selectedArtifactId)
  )
    ? selectedArtifactId
    : currentArtifactId
  const previewAsset = assetById.get(effectiveArtifactId) ?? asset
  const info = previewAsset?.analysisInfo
  const shots = info?.shots
    .slice()
    .sort((left, right) => left.ordinal - right.ordinal) ?? []

  return (
    <div className="inspector-body inspector-analysis-body">
      <div className="inspector-analysis-content">
        {artifactIds.length > 1 && (
          <OutputVersionSelector
            artifactIds={artifactIds}
            availableArtifactIds={new Set(assetById.keys())}
            currentArtifactId={cell.outputArtifactId}
            selectedArtifactId={effectiveArtifactId}
            outputLabel="Analysis"
            onSelect={(artifactId) => {
              setSelection({
                artifactId,
                cellId: cell.id,
                currentArtifactId,
                versionKey,
              })
            }}
          />
        )}
        {info ? (
          <>
            <AnalysisLlmExchanges
              key={effectiveArtifactId}
              analysisInfo={info}
            />
            <ol className="inspector-analysis-shots">
              {shots.map((shot) => (
                <li key={shot.ordinal}>
                  <span className="inspector-analysis-shot-number">
                    {String(shot.ordinal).padStart(2, '0')}
                  </span>
                  <div>
                    <strong>{shot.label}</strong>
                    <time>
                      {formatMediaTime(shot.startSeconds)}
                      {' – '}
                      {formatMediaTime(shot.endSeconds)}
                      {' · '}
                      {formatMediaTime(shot.durationSeconds)}
                    </time>
                  </div>
                </li>
              ))}
            </ol>
          </>
        ) : (
          <div className="inspector-media-empty">
            <span>Analysis pending</span>
            <p>Run the connected Analyze cell to populate normalized shots.</p>
          </div>
        )}
        <InputSources
          cell={cell}
          cells={cells}
          edges={edges}
          busy={busy}
          cellAssets={cellAssets}
          onSetInput={onSetInput}
        />
        <CellCleanupActions
          busy={busy}
          deleting={deleting}
          onDelete={onDelete}
        />
      </div>
    </div>
  )
}

function ExecutableCellInspector({
  headerActionHost,
  sourceVisible,
  cell,
  cells,
  edges,
  asset,
  cellAssets,
  status,
  error,
  busy,
  deleting,
  onUpdate,
  onSetInput,
  onRun,
  onDelete,
  onOpenFullscreen,
  onPreviewPayload,
  initialGenerationPreview,
  onSelectSource,
  generationActions = [],
  mentionAssets = [],
  voiceCatalog,
}: Pick<
  NotebookCellInspectorProps,
  | 'headerActionHost'
  | 'sourceVisible'
  | 'cell'
  | 'cells'
  | 'edges'
  | 'asset'
  | 'cellAssets'
  | 'status'
  | 'error'
  | 'busy'
  | 'deleting'
  | 'onUpdate'
  | 'onSetInput'
  | 'onRun'
  | 'onDelete'
  | 'onOpenFullscreen'
  | 'onPreviewPayload'
  | 'initialGenerationPreview'
  | 'onSelectSource'
  | 'generationActions'
  | 'mentionAssets'
  | 'voiceCatalog'
>) {
  const formId = useId()
  const dock = useContext(ComposerDockContext)
  const [draft, setDraft] = useState(() =>
    cellFormDraft(
      cell,
      generationActions,
      generationConnectedInputs(cell.id, cells, edges),
    ))
  const [saving, setSaving] = useState(false)
  const ensureVoiceCatalog = () => {
    if (!voiceCatalog) return
    void voiceCatalog.ensureLoaded().catch(() => undefined)
  }
  const [copyResult, setCopyResult] = useState<{
    error: string
    state: 'copied' | 'failed'
  } | null>(null)
  const [promptCopyState, setPromptCopyState] = useState<
    'idle' | 'copied' | 'failed'
  >('idle')
  const promptFieldRef = useRef<HTMLDivElement | null>(null)
  const promptTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const promptPreviewRequestRef = useRef(0)
  const [promptCaret, setPromptCaret] = useState(draft.prompt.length)
  const [promptSuggestionIndex, setPromptSuggestionIndex] = useState(0)
  // The menu opens only while a mention is being typed. Opening a cell whose
  // prompt already ends in one, or clicking back into the text beside it, must
  // not raise it — nothing was asked for.
  const [promptMentionOpen, setPromptMentionOpen] = useState(false)
  const [promptMentionPreview, setPromptMentionPreview] = useState<{
    key?: string
    error: string | null
    loading: boolean
    value: unknown
  }>({ error: null, loading: false, value: undefined })
  const textCell = cell.type === 'prompt'
    || cell.type === 'analyze'
    || cell.type === 'generate_video'
    || cell.type === 'generate_image'
    || cell.type === 'generate_audio'
  const generationCell = cell.type === 'generate_video'
    || cell.type === 'generate_image'
    || cell.type === 'generate_audio'
  const generationCellType = isNotebookGenerationCellType(cell.type)
    ? cell.type
    : null
  const generationSelection: GenerationSelection = {
    provider: draft.provider,
    model: draft.model,
    operation: draft.operation,
    tool: draft.tool,
  }
  const connectedGenerationInputs = generationCellType
    ? generationConnectedInputs(cell.id, cells, edges)
    : []
  const compatibleActions = generationCellType
    ? compatibleGenerationActions(
        generationActions,
        generationCellType,
        connectedGenerationInputs,
      )
    : []
  const selectedGenerationAction = generationCellType
    ? generationActionForSelection(
        generationActions,
        generationCellType,
        generationSelection,
      )
    : null
  const generationActionCompatible = Boolean(
    selectedGenerationAction
    && generationActionIsCompatible(
      selectedGenerationAction,
      connectedGenerationInputs,
    ),
  )
  const compatibleModes = selectedGenerationAction
    ? compatibleGenerationModes(
        selectedGenerationAction,
        connectedGenerationInputs,
      )
    : []
  const compatibleModeIds = new Set(compatibleModes.map((mode) => mode.id))
  const effectiveGenerationMode = selectedGenerationAction
    ? initialGenerationMode(
        selectedGenerationAction,
        connectedGenerationInputs,
        draft.generationMode,
      )
    : ''
  const generationModeCompatible = Boolean(
    selectedGenerationAction
    && generationModeIsCompatible(
      selectedGenerationAction,
      effectiveGenerationMode,
      connectedGenerationInputs,
    ),
  )
  const generationModeOptions = selectedGenerationAction?.inputContract.modes
    ?? []
  const generationAttachments = selectedGenerationAction
    ? generationInputAttachments(
        selectedGenerationAction,
        effectiveGenerationMode,
        cell.id,
        cells,
        edges,
      )
    : []
  const generationControls = selectedGenerationAction?.controls ?? []
  const allGenerationControls = generationActions.flatMap((candidate) =>
    candidate.controls)
  const generationSettingsValid = generationControlsAreValid(
    generationControls,
    draft.generationSettings,
  )
  const generationCompatible = generationActionCompatible
    && generationModeCompatible
    && generationSettingsValid
  const generationPickerActions = selectedGenerationAction
    && !generationActionCompatible
    && !compatibleActions.some((candidate) =>
      candidate.id === selectedGenerationAction.id)
    ? [selectedGenerationAction, ...compatibleActions]
    : compatibleActions
  const selectedGenerationValue = selectedGenerationAction?.id
    ?? draft.tool
  const cyclicInputMentions = useMemo(
    () => notebookCyclicInputMentionValues(cells, edges, cell.id),
    [cell.id, cells, edges],
  )
  const promptInputMentions = useMemo(
    () => generationInputMentionSources(cell.id, cells, edges),
    [cell.id, cells, edges],
  )
  const promptSuggestionItems = useMemo<AutocompleteItem[]>(() => {
    const input = draft.prompt.slice(0, promptCaret)
    const rows = generationCell
      ? generationInputMentionRows(promptInputMentions, mentionAssets, input)
      : mentionMenuRows(mentionAssets, cells, input, cyclicInputMentions)
    return rows
      .map((row) => ({
        type: 'mention' as const,
        value: row.value,
        label: row.label,
        description: row.description,
        caption: row.caption,
        thumbnailSrc: row.thumbnailUrl,
        mediaKind: row.mediaKind ?? undefined,
        empty: row.empty,
        // Every slug wears the amber of the token it becomes in the prompt.
        colorScheme: 'amber' as const,
      }))
  }, [cells, cyclicInputMentions, draft.prompt, generationCell, mentionAssets, promptCaret, promptInputMentions])
  const showPromptSuggestions = promptMentionOpen
    && promptSuggestionItems.length > 0
  const action = notebookCellActionPresentation(
    generationCell
      ? {
          ...cell,
          provider: draft.provider,
          model: draft.model,
          operation: draft.operation,
          tool: draft.tool,
        }
      : cell,
    status,
  )
  const previewCell = cell.type === 'character'
    || generationCell
    || cell.type === 'extract_audio'
  const actionCell = isActionCellType(cell.type)
  const dirty = cellFormIsDirty(cell, draft, generationControls)
  const valid = cellFormIsValid(cell, draft)
    && (!generationCell || generationCompatible)
  const runLabel = generationCell
    ? 'Generate'
    : action
    ? notebookCellInspectorActionLabel(cell.type, action.label)
    : null
  const saveOnRun = (actionCell || generationCell) && Boolean(runLabel)
  const runError = error
    ?? 'This action failed, but no error details were recorded.'
  const copyState = copyResult?.error === runError ? copyResult.state : 'idle'
  const copyLabel = copyState === 'copied'
    ? 'Copied'
    : copyState === 'failed'
      ? 'Retry copy'
      : 'Copy'
  const promptCopyLabel = promptCopyState === 'copied'
    ? 'Copied'
    : promptCopyState === 'failed'
      ? 'Retry copy'
      : 'Copy'

  const generationPreviewDraft = (
    value: CellFormDraft,
    inputEdges = edges,
  ): GenerationPreviewDraft => {
    const selected = generationCellType
      ? generationActionForSelection(generationActions, generationCellType, value)
      : null
    const inputs = generationConnectedInputs(cell.id, cells, inputEdges)
    return {
      prompt: value.prompt,
      provider: value.provider,
      model: value.model,
      operation: value.operation,
      tool: value.tool,
      inputs: generationInputsForDraft(cell, {
        ...value,
        generationMode: selected
          ? initialGenerationMode(selected, inputs, value.generationMode)
          : value.generationMode,
        generationSettings: effectiveGenerationSettings(
          selected?.controls ?? [],
          value.generationSettings,
        ),
      }, allGenerationControls),
    }
  }
  const previewKey = (value: CellFormDraft, inputEdges = edges) => JSON.stringify([
    generationPreviewDraft(value, inputEdges),
    inputEdges.filter((edge) => edge.target === cell.id)
      .map((edge) => [edge.source, edge.targetInput]).sort(),
  ])
  const currentPreviewKey = previewKey(draft)
  const [initialPreviewKey] = useState(currentPreviewKey)
  const generationPreview = promptMentionPreview.key !== undefined
    ? promptMentionPreview
    : initialGenerationPreview ?? promptMentionPreview
  const generationPreviewStale = (promptMentionPreview.key ?? initialPreviewKey) !== currentPreviewKey
  const loadGenerationPreview = async (
    value = draft,
    inputEdges = edges,
  ): Promise<unknown> => {
    if (!onPreviewPayload) throw new Error('Payload preview is unavailable')
    const requestId = ++promptPreviewRequestRef.current
    const key = previewKey(value, inputEdges)
    setPromptMentionPreview({ key, error: null, loading: true, value: undefined })
    try {
      const preview = await onPreviewPayload(
        cell.id,
        generationPreviewDraft(value, inputEdges),
      )
      if (promptPreviewRequestRef.current === requestId) {
        setPromptMentionPreview({ key, error: null, loading: false, value: preview })
      }
      return preview
    } catch (error) {
      if (promptPreviewRequestRef.current === requestId) {
        setPromptMentionPreview({
          key,
          error: error instanceof Error ? error.message : String(error),
          loading: false,
          value: undefined,
        })
      }
      throw error
    }
  }
  const promptPreviewRefresh = useGenerationPreviewRefresh((value: CellFormDraft = draft, inputEdges: NotebookEdge[] = edges) => {
    if (generationCell && onPreviewPayload) {
      void loadGenerationPreview(value, inputEdges).catch(() => undefined)
    }
  }, cell.id)
  const refreshGenerationPreview = promptPreviewRefresh.run
  const requestPromptMentionPreview = (prompt: string) => {
    promptPreviewRequestRef.current += 1
    setPromptMentionPreview((current) => ({ ...current, loading: false }))
    if (generationCell && onPreviewPayload) promptPreviewRefresh.schedule({ ...draft, prompt })
  }
  const updatePrompt = (prompt: string, caret: number) => {
    setPromptCopyState('idle')
    setDraft((current) => ({ ...current, prompt }))
    setPromptCaret(caret)
    setPromptSuggestionIndex(0)
    setPromptMentionOpen(true)
    requestPromptMentionPreview(prompt)
  }
  const insertPromptSuggestion = (suggestion: AutocompleteItem) => {
    const beforeCaret = draft.prompt.slice(0, promptCaret)
    const mentionStart = beforeCaret.lastIndexOf('@')
    if (mentionStart < 0) return
    const before = draft.prompt.slice(0, mentionStart)
    const after = draft.prompt.slice(promptCaret)
    const separator = !after || /^\s/u.test(after) ? '' : ' '
    const prompt = `${before}${suggestion.value}${separator}${after}`
    const caret = before.length + suggestion.value.length + separator.length
    updatePrompt(prompt, caret)
    setPromptMentionOpen(false)
    requestAnimationFrame(() => {
      promptTextareaRef.current?.focus({ preventScroll: true })
      promptTextareaRef.current?.setSelectionRange(caret, caret)
    })
  }

  const updateDraft = <Field extends keyof CellFormDraft,>(
    field: Field,
    value: CellFormDraft[Field],
  ) => {
    setDraft((current) => ({ ...current, [field]: value }))
  }
  const updateGenerationAction = (actionId: string) => {
    const selected = generationPickerActions.find((candidate) =>
      candidate.id === actionId)
    if (!selected) return
    if (cell.type === 'generate_audio'
      && selected.controls.some((control) => control.name === 'voice_id')) {
      ensureVoiceCatalog()
    }
    const next = {
      ...draft,
      ...generationSelectionForAction(selected),
      generationMode: initialGenerationMode(
        selected,
        connectedGenerationInputs,
      ),
      generationSettings: {},
    }
    setDraft(next)
    refreshGenerationPreview(next)
  }
  const updateGenerationSetting = (
    name: string,
    value: GenerationControlValue | undefined,
  ) => {
    const generationSettings = { ...draft.generationSettings }
    if (value === undefined) delete generationSettings[name]
    else generationSettings[name] = value
    const next = { ...draft, generationSettings }
    setDraft(next)
    refreshGenerationPreview(next)
  }
  const copyRunError = async () => {
    try {
      await navigator.clipboard.writeText(runError)
      setCopyResult({ error: runError, state: 'copied' })
    } catch {
      setCopyResult({ error: runError, state: 'failed' })
    }
  }
  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(draft.prompt)
      setPromptCopyState('copied')
    } catch {
      setPromptCopyState('failed')
    }
  }
  const save = async () => {
    if (!dirty || !valid) return
    setSaving(true)
    try {
      await onUpdate(cellFormPatch(
        cell,
        { ...draft, generationMode: effectiveGenerationMode },
        generationControls,
        allGenerationControls,
      ))
    } finally {
      setSaving(false)
    }
  }
  const saveAndRun = async () => {
    if (
      !saveOnRun
      || busy
      || saving
      || action?.disabled
      || !valid
      || (generationCell && promptMentionPreview.loading)
    ) return
    setSaving(true)
    try {
      if (generationCell) {
        try {
          promptPreviewRefresh.cancel()
          const preview = await loadGenerationPreview()
          if (providerPayloadPreviewMentions(preview).promptLeaks.length > 0) {
            return
          }
        } catch {
          return
        }
      }
      await persistAndRunNotebookCell({
        cellId: cell.id,
        dirty,
        valid,
        patch: cellFormPatch(
          cell,
          { ...draft, generationMode: effectiveGenerationMode },
          generationControls,
          allGenerationControls,
        ),
        onUpdate,
        onRun,
      })
    } finally {
      setSaving(false)
    }
  }

  const incomingEdges = edges.filter((edge) => edge.target === cell.id)
  const inputMentionTokens = new Map(
    generationInputMentions(cell.id, cells, edges).map((mention) =>
      [`${mention.sourceCellId}:${mention.targetInput}`, mention.token]),
  )
  const sourceFor = (
    sourceCellId: string,
    targetInput: string,
    targetLabel = attachmentTargetLabel(targetInput),
    mention?: string,
  ): GenerationReviewSource[] => {
    const source = cells.find((candidate) => candidate.id === sourceCellId)
    return source ? [{
      cellId: source.id,
      address: notebookGridAddress(source.slot),
      type: source.type,
      targetInput,
      targetLabel,
      ...(mention ? { mention } : {}),
      asset: cellAssets?.get(source.id) ?? null,
    }] : []
  }
  const generationSources = incomingEdges.flatMap((edge) =>
    sourceFor(
      edge.source,
      edge.targetInput,
      undefined,
      inputMentionTokens.get(`${edge.source}:${edge.targetInput}`),
    ))
  const generationSourceOptions = generationAttachments.flatMap((attachment) =>
    sourceFor(
      attachment.sourceCellId,
      attachment.targetInput,
      attachmentTargetLabel(attachment.target),
    ))
  const editorAction: NotebookGenerationAction = selectedGenerationAction ?? {
    id: draft.tool,
    tool: draft.tool,
    provider: draft.provider,
    providerLabel: draft.provider,
    model: draft.model,
    operation: draft.operation,
    title: draft.tool || 'No compatible models',
    cellTypes: generationCellType ? [generationCellType] : [],
    isDefault: false,
    defaultPriority: 0,
    controls: [],
    inputContract: { modes: [] },
  }
  const generationEditorActions = generationPickerActions.map((candidate) =>
    generationActionIsCompatible(candidate, connectedGenerationInputs)
      ? candidate
      : { ...candidate, providerLabel: `${candidate.providerLabel} · incompatible` })
  if (!selectedGenerationAction) generationEditorActions.unshift(editorAction)
  const generationEditorDraft = {
    action: editorAction,
    cell: { ...cell, ...generationPreviewDraft(draft) },
    connections: incomingEdges.map((edge) => ({
      sourceCellId: edge.source,
      targetInput: edge.targetInput,
    })),
    sourceCellIds: generationSources.map((source) => source.cellId),
    sourceAddresses: generationSources.map((source) => source.address),
  }
  const changeGenerationSource = async (
    targetInput: string,
    sourceCellId: string | null,
  ) => {
    const retained = edges.filter((edge) =>
      edge.target !== cell.id || edge.targetInput !== targetInput)
    const nextEdges = sourceCellId
      ? [...retained, { id: targetInput, source: sourceCellId, target: cell.id, targetInput }]
      : retained
    await onSetInput(targetInput, sourceCellId)
    refreshGenerationPreview(draft, nextEdges)
  }
  const promptEditor = textCell ? (
    <section className="inspector-prompt-field">
      <header className="inspector-prompt-header">
        <h3>Prompt</h3>
        <button
          type="button"
          className={`inspector-prompt-copy${promptCopyState === 'copied' ? ' copied' : ''}`}
          aria-label={promptCopyState === 'copied'
            ? 'Prompt copied'
            : promptCopyState === 'failed'
              ? 'Retry copying prompt'
              : 'Copy prompt'}
          title={promptCopyState === 'copied'
            ? 'Prompt copied'
            : promptCopyState === 'failed'
              ? 'Retry copying prompt'
              : 'Copy prompt'}
          disabled={!draft.prompt}
          onClick={() => void copyPrompt()}
        >
          {promptCopyState === 'copied'
            ? <Check size={12} />
            : <Copy size={12} />}
          <span aria-live="polite">{promptCopyLabel}</span>
        </button>
      </header>
      <div className="inspector-prompt-editor" ref={promptFieldRef}>
        {showPromptSuggestions && (
          <AutocompleteDropdown
            items={promptSuggestionItems}
            selectedIndex={promptSuggestionIndex}
            onSelect={insertPromptSuggestion}
            onHover={setPromptSuggestionIndex}
            anchorRef={promptFieldRef}
            preferAbove={false}
          />
        )}
        <textarea
          ref={promptTextareaRef}
          aria-label="Prompt"
          className="inspector-prompt-textarea"
          value={draft.prompt}
          disabled={generationCell && (busy || saving)}
          aria-invalid={generationCell && !generationPreviewStale && providerPayloadPreviewMentions(generationPreview.value).promptLeaks.length > 0}
          rows={generationCell ? 3 : 8}
          onChange={(event) => updatePrompt(
            event.target.value,
            event.target.selectionStart,
          )}
          onClick={(event) => setPromptCaret(event.currentTarget.selectionStart)}
          onSelect={(event) => setPromptCaret(event.currentTarget.selectionStart)}
          onBlur={() => setPromptMentionOpen(false)}
          onKeyDown={(event) => {
            if (!showPromptSuggestions) return
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setPromptSuggestionIndex((current) =>
                (current + 1) % promptSuggestionItems.length)
              return
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault()
              setPromptSuggestionIndex((current) =>
                (current - 1 + promptSuggestionItems.length)
                % promptSuggestionItems.length)
              return
            }
            if (event.key === 'Enter' || event.key === 'Tab') {
              event.preventDefault()
              insertPromptSuggestion(
                promptSuggestionItems[promptSuggestionIndex]!,
              )
              return
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              setPromptMentionOpen(false)
            }
          }}
        />
      </div>
    </section>
  ) : null

  const runDisabled = busy
    || saving
    || Boolean(action?.disabled)
    || !valid
    || (generationCell && promptMentionPreview.loading)
    || (!saveOnRun && dirty)
  const { onKeyDown } = useConfirmSheetKeys({
    applyFormId: formId,
    applyDisabled: runDisabled,
    applyScopeSelector: '.composer-notebook-dock',
    busy: busy || saving,
    enabled: generationCell && Boolean(dock),
    onCancel: () => dock?.hide(),
  })
  const runAction = runLabel && (action || generationCell) ? (
    <section
      className={generationCell && headerActionHost
        ? 'confirm-sheet-actions inspector-generation-header-actions'
        : 'inspector-cell-actions'}
      aria-label="Primary cell action"
    >
      <button
        type="button"
        className={generationCell && headerActionHost ? 'confirm-sheet-apply' : 'inspector-run-action'}
        aria-busy={saveOnRun && saving}
        aria-keyshortcuts={generationCell ? 'Meta+Enter Control+Enter' : undefined}
        title={
          action?.disabled
            ? 'A run is already in progress for this cell'
            : generationCell && !generationCompatible
              ? 'Check the generation type and required settings'
              : !saveOnRun && dirty
                ? 'Save changes before running'
                : generationCell ? 'Generate (⌘Enter / Ctrl+Enter)' : undefined
        }
        onClick={() => {
          if (saveOnRun) {
            void saveAndRun()
            return
          }
          void onRun(cell.id)
        }}
        disabled={runDisabled}
      >
        {saveOnRun && saving
          ? generationCell ? 'Generating…' : 'Applying…'
          : runLabel}
        {generationCell && !saving && <kbd aria-hidden="true">⌘↵</kbd>}
      </button>
    </section>
  ) : null

  const draftNotice = !generationCell && dirty ? (
    <div
      className={`inspector-dirty-notice${valid ? '' : ' invalid'}`}
      role="status"
    >
      <CircleAlert size={14} />
      <span>
        {valid
          ? saveOnRun
            ? 'Changes apply when this action runs'
            : 'Unsaved changes'
          : saveOnRun
            ? 'Check timing values before running'
            : 'Check timing values before saving'}
      </span>
    </div>
  ) : null

  return (
    <div
      className={generationCell ? 'generation-cell-inspector' : 'inspector-body inspector-executable-body'}
      onKeyDown={onKeyDown}
    >
      {generationCell && headerActionHost ? createPortal(runAction, headerActionHost) : null}
      {asset && previewCell && !generationCell && (
        <NotebookCellMedia
          asset={asset}
          address={notebookGridAddress(cell.slot)}
          allowFullscreen={asset.type === 'image'
            || asset.type === 'video'
            || asset.type === 'final'}
          onOpenFullscreen={onOpenFullscreen}
        />
      )}
      {!generationCell && (
        <InputSources
          cell={cell}
          cells={cells}
          edges={edges}
          busy={busy}
          cellAssets={cellAssets}
          onSetInput={onSetInput}
        />
      )}
      <form
        id={formId}
        className={generationCell ? 'generation-cell-form' : 'inspector-cell-form'}
        aria-busy={saving}
        onSubmit={(event) => {
          event.preventDefault()
          if (saveOnRun) {
            void saveAndRun()
            return
          }
          void save()
        }}
      >
        {generationCell ? (
          <GenerationBody
            actions={generationEditorActions}
            busy={busy || saving}
            draft={generationEditorDraft}
            modes={generationModeOptions}
            compatibleModeIds={compatibleModeIds}
            sourceVisible={sourceVisible}
            preview={generationPreview.value}
            previewError={generationPreview.error}
            previewLoading={generationPreview.loading}
            previewStale={generationPreviewStale}
            sources={generationSources}
            sourceOptions={generationSourceOptions}
            voiceCatalog={voiceCatalog}
            promptEditor={promptEditor}
            inputFooter={asset ? (
              <div className="generation-cell-output">
                <span className="confirm-section-label">Output</span>
                <NotebookCellMedia
                  asset={asset}
                  address={notebookGridAddress(cell.slot)}
                  allowFullscreen={asset.type === 'image' || asset.type === 'video' || asset.type === 'final'}
                  onOpenFullscreen={onOpenFullscreen}
                />
              </div>
            ) : undefined}
            onActionChange={updateGenerationAction}
            onAddSource={(sourceCellId, targetInput) => {
              if (targetInput) void changeGenerationSource(targetInput, sourceCellId)
            }}
            onRemoveSource={(_sourceCellId, targetInput) => {
              if (targetInput) void changeGenerationSource(targetInput, null)
            }}
            onSelectSource={(cellId) => onSelectSource?.(cellId)}
            onModeChange={(generationMode) => {
              const next = { ...draft, generationMode }
              setDraft(next)
              refreshGenerationPreview(next)
            }}
            onPromptChange={(prompt) => updatePrompt(prompt, prompt.length)}
            onRefreshPreview={() => refreshGenerationPreview()}
            onSettingChange={updateGenerationSetting}
          />
        ) : promptEditor}
        {cell.type === 'split_video'
          && (cell.operation === 'split_at_points'
            || cell.operation === 'split_ranges') && (
          <div className="inspector-field-pair">
            <label>
              Cut points
              <input
                type="text"
                value={Array.isArray(cell.inputs?.cutPointsSeconds)
                  ? cell.inputs.cutPointsSeconds.join(', ')
                  : ''}
                readOnly
              />
            </label>
            <label>
              Chunks
              <input
                type="text"
                value={Array.isArray(cell.inputs?.cutPointsSeconds)
                  ? String(cell.inputs.cutPointsSeconds.length + 1)
                  : ''}
                readOnly
              />
            </label>
          </div>
        )}
        {cell.type === 'split_video'
          && cell.operation !== 'split_at_points'
          && cell.operation !== 'split_ranges' && (
          <div className="inspector-field-pair">
            <label>
              Start seconds
              <input
                type="number"
                min="0"
                step="0.01"
                value={draft.startSeconds}
                onChange={(event) => updateDraft('startSeconds', event.target.value)}
              />
            </label>
            <label>
              End seconds
              <input
                type="number"
                min="0"
                step="0.01"
                value={draft.endSeconds}
                onChange={(event) => updateDraft('endSeconds', event.target.value)}
              />
            </label>
          </div>
        )}
        {cell.type === 'splice' && draft.operation === 'splice_video' && (
          <label>
            Overlap seconds
            <input
              type="number"
              min="0"
              step="0.01"
              value={draft.overlap}
              onChange={(event) => updateDraft('overlap', event.target.value)}
            />
          </label>
        )}
        {generationCell && !draft.tool && !draft.model && (
          <span className="workspace-notice">
            No generation model matches the current inputs.
          </span>
        )}
        {generationCell && selectedGenerationValue && !generationCompatible && (
          <div className="inspector-generation-warning" role="status">
            <CircleAlert size={14} />
            <span>
              {!generationActionCompatible
                ? 'This model does not accept the current inputs. Choose a compatible model or change the connections.'
                : !generationModeCompatible
                  ? 'This generation type does not match the current inputs. Choose a compatible type or change the connections.'
                  : 'Complete the required generation settings before running.'}
            </span>
          </div>
        )}
        {draftNotice}
        {!saveOnRun && !generationCell && (
          <button
            type="submit"
            className="inspector-save-button"
            disabled={busy || saving || !dirty || !valid}
          >
            <Save size={15} />
            <span>{saving ? 'Saving…' : 'Save changes'}</span>
          </button>
        )}
      </form>
      {generationCell && headerActionHost ? null : runAction}
      {(status === 'error' || error) && (
        <section
          className="inspector-run-error"
          role="alert"
          aria-label="Cell run error"
        >
          <CircleAlert size={16} aria-hidden="true" />
          <div className="inspector-run-error-content">
            <div className="inspector-run-error-header">
              <strong>Run failed</strong>
              <button
                type="button"
                aria-label="Copy run error"
                title="Copy run error"
                onClick={() => void copyRunError()}
              >
                <span aria-live="polite">{copyLabel}</span>
              </button>
            </div>
            <p>{runError}</p>
          </div>
        </section>
      )}
      {!generationCell && (
        <CellCleanupActions
          busy={busy}
          deleting={deleting}
          onDelete={onDelete}
        />
      )}
    </div>
  )
}

function relativeTimeLabel(value: number | string): string | null {
  const ms = typeof value === 'number' ? value : Date.parse(value)
  if (!Number.isFinite(ms)) return null
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(ms).toLocaleDateString()
}

function absoluteTimeLabel(value: number | string): string | undefined {
  const ms = typeof value === 'number' ? value : Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toLocaleString() : undefined
}

function isInFlightGenerationStatus(status: GenerationStatus): boolean {
  return status === 'dispatched' || status === 'awaiting_provider'
}

function liveGenerationAttemptId(
  attempts: readonly CellGenerationAttempt[],
  execution: NotebookCellExecution | null,
): string | null {
  if (!execution || !notebookCellIsActiveStatus(execution.status ?? '')) {
    return null
  }
  if (execution.runId) {
    const match = attempts.find((attempt) => attempt.runId === execution.runId)
    if (match) return match.attemptId
  }
  return attempts.find((attempt) => isInFlightGenerationStatus(attempt.status))
    ?.attemptId ?? null
}

function CellAssetHistoryPanel({
  revisions,
  loading,
  error,
}: {
  revisions: readonly CellAssetRevision[]
  loading: boolean
  error: string | null
}) {
  return (
    <section className="inspector-generations" aria-label="Asset history">
      <header className="inspector-source-meta">
        <span>
          <History size={14} aria-hidden="true" />
          History
        </span>
        <code>{revisions.length} revision{revisions.length === 1 ? '' : 's'}</code>
      </header>
      {loading && (
        <p className="inspector-analysis-json-status" role="status">
          Loading asset history…
        </p>
      )}
      {error && (
        <p className="inspector-run-error" role="alert">{error}</p>
      )}
      {!loading && !error && revisions.length === 0 && (
        <p className="inspector-analysis-json-status">
          No revisions recorded for this asset.
        </p>
      )}
      <ol className="inspector-history">
        {revisions.map((revision, index) => (
          <li key={revision.hash}>
            <span className="inspector-history-index">
              {revisions.length - index}
            </span>
            <div>
              <header>
                <strong>
                  {revision.operation?.replaceAll('_', ' ') ?? 'Asset revision'}
                </strong>
                <code title={revision.hash}>{revision.hash.slice(0, 8)}</code>
              </header>
              <p>{revision.message}</p>
              <small>
                <time
                  dateTime={revision.date}
                  title={absoluteTimeLabel(revision.date)}
                >
                  {relativeTimeLabel(revision.date) ?? revision.date}
                </time>
                {revision.author ? ` · ${revision.author}` : ''}
              </small>
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}

function CellGenerationsPanel({
  attempts,
  currentExecution,
  loading,
  error,
  artifactAssets,
  onLoadPayload,
}: {
  attempts: readonly CellGenerationAttempt[]
  currentExecution: NotebookCellExecution | null
  loading: boolean
  error: string | null
  artifactAssets: ReadonlyMap<string, NotebookCellInspectorAsset>
  onLoadPayload?: (assetId: string) => Promise<unknown>
}) {
  const liveAttemptId = liveGenerationAttemptId(attempts, currentExecution)
  return (
    <section className="inspector-generations" aria-label="Generation attempts">
      <header className="inspector-source-meta">
        <span>
          <History size={14} aria-hidden="true" />
          Generations
        </span>
        <code>{attempts.length} attempt{attempts.length === 1 ? '' : 's'}</code>
      </header>
      {loading && (
        <p className="inspector-analysis-json-status" role="status">
          Loading generation history…
        </p>
      )}
      {error && (
        <p className="inspector-run-error" role="alert">{error}</p>
      )}
      {!loading && !error && attempts.length === 0 && (
        <p className="inspector-analysis-json-status">
          No generation attempts recorded for this cell.
        </p>
      )}
      <ol className="inspector-generations-list">
        {attempts.map((attempt, index) => {
          const attemptNumber = attempts.length - index
          const previewAsset = attempt.artifactId
            ? artifactAssets.get(attempt.artifactId)
            : undefined
          const mediaAsset = previewAsset ?? (
            attempt.mediaUrl || attempt.thumbnailUrl
              ? {
                  type: attempt.mediaUrl && !attempt.thumbnailUrl
                    ? 'video'
                    : 'image',
                  mediaUrl: attempt.mediaUrl,
                  thumbnailUrl: attempt.thumbnailUrl,
                  duration: null,
                }
              : null
          )
          const lastTransition = attempt.transitions.at(-1)
          const live = liveAttemptId === attempt.attemptId
          const payloadAssetId = attempt.artifactId ?? attempt.providerArtifactId
          return (
            <li
              key={attempt.attemptId}
              className={[
                'inspector-generation-attempt',
                live ? 'inspector-generation-attempt-live' : '',
              ].filter(Boolean).join(' ')}
            >
              <div className="inspector-generation-attempt-head">
                {mediaAsset ? (
                  <div className="inspector-generation-thumb">
                    <MediaLibraryAssetPreview asset={mediaAsset} />
                  </div>
                ) : (
                  <ArtifactThumb
                    asset={previewAsset}
                    kindHint="generate_image"
                  />
                )}
                <div className="inspector-generation-facts">
                  <div className="inspector-generation-attempt-title">
                    <strong>Attempt {attemptNumber}</strong>
                    <span className={`inspector-generation-status inspector-generation-status-${attempt.status}`}>
                      {attempt.status}
                    </span>
                    {live && (
                      <span className="inspector-generation-live" role="status">
                        {currentExecution?.status ?? 'running'}
                      </span>
                    )}
                  </div>
                  <span
                    className="inspector-generation-meta"
                    title={absoluteTimeLabel(attempt.createdAt)}
                  >
                    {[
                      abbreviateGenerationPhrases(attempt.tool),
                      attempt.model,
                      relativeTimeLabel(attempt.createdAt),
                    ].filter(Boolean).join(' · ')}
                  </span>
                  {lastTransition && (
                    <code
                      className="inspector-generation-commit"
                      title={lastTransition.commitHash}
                    >
                      commit {lastTransition.commitHash.slice(0, 8)}
                    </code>
                  )}
                  {(attempt.resolvedPrompt || attempt.prompt) && (
                    <p title={attempt.resolvedPrompt ?? attempt.prompt ?? undefined}>
                      {(attempt.resolvedPrompt ?? attempt.prompt ?? '').slice(0, 160)}
                    </p>
                  )}
                  {attempt.transitions.length > 0 && (
                    <ol
                      className="inspector-generation-timeline"
                      aria-label={`Attempt ${attemptNumber} status timeline`}
                    >
                      {attempt.transitions.map((transition, transitionIndex) => (
                        <li key={`${transition.commitHash}:${transitionIndex}`}>
                          <span
                            className={`inspector-generation-timeline-dot inspector-generation-timeline-dot-${transition.status}`}
                            aria-hidden="true"
                          />
                          <span>{transition.status}</span>
                          <time
                            dateTime={transition.commitDate}
                            title={absoluteTimeLabel(transition.commitDate)}
                          >
                            {relativeTimeLabel(transition.commitDate)}
                          </time>
                        </li>
                      ))}
                    </ol>
                  )}
                  {attempt.error && (
                    <p
                      className="inspector-generation-error"
                      role={attempt.status === 'failed' ? 'alert' : undefined}
                    >
                      {attempt.error}
                    </p>
                  )}
                </div>
              </div>
              {(attempt.payload !== undefined
                || (attempt.payloadAvailable && onLoadPayload)) && (
                <AnalysisJsonDisclosure
                  label="Payload"
                  value={attempt.payload}
                  loadValue={attempt.payload === undefined
                    && payloadAssetId
                    && onLoadPayload
                    ? () => onLoadPayload(payloadAssetId)
                    : undefined}
                  ariaLabel={`Generation payload for attempt ${attemptNumber}`}
                  artifactAssets={artifactAssets}
                />
              )}
            </li>
          )
        })}
      </ol>
    </section>
  )
}

export function NotebookCellInspector({
  headerActionHost,
  notebookId,
  cell,
  cells,
  edges,
  asset,
  cellAssets,
  versionAssets,
  status,
  error,
  busy,
  deleting,
  sourceVisible,
  historyVisible = false,
  generationsVisible = false,
  generationActions,
  mediaInsightWork,
  onUpdate,
  onSetInput,
  onRun,
  onDelete,
  onOpenFullscreen,
  onPreviewPayload,
  initialGenerationPreview,
  onSelectSource,
  onLoadGenerationPayload,
  onTranscribeAsset,
  onLoadTranscriptJson,
  onDownloadTranscriptSrt,
  generations,
  history,
  mentionAssets,
  voiceCatalog,
  bookId,
  tagTools,
  queuedCellIds,
  runErrors,
  jobs,
  onCancelJob,
}: NotebookCellInspectorProps) {
  const artifactAssets = inspectorArtifactAssets(
    asset,
    cellAssets,
    versionAssets,
  )
  const generationState = mediaCellGenerationState({
    cell,
    cells,
    edges,
    queuedCellIds,
    runErrors,
    jobs,
  })

  if (sourceVisible && !isNotebookGenerationCellType(cell.type)) {
    return (
      <div className="inspector-body inspector-source-body">
        <DoltCellSource
          key={cell.id}
          notebookId={notebookId}
          cell={cell}
          artifactAssets={artifactAssets}
        />
      </div>
    )
  }

  if (historyVisible) {
    return (
      <div className="inspector-body inspector-source-body">
        <CellAssetHistoryPanel
          key={cell.id}
          revisions={history?.revisions ?? []}
          loading={history?.loading ?? false}
          error={history?.error ?? null}
        />
      </div>
    )
  }

  if (generationsVisible) {
    return (
      <div className="inspector-body inspector-source-body">
        <CellGenerationsPanel
          key={cell.id}
          attempts={generations?.attempts ?? []}
          currentExecution={generations?.currentExecution ?? null}
          loading={generations?.loading ?? false}
          error={generations?.error ?? null}
          artifactAssets={artifactAssets}
          onLoadPayload={onLoadGenerationPayload}
        />
      </div>
    )
  }

  if (cell.type === 'analysis') {
    return (
      <AnalysisCellInspector
        cell={cell}
        cells={cells}
        edges={edges}
        asset={asset}
        cellAssets={cellAssets}
        versionAssets={versionAssets}
        busy={busy}
        deleting={deleting}
        onUpdate={onUpdate}
        onSetInput={onSetInput}
        onDelete={onDelete}
      />
    )
  }

  const dockKind = mediaDockKind(cell.type)
  if (dockKind) {
    return (
      <MediaCellInspector
        kind={dockKind}
        cell={cell}
        cells={cells}
        edges={edges}
        asset={asset}
        cellAssets={cellAssets}
        versionAssets={versionAssets}
        busy={busy}
        deleting={deleting}
        mediaInsightWork={mediaInsightWork}
        generationState={generationState}
        cancelJobId={generationState.kind === 'queued'
          || generationState.kind === 'generating'
          ? (jobs ?? []).find((job) =>
            job.operationId === generationState.jobId
            && typeof job.id === 'number')?.id
          : undefined}
        onUpdate={onUpdate}
        onSetInput={onSetInput}
        onRun={onRun}
        onCancelJob={onCancelJob}
        onSelectSource={onSelectSource}
        onDelete={onDelete}
        onOpenFullscreen={onOpenFullscreen}
        onTranscribeAsset={onTranscribeAsset}
        onLoadTranscriptJson={onLoadTranscriptJson}
        onDownloadTranscriptSrt={onDownloadTranscriptSrt}
        bookId={bookId}
        tagTools={tagTools}
      />
    )
  }

  return (
    <ExecutableCellInspector
      headerActionHost={headerActionHost}
      sourceVisible={sourceVisible}
      cell={cell}
      cells={cells}
      edges={edges}
      asset={asset}
      cellAssets={cellAssets}
      status={status}
      error={error}
      busy={busy}
      deleting={deleting}
      onUpdate={onUpdate}
      onSetInput={onSetInput}
      onRun={onRun}
      onDelete={onDelete}
      onOpenFullscreen={onOpenFullscreen}
      onPreviewPayload={onPreviewPayload}
      initialGenerationPreview={initialGenerationPreview}
      onSelectSource={onSelectSource}
      generationActions={generationActions}
      mentionAssets={mentionAssets}
      voiceCatalog={voiceCatalog}
    />
  )
}
