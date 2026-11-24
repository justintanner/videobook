import './Posts.css'
import type { NotebookCellType } from 'videobook-engine'
import { frameAspectRatio } from '../../../server/src/media/frame-options'
import {
  Video,
  Image,
  AudioWaveform,
  BookOpen,
  Activity,
  Braces,
  CircleDot,
  Film,
  Upload,
  Download,
  Hourglass,
  Scissors,
  Crop,
  Rewind,
  Gauge,
  Images,
  Layers2,
  Sparkles,
  Ellipsis,
  Flag,
} from 'lucide-react'
import {
  cellTypeLabel,
  formatMediaTime,
  notebookSplitRange,
  notebookCellActionPresentation,
  notebookCellIsActiveStatus,
  notebookOutputVersionArtifactIds,
  isImageVideoGenerationResultCell,
} from '@/videobook/notebook-cell-presentation'
import { postPlatformName } from '@/videobook/post-delivery-review'
import { PostTile } from '@/components/videobook/PostTile'
import type { CanvasCellData, CanvasNode, RunningTakes } from '@/videobook/notebook-canvas'
import {
  isNotebookGenerationCellType,
  notebookCellFamily,
  type NotebookCellFamily,
} from '@/videobook/notebook-cell-types'
import { notebookGridTag, notebookGridAddress } from '@/videobook/notebook-grid'
import { endCellRefDrag, setCellRefDragImage, startCellRefDrag } from '@/videobook/cell-ref-drag'
import { notebookGenerationInputKind } from '../../../server/src/notebook-generation-contract'
import type { AssetRecord } from '@/videobook/workspace-responses'
import {
  type PassiveMediaKind,
  dataTransferHasFiles,
  mediaFileAccept,
  passiveMediaKind,
  isEmptyPassiveMediaSlot,
} from '@/videobook/notebook-media-drop'
import {
  type MediaSlotState,
  MediaSlotContext,
  CellRunContext,
  CellActionsContext,
  PrimaryCellContext,
  GenerationCatalogContext,
  CellContextMenuContext,
  cellContextMenuId,
  GoalMarksContext,
  TimelineContext,
} from '@/components/videobook/notebook-canvas-context'
import {
  useRef,
  useState,
  useContext,
  useEffect,
  type ReactNode,
} from 'react'
import { BusyIndicator } from '@/components/videobook/BusyIndicator'
import {
  type NotebookSourceSide,
  notebookSourcePortOffsets,
  notebookSourcePortId,
} from '@/videobook/notebook-routing'
import {
  Position,
  type NodeProps,
  useUpdateNodeInternals,
  Handle,
} from '@xyflow/react'
import {
  asString,
  recordValue,
  asNumber,
} from '@/videobook/value-decoders'
import { abbreviateGenerationPhrases } from '@/videobook/notebook-generation-actions'
import {
  audioPreviewBadges,
  audioPreviewMeter,
  imagePreviewBadges,
  videoPreviewBadges,
  previewMeter,
  previewMetadataLabel,
  type CellPreviewBadge,
  type CellPreviewMeter,
} from '@/videobook/cell-preview'
import { notebookTypeLane } from '../../../server/src/notebook-lanes'
import {
  notebookIncomingRouteBadge,
  notebookOutgoingRouteBadge,
} from '@/videobook/notebook-route-tags'
import { CellRouteBadge } from '@/components/videobook/CellRouteBadge'
import { AnalysisCellSummary } from '@/components/videobook/AnalysisCellSummary'
import { CellMediaFrame } from '@/components/videobook/CellMediaFrame'
import { PublishedPostTileChrome } from '@/components/videobook/PublishedPostChrome'
import { CellStateOverlay } from '@/components/videobook/cell-overlays/CellStateOverlay'
import { CellClockDock } from '@/components/videobook/cell-overlays/CellClockOverlay'
import { CellGeneratorIdentity } from '@/components/videobook/cell-overlays/CellGeneratorIdentity'
import {
  generationIdentity,
  generationPromptSegments,
  type GenerationIdentity,
  type PromptSegment,
} from '@/videobook/output-generation'
import { cellStateFlag, type CellStateFlag } from '@/videobook/cell-state-flag'
import { NotebookTimeline } from '@/components/videobook/NotebookTimeline'

