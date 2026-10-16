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
  Images,
  Check,
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
  notebookCellStatusLabel,
  notebookCellIsActiveStatus,
  notebookOutputVersionArtifactIds,
  isImageVideoGenerationResultCell,
} from '@/videobook/notebook-cell-presentation'
import { postPlatformName, postTileStatus } from '@/videobook/post-delivery-review'
import { PostTile } from '@/components/videobook/PostTile'
import type { CanvasCellData, CanvasNode } from '@/videobook/notebook-canvas'
import { isNotebookGenerationCellType, notebookCellFamily } from '@/videobook/notebook-cell-types'
import { notebookGridTag, notebookGridAddress } from '@/videobook/notebook-grid'
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
  PrimaryCellContext,
  GenerationTitlesContext,
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
} from '@/videobook/cell-preview'
import { notebookLaneFamily } from '@/videobook/notebook-lane-policy'
import { AnalysisCellSummary } from '@/components/videobook/AnalysisCellSummary'
import { CellMediaFrame } from '@/components/videobook/CellMediaFrame'
import { PublishedPostTileChrome } from '@/components/videobook/PublishedPostChrome'
import { CellStateOverlay } from '@/components/videobook/cell-overlays/CellStateOverlay'
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

function compactCellTypeLabel(kind: NotebookCellType): string {
  if (kind === 'generate_video') return 'GEN VID'
  if (kind === 'generate_image') return 'GEN IMG'
  if (kind === 'generate_audio') return 'GEN AUD'
  return cellTypeLabel(kind)
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

function MediaSlotTile({
  cellId,
  kind,
  ready,
  state,
  onFile,
  onFileError,
  onOpenLibrary,
}: {
  cellId: string
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
        <span>Recent media or drop a file</span>
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

export function CellNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const slotContext = useContext(MediaSlotContext)
  const runCell = useContext(CellRunContext)
  const primaryCellId = useContext(PrimaryCellContext)
  const generationTitles = useContext(GenerationTitlesContext)
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
  const statusLabel = data.post ? postTileStatus(data.post) : notebookCellStatusLabel(data.kind, data.status)
  const generationCell = isNotebookGenerationCellType(data.kind)
  const toolTitle = generationCell && data.model
    ? generationTitles.get(data.model) ?? null
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
  const aspectRatio = frameAspectRatio(data.model ?? '', data.inputs ?? {}) ?? (generationSettings
    ? asString(generationSettings.aspect_ratio)
    : null)
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
  const resolvedPrompt = asString(data.prompt) || asString(data.inputs?.resolvedPrompt)
  const imagePrompt = imageMediaCell
    ? resolvedPrompt ?? data.asset?.prompt ?? null
    : null
  const imageToolTitle = imageMediaCell && data.model
    ? generationTitles.get(data.model) ?? null
    : null
  const promptCell = textCell || (generationCell && Boolean(data.prompt))
  const address = notebookGridTag(data.slot)
  const frameProvenance = data.frameProvenance
    ? [
        data.frameProvenance.sourceAddress,
        data.frameProvenance.atSeconds === null
          ? null
          : formatMediaTime(data.frameProvenance.atSeconds),
      ].filter(Boolean).join(' · ') || null
    : null
  const audioPreviewInput = {
    audioInfo: data.asset?.audioInfo ?? null,
    durationSeconds: data.asset?.duration ?? null,
    hasOutput: Boolean(data.outputArtifactId),
    inputs: data.inputs,
  }
  const audioPreviewCell = audioCell && playableAudio
  const visualPreviewCell = visualMediaCell && Boolean(mediaUrl || thumbnailUrl)
  const audioBadges = audioPreviewCell ? audioPreviewBadges(audioPreviewInput) : []
  const audioMeter = audioPreviewCell ? audioPreviewMeter(audioPreviewInput) : null
  const visualBadges = !visualPreviewCell
    ? []
    : imageMediaCell
      ? imagePreviewBadges({
        width: data.asset?.width ?? null,
        height: data.asset?.height ?? null,
        tool: imageToolTitle,
        model: data.model ?? data.tool ?? null,
        provenance: frameProvenance,
      })
      : videoPreviewBadges({
        aspectRatio: data.videoAspectRatio ?? null,
        width: data.asset?.width ?? null,
        height: data.asset?.height ?? null,
        tool: data.model ? generationTitles.get(data.model) ?? null : null,
        model: data.model ?? data.tool ?? null,
        provenance: frameProvenance,
      })
  const visualMeter = visualPreviewCell && playableVideo
    ? previewMeter(data.videoDurationSeconds ?? data.asset?.duration ?? null)
    : null
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
      ].filter(Boolean).join(' ')}
      aria-busy={running}
      data-lane-family={notebookLaneFamily(data.kind)}
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
          {data.post && (
            <span className="cell-generation-chips">
              <span className="cell-aspect-ratio" title="Platform">{postPlatformName(data.post)}</span>
            </span>
          )}
          {(generationCell || goalMark) && (
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
              {goalMark && (
                <span className="cell-aspect-ratio cell-goal-mark" title={`Goal ${goalMark}`}>
                  <Flag size={9} aria-hidden="true" />
                  {goalMark.split(' · ')[0]}
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
        {data.kind === 'post' ? (
          <PostTile post={data.post} source={data.postSource} />
        ) : emptyMediaSlot && slotKind ? (
          <MediaSlotTile
            cellId={id}
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
            address={address}
            posterUrl={null}
            waveform={data.asset?.waveform ?? []}
            mediaUrl={mediaUrl ?? null}
            playbackKind={mediaUrl ? 'audio' : null}
            alt={data.label ?? address}
            badges={audioBadges}
            meter={audioMeter}
            metadataLabel={previewMetadataLabel(typeLabel, audioBadges, audioMeter, null)}
            pendingLabel="Waveform pending"
            pendingIcon={<AudioWaveform size={26} aria-hidden="true" />}
          />
        ) : visualPreviewCell ? (
          <CellMediaFrame
            address={address}
            posterUrl={thumbnailUrl ?? (playableVideo ? null : mediaUrl ?? null)}
            waveform={null}
            mediaUrl={mediaUrl ?? null}
            playbackKind={playableVideo && mediaUrl ? 'video' : null}
            alt={data.label ?? address}
            title={imagePrompt ?? undefined}
            badges={visualBadges}
            meter={visualMeter}
            metadataLabel={previewMetadataLabel(typeLabel, visualBadges, visualMeter, imagePrompt)}
            pendingLabel="Poster pending"
            pendingIcon={<Film size={26} aria-hidden="true" />}
          >
            <PublishedPostTileChrome inputs={data.inputs} />
          </CellMediaFrame>
        ) : (
          <div className={`cell-copy ${promptCell ? 'cell-copy-text' : ''}`}>
            {modelLine && <span className="cell-model-line" title={modelLine}>{modelLine}</span>}
            {promptCell ? <p title={data.prompt || undefined}>{data.prompt || emptyCellLabel(data)}</p> : <Sparkles size={28} />}
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

export function TimelineNode({ id, data }: NodeProps<CanvasNode>) {
  const context = useContext(TimelineContext)
  if (!context) return null
  return <NotebookTimeline {...context} address={notebookGridTag(data.slot)}
    onSeek={(frame) => context.onSeek(id, frame)}
    onPreview={() => context.onPreview(id)}
    onRemove={() => context.onRemove(id)} />
}