export function CellIcon({ kind }: { kind: NotebookCellType }) {
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
  if (kind === 'post') return <Flag size={14} />
  if (kind === 'goal') return <Flag size={14} />
  return <Film size={14} />
}

function CellStateIcon({ kind, status }: { kind: NotebookCellType; status: string }) {
  if (status === 'queued' || status.startsWith('render-queued')) return <Hourglass size={14} />
  if (status === 'downloading') return <Download size={14} />
  if (status === 'uploading') return <Upload size={14} />
  if (status === 'trimming') return <Scissors size={14} />
  if (status === 'cropping') return <Crop size={14} />
  if (status === 'reversing') return <Rewind size={14} />
  if (status === 'changing-speed') return <Gauge size={14} />
  return <CellIcon kind={kind} />
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

function slotDetail(state: MediaSlotState | undefined): string {
  if (state?.operation === 'upload') return state.fileName ?? 'Uploading your file'
  if (state?.operation === 'attach') return 'From recent media'
  return 'Recent media or drop a file'
}

function MediaSlotTile({
  cellId,
  address,
  kind,
  ready,
  state,
  onFile,
  onFileError,
  onOpenLibrary,
}: {
  cellId: string
  address: string
  kind: PassiveMediaKind
  ready: boolean
  state: MediaSlotState | undefined
  onFile: (cellId: string, file: File) => void
  onFileError: (cellId: string, message: string) => void
  onOpenLibrary: (cellId: string) => void
}) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [dragging, setDragging] = useState(false)
  const busy = state?.operation !== null && state?.operation !== undefined

  const acceptFiles = (files: FileList | null) => {
    if (busy || !ready) return
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
        event.dataTransfer.dropEffect = ready && !busy ? 'copy' : 'none'
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
        className="cell-media-slot-library"
        disabled={busy || !ready}
        onClick={(event) => {
          event.stopPropagation()
          onOpenLibrary(cellId)
        }}
      >
        {busy ? <BusyIndicator size={22} /> : <Images size={22} />}
        <strong>{busy ? 'Attaching media…' : `Add ${kind}`}</strong>
        <span className={busy ? 'cell-media-slot-file' : undefined}>{slotDetail(state)}</span>
      </button>
      <button
        type="button"
        className="cell-media-slot-upload"
        disabled={busy || !ready}
        onClick={(event) => {
          event.stopPropagation()
          inputRef.current?.click()
        }}
      >
        <Upload size={13} />Upload file
      </button>
      <input
        ref={inputRef}
        className="cell-media-slot-input"
        type="file"
        accept={mediaFileAccept[kind]}
        disabled={busy || !ready}
        onChange={(event) => {
          acceptFiles(event.target.files)
          event.target.value = ''
        }}
      />
      {dragging && (
        <span className="cell-media-slot-release" aria-hidden="true">
          <Upload size={22} />
          <strong>Release to add</strong>
          <span>Drops into {address}</span>
        </span>
      )}
      {state?.error && <span className="cell-media-slot-error" role="alert">{state.error}</span>}
    </section>
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

type CellFact = {
  key: string
  label: string
  title: string
}

type CellSourceDetail = {
  node: ReactNode
  label: string
}

function CellFlag({ flag }: { flag: CellStateFlag | null }) {
  if (!flag) return null
  return (
    <span className="cell-state-flag" data-tone={flag.tone} title={flag.label}>
      <span>{flag.label}</span>
    </span>
  )
}

function CellRefAddress({
  cellId,
  address,
  family,
  draggable,
}: {
  cellId: string
  address: string
  family: NotebookCellFamily
  draggable: boolean
}) {
  const draggingRef = useRef(false)
  const [lifted, setLifted] = useState(false)
  if (!draggable) return <strong className="cell-ref-address">{address}</strong>
  return (
    <strong
      className={`cell-ref-address cell-ref-address-draggable nodrag nopan${lifted ? ' cell-ref-address-lifted' : ''}`}
      draggable
      title="Drag into an input slot"
      onDragStart={(event) => {
        event.stopPropagation()
        startCellRefDrag(event, { sourceCellId: cellId, from: null })
        setCellRefDragImage(event, address, family)
        draggingRef.current = true
        requestAnimationFrame(() => {
          if (draggingRef.current) setLifted(true)
        })
      }}
      onDragEnd={() => {
        draggingRef.current = false
        endCellRefDrag()
        setLifted(false)
      }}
    >
      {address}
    </strong>
  )
}

function CellFooterFacts({
  label,
  meter,
  facts,
}: {
  label: string
  meter: CellPreviewMeter | null
  facts: readonly CellFact[]
}) {
  if (!meter && facts.length === 0) return null
  return (
    <span className="cell-node-footer-meta" role="group" aria-label={label}>
      {meter && (
        <time
          className="cell-node-footer-meter"
          dateTime={`PT${meter.seconds}S`}
          title="Duration"
        >
          {meter.label}
        </time>
      )}
      {facts.map((fact) => (
        <span key={fact.key} className="cell-media-badge" title={fact.title}>
          {fact.label}
        </span>
      ))}
    </span>
  )
}

function VersionCount({ active, total }: { active: number; total: number }) {
  return (
    <span
      className="cell-version-count"
      aria-label={`Current output version ${active} of ${total}`}
      title={`Current output · version ${active} of ${total}`}
    >
      <Layers2 size={12} aria-hidden="true" />
      v{active}/{total}
    </span>
  )
}

function GoalMark({ mark }: { mark: string }) {
  return (
    <span className="cell-generation-chips">
      <span className="cell-aspect-ratio cell-goal-mark" title={`Goal ${mark}`}>
        <Flag size={9} aria-hidden="true" />
        {mark.split(' · ')[0]}
      </span>
    </span>
  )
}

function promptTokenFamily(token: string): 'image' | 'video' | 'audio' {
  if (token.startsWith('video')) return 'video'
  if (token.startsWith('audio')) return 'audio'
  return 'image'
}

function placedPromptSegments(prompt: string): Array<PromptSegment & { start: number }> {
  return generationPromptSegments(prompt).reduce<Array<PromptSegment & { start: number }>>(
    (placed, segment) => {
      const previous = placed.at(-1)
      const start = previous ? previous.start + previous.text.length : 0
      return [...placed, { ...segment, start }]
    },
    [],
  )
}

function GenerationPromptText({ prompt }: { prompt: string }) {
  return placedPromptSegments(prompt).map((segment) => segment.token
    ? (
      <span key={segment.start} className="cell-prompt-token" data-family={promptTokenFamily(segment.token)}>
        {segment.text}
      </span>
    )
    : <span key={segment.start}>{segment.text}</span>)
}

function GenerationRecipe({
  provider,
  modelLine,
  prompt,
  promptRequired,
}: {
  provider: string | null
  modelLine: string | null
  prompt: string | null
  promptRequired: boolean
}) {
  if (!modelLine) {
    return (
      <div className="cell-copy cell-generation-choose">
        <Sparkles size={26} aria-hidden="true" />
        <strong>Choose a generation action</strong>
        <span>Open the cell to pick a model</span>
      </div>
    )
  }
  return (
    <div className="cell-copy cell-copy-text">
      <span className="cell-generation-model">
        {provider && <span className="cell-generator-provider">{provider}</span>}
        <span className="cell-model-line" title={modelLine}>{modelLine}</span>
      </span>
      {prompt
        ? <p title={prompt}><GenerationPromptText prompt={prompt} /></p>
        : (
          <span className="cell-generation-prompt-empty">
            {promptRequired ? 'Add a prompt. Name inputs like @image1.' : 'Prompt optional'}
          </span>
        )}
    </div>
  )
}

function displayedIdentity(identity: GenerationIdentity, title: string | null): GenerationIdentity {
  const name = title ?? identity.model
  return {
    ...identity,
    model: name ? abbreviateGenerationPhrases(name) : null,
  }
}

function generatorDetail(identity: GenerationIdentity, title: string | null): CellSourceDetail {
  return {
    node: <CellGeneratorIdentity identity={displayedIdentity(identity, title)} className="cell-route-generator" />,
    label: `Made with ${identity.label}`,
  }
}

function frameDetail(
  provenance: CanvasCellData['frameProvenance'],
  hasIncoming: boolean,
): CellSourceDetail | null {
  if (!provenance || provenance.atSeconds === null) return null
  const time = formatMediaTime(provenance.atSeconds)
  const from = hasIncoming ? null : provenance.sourceAddress?.replace(/^@/u, '') ?? null
  return {
    node: <span className="cell-route-time">{from ? `${from} · ${time}` : time}</span>,
    label: `Frame at ${time}`,
  }
}

function cellSourceDetail({
  generator,
  generatorTitle,
  toolName,
  frameProvenance,
  hasIncoming,
}: {
  generator: GenerationIdentity | null
  generatorTitle: string | null
  toolName: string | null
  frameProvenance: CanvasCellData['frameProvenance']
  hasIncoming: boolean
}): CellSourceDetail | null {
  if (generator) return generatorDetail(generator, generatorTitle)
  const frame = frameDetail(frameProvenance, hasIncoming)
  if (frame) return frame
  return toolName
    ? generatorDetail({ provider: null, model: toolName, label: toolName }, null)
    : null
}

function mediaFacts(badges: readonly CellPreviewBadge[]): CellFact[] {
  return [...badges]
    .sort((left, right) => Number(right.key === 'aspect') - Number(left.key === 'aspect'))
    .map((badge) => ({ key: badge.key, label: badge.label, title: badge.title }))
}

function generationFacts(duration: string | null, aspectRatio: string | null): CellFact[] {
  return [
    duration
      ? { key: 'duration', label: /^\d+(\.\d+)?$/.test(duration) ? `${duration}s` : duration, title: 'Duration' }
      : null,
    aspectRatio ? { key: 'aspect', label: aspectRatio, title: 'Aspect ratio' } : null,
  ].filter((fact): fact is CellFact => fact !== null)
}

function runningTakesDetail(runningTakes: RunningTakes): string {
  return `${runningTakes.count} ${runningTakes.count === 1 ? 'take' : 'takes'} running`
}

function timestampValue(value: string | undefined): number | null {
  const parsed = value ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : null
}

function generationDurationSetting(settings: Record<string, unknown> | null): string | null {
  if (!settings) return null
  return asString(settings.duration)
    ?? asString(settings.duration_seconds)
    ?? (typeof settings.duration === 'number' ? String(settings.duration) : null)
}

function generationModelLine(title: string | null, mode: string | null): string | null {
  if (!title) return null
  const abbreviated = abbreviateGenerationPhrases(title)
  const modeAbbreviation = mode && /^[a-z]2[a-z]$/i.test(mode) ? mode.toUpperCase() : null
  return modeAbbreviation && !abbreviated.toUpperCase().includes(modeAbbreviation)
    ? `${abbreviated} · ${modeAbbreviation}`
    : abbreviated
}

export function CellNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const slotContext = useContext(MediaSlotContext)
  const runCell = useContext(CellRunContext)
  const cellActions = useContext(CellActionsContext)
  const failedDownload = data.asset?.failedDownload
  const downloadRetry = failedDownload && (failedDownload.signInRequired && failedDownload.chromeRetryAvailable ? 'chrome' : 'standard')
  const primaryCellId = useContext(PrimaryCellContext)
  const generationCatalog = useContext(GenerationCatalogContext)
  const contextMenu = useContext(CellContextMenuContext)
  const goalMark = useContext(GoalMarksContext).get(id) ?? null
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
  const inputKind = data.outputArtifactId ? notebookGenerationInputKind({ type: data.kind }) : null
  const generationCell = isNotebookGenerationCellType(data.kind)
  const generationResult = isImageVideoGenerationResultCell({
    type: data.kind,
    inputs: data.inputs,
  })
  const generationRun = generationCell || generationResult
  const generator = generationRun
    ? generationIdentity(
      data.provider ?? data.producerProvider,
      data.model ?? data.producerModel,
    )
    : null
  const catalogEntry = data.model ? generationCatalog.get(data.model) : undefined
  const modelLine = generationCell
    ? generationModelLine(
      catalogEntry?.title ?? generator?.model ?? data.model ?? data.tool ?? null,
      asString(data.inputs?.generationMode),
    )
    : null
  const generationSettings = generationCell
    ? recordValue(data.inputs?.generationSettings)
    : null
  const aspectRatio = frameAspectRatio(data.model ?? '', data.inputs ?? {}) ?? (generationSettings
    ? asString(generationSettings.aspect_ratio)
    : null)
  const generationDuration = generationDurationSetting(generationSettings)
  const typeLabel = cellTypeLabel(data.kind)
  const resolvedPrompt = asString(data.prompt) || asString(data.inputs?.resolvedPrompt)
  const imagePrompt = imageMediaCell
    ? resolvedPrompt ?? data.asset?.prompt ?? null
    : null
  const generationPrompt = generationCell ? data.prompt?.trim() || null : null
  const promptCell = textCell
  const address = notebookGridTag(data.slot)
  const audioPreviewInput = {
    audioInfo: data.asset?.audioInfo ?? null,
    durationSeconds: data.asset?.duration ?? null,
    hasOutput: Boolean(data.outputArtifactId),
    inputs: data.inputs,
  }
  const audioPreviewCell = audioCell && playableAudio
  const visualPreviewCell = visualMediaCell && Boolean(mediaUrl || thumbnailUrl)
  const mediaTile = visualPreviewCell && !emptyMediaSlot && data.kind !== 'post'
  const running = notebookCellIsActiveStatus(data.status)
  const failed = data.status === 'error' || data.post?.runtime.status === 'failed'
  const audioBadges = audioPreviewCell ? audioPreviewBadges(audioPreviewInput) : []
  const audioMeter = audioPreviewCell ? audioPreviewMeter(audioPreviewInput) : null
  const visualBadges = !visualPreviewCell
    ? []
    : imageMediaCell
      ? imagePreviewBadges({
        width: data.asset?.width ?? null,
        height: data.asset?.height ?? null,
        tool: null,
        model: null,
        provenance: null,
      })
      : videoPreviewBadges({
        aspectRatio: data.videoAspectRatio ?? null,
        width: data.asset?.width ?? null,
        height: data.asset?.height ?? null,
        tool: null,
        model: null,
        provenance: null,
      })
  const visualMeter = visualPreviewCell && playableVideo
    ? previewMeter(data.videoDurationSeconds ?? data.asset?.duration ?? null)
    : null
  const visualMetadataLabel = previewMetadataLabel(typeLabel, visualBadges, visualMeter, imagePrompt)
  const incomingBadge = notebookIncomingRouteBadge(data.incomingRoutes ?? [])
  const outgoingBadge = notebookOutgoingRouteBadge(data.outgoingRoutes ?? [])
  const sourceDetail = visualMediaCell && !emptyMediaSlot
    ? cellSourceDetail({
      generator: generationResult ? generator : null,
      generatorTitle: generationResult
        ? generationCatalog.get(data.model ?? data.producerModel ?? '')?.title ?? null
        : null,
      toolName: mediaTile && data.model
        ? catalogEntry?.title ?? data.model
        : mediaTile ? data.tool ?? null : null,
      frameProvenance: data.frameProvenance,
      hasIncoming: Boolean(incomingBadge),
    })
    : null
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
  const flag = cellStateFlag({
    kind: data.kind,
    status: failedDownload ? 'error' : data.status,
    post: data.post,
    slotOperation: emptyMediaSlot ? slotContext.states[id]?.operation ?? null : null,
    runningTakes: data.runningTakes?.count ?? 0,
    promptMissing: generationCell && Boolean(modelLine) && !generationPrompt
      && catalogEntry?.promptRequired === true,
  })
  const facts: CellFact[] = mediaTile
    ? mediaFacts(visualBadges)
    : generationCell
      ? generationFacts(generationDuration, aspectRatio)
      : data.post
        ? [{ key: 'platform', label: postPlatformName(data.post), title: 'Platform' }]
        : []
  const factsLabel = mediaTile
    ? visualMetadataLabel
    : [typeLabel, ...facts.map((fact) => fact.label)].join(' · ')
  const showFacts = !flag || data.kind === 'post'
  const bareHeader = visualMediaCell || data.kind === 'post'
  const takesRunning = generationCell && !running && !failed && data.runningTakes
    ? data.runningTakes
    : null
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
        `cell-family-${notebookCellFamily(data.kind)}`,
        selected ? 'cell-node-selected' : '',
        primarySelected ? 'cell-node-primary' : '',
        running ? 'cell-node-running' : '',
        data.status === 'queued' ? 'cell-node-queued' : '',
        failed ? 'cell-node-error' : '',
        versionedOutput ? 'cell-node-version-stack' : '',
        data.deleting ? 'cell-node-deleting' : '',
        data.revealing ? 'cell-node-created' : '',
        data.highlighted ? 'cell-node-highlight' : '',
        mediaTile ? 'cell-node-media-tile' : '',
        bareHeader ? 'cell-node-bare' : '',
        incomingBadge || sourceDetail ? 'cell-node-has-inputs' : '',
        flag?.tone === 'attention' ? 'cell-node-attention' : '',
      ].filter(Boolean).join(' ')}
      aria-busy={running}
      data-lane-family={data.lane ?? notebookTypeLane(data.kind)}
      data-selection={primarySelected ? 'primary' : selected ? 'selected' : undefined}
      data-highlight={data.highlighted ? 'generated' : undefined}
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
      <CellRouteBadge
        direction="incoming"
        badge={incomingBadge}
        detail={sourceDetail?.node ?? null}
        detailLabel={sourceDetail?.label ?? null}
      />
      <section className="cell-node-shell">
        {bareHeader ? (goalMark ? (
          <header className="cell-node-header cell-node-header-overlay">
            <GoalMark mark={goalMark} />
          </header>
        ) : null) : (
          <header className="cell-node-header">
            <span className="cell-node-type" aria-label={typeLabel}>
              <CellIcon kind={data.kind} />
              <span className="cell-node-type-label" aria-hidden="true">
                {typeLabel}
              </span>
            </span>
            {goalMark && <GoalMark mark={goalMark} />}
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
            {!action && versionedOutput && (
              <VersionCount active={activeOutputVersion} total={outputVersions.length} />
            )}
          </header>
        )}
        <div className="cell-node-body">
        {failedDownload ? null : data.kind === 'post' ? (
          <PostTile
            post={data.post}
            source={data.postSource}
            onSourceDrop={data.post && !data.post.definition.source && cellActions.ready
              ? (sourceCellId) => void cellActions.setPostSource(id, sourceCellId)
              : undefined}
            onRetry={data.post?.runtime.status === 'failed' && data.post.definition.platform === 'x' && cellActions.ready
              ? () => void cellActions.retryPost(id)
              : undefined}
          />
        ) : emptyMediaSlot && slotKind ? (
          <MediaSlotTile
            cellId={id}
            address={address}
            kind={slotKind}
            ready={slotContext.ready}
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
        ) : audioPreviewCell ? (
          <CellMediaFrame
            posterUrl={null}
            waveform={data.asset?.waveform ?? []}
            alt={data.label ?? address}
            badges={audioBadges}
            meter={audioMeter}
            metadataLabel={previewMetadataLabel(typeLabel, audioBadges, audioMeter, null)}
            pendingLabel="Waveform pending"
            pendingIcon={<AudioWaveform size={26} aria-hidden="true" />}
          />
        ) : visualPreviewCell ? (
          <CellMediaFrame
            posterUrl={thumbnailUrl ?? (playableVideo ? null : mediaUrl ?? null)}
            waveform={null}
            alt={data.label ?? address}
            title={imagePrompt ?? undefined}
            badges={[]}
            meter={null}
            metadataLabel={visualMetadataLabel}
            pendingLabel="Poster pending"
            pendingIcon={<Film size={26} aria-hidden="true" />}
          >
            <PublishedPostTileChrome inputs={data.inputs} />
          </CellMediaFrame>
        ) : generationCell ? (
          <GenerationRecipe
            provider={generator?.provider ?? null}
            modelLine={modelLine}
            prompt={generationPrompt}
            promptRequired={catalogEntry?.promptRequired !== false}
          />
        ) : (
          <div className={`cell-copy ${promptCell ? 'cell-copy-text' : ''}`}>
            {promptCell ? <p title={data.prompt || undefined}>{data.prompt || emptyCellLabel(data)}</p> : <Sparkles size={28} />}
            {!promptCell && <span>{emptyCellLabel(data)}</span>}
          </div>
        )}
        <CellStateOverlay
          kind={data.kind}
          address={notebookGridAddress(data.slot)}
          status={data.status}
          statusStartedAt={data.statusStartedAt}
          statusError={data.statusError}
          icon={<CellStateIcon kind={data.kind} status={data.status} />}
          generation={generationRun}
          docked={generationCell}
          overPicture={mediaTile}
          onRepair={generationRun ? () => {
            void cellActions.repairCell(id)
          } : undefined}
          downloadRetry={downloadRetry}
          onRetry={failedDownload
            ? () => void cellActions.retryDownload(failedDownload.jobId, downloadRetry === 'chrome')
            : data.inputs?.producerCellId ? () => void cellActions.retryCell(id) : undefined}
          disabled={!cellActions.ready}
          onDelete={() => {
            void cellActions.deleteCell(id)
          }}
        />
        {takesRunning && (
          <CellClockDock
            label="Takes running"
            detail={runningTakesDetail(takesRunning)}
            address={notebookGridAddress(data.slot)}
            startedAt={timestampValue(takesRunning.startedAt)}
          />
        )}
        </div>
        <footer className="cell-node-footer">
          <CellRefAddress
            cellId={id}
            address={address}
            family={notebookCellFamily(data.kind)}
            draggable={Boolean(inputKind)}
          />
          {showFacts && (
            <CellFooterFacts
              label={factsLabel}
              meter={mediaTile ? visualMeter : null}
              facts={facts}
            />
          )}
          <span className="cell-node-footer-actions">
            {mediaTile && versionedOutput && (
              <VersionCount active={activeOutputVersion} total={outputVersions.length} />
            )}
            <CellFlag flag={flag} />
            <button
              type="button"
              className="cell-context-menu-trigger nodrag"
              aria-label={`Open ${address} cell menu`}
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
          <CellRouteBadge direction="outgoing" badge={outgoingBadge} />
        </footer>
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

export function TimelineNode({ id, data }: NodeProps<CanvasNode>) {
  const context = useContext(TimelineContext)
  if (!context) return null
  return <NotebookTimeline {...context} address={notebookGridTag(data.slot)}
    onSeek={(frame) => context.onSeek(id, frame)}
    onPreview={() => context.onPreview(id)}
    onRemove={() => context.onRemove(id)} />
}
