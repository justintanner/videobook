import {
  Camera,
  Eraser,
  Eye,
  EyeOff,
  Layers2,
  RotateCw,
  SquareDashed,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { BusyIndicator } from '@/components/videobook/BusyIndicator'
import type { ImageSubject, ImageSubjectMap } from '@/videobook/image-subject-map'
import {
  bestSubjectSnap,
  canSubmitRegionReplacements,
  imageEditSelectionPayload,
  imageReplacementTargets,
  nextRegionId,
  pointerToNormalizedPoint,
  regionBoxFromDrag,
  regionReplacementPayload,
  snapRegionToSubject,
  type ImageEditRegion,
  type ImageEditSelection,
  type ImageRegionReplacement,
} from '@/videobook/image-edit-regions'
import type { NotebookCellInspectorAsset } from './NotebookCellInspector'

export type ImageSubjectEditInput = {
  operation: 'remove' | 'edit' | 'replace'
  subjectIds: string[]
  prompt?: string
  regions?: ImageRegionReplacement[]
}

export type ImageReplacementCandidate = {
  artifactId: string
  address: string
  label: string
  thumbnailUrl: string | null
}

type NotebookMediaFullscreenProps = {
  asset: NotebookCellInspectorAsset
  address: string
  subjectMap?: ImageSubjectMap | null
  subjectMapLoading?: boolean
  analysisUnavailableReason?: string | null
  composerEditing?: boolean
  composerPortalRef?: (element: HTMLDivElement | null) => void
  returnFocus?: HTMLElement | null
  initialRegions?: readonly ImageEditRegion[]
  replacementCandidates?: readonly ImageReplacementCandidate[]
  onAnalyzeSubjects?: (force?: boolean) => Promise<void>
  onCaptureFrame?: (timestampSeconds: number) => Promise<string>
  onEditingChange?: (editing: boolean) => void
  onEditSubjects?: (input: ImageSubjectEditInput) => Promise<boolean>
  onSelectedSubjectIdsChange?: (subjectIds: readonly string[]) => void
  onSelectionChange?: (selection: ImageEditSelection) => void
  onClose: () => void
}

const REGION_COLOR = '#f5d76e'

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter((element) => !element.hidden)
}

function subjectBox(subject: ImageSubject, width: number, height: number) {
  if (!subject.box) return null
  return {
    x: subject.box.x * width,
    y: subject.box.y * height,
    width: subject.box.width * width,
    height: subject.box.height * height,
  }
}

function regionPixelBox(region: ImageEditRegion, width: number, height: number) {
  return {
    x: region.box.x * width,
    y: region.box.y * height,
    width: region.box.width * width,
    height: region.box.height * height,
  }
}

function viewBoxPoint(
  event: ReactPointerEvent<SVGSVGElement>,
  width: number,
  height: number,
) {
  const svg = event.currentTarget
  const ctm = svg.getScreenCTM()
  if (ctm && 'createSVGPoint' in svg) {
    const point = svg.createSVGPoint()
    point.x = event.clientX
    point.y = event.clientY
    const local = point.matrixTransform(ctm.inverse())
    return {
      x: Math.min(1, Math.max(0, width > 0 ? local.x / width : 0)),
      y: Math.min(1, Math.max(0, height > 0 ? local.y / height : 0)),
    }
  }
  return pointerToNormalizedPoint(
    event.clientX,
    event.clientY,
    svg.getBoundingClientRect(),
  )
}

function ImageSubjectOverlay({
  mediaUrl,
  width,
  height,
  subjectMap,
  selectedIds,
  hiddenIds,
  regions,
  selectedRegionIds,
  drawMode,
  draftBox,
  snapRegionId,
  opacity,
  onToggle,
  onToggleRegion,
  onHoverRegion,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: {
  mediaUrl: string
  width: number
  height: number
  subjectMap: ImageSubjectMap | null
  selectedIds: ReadonlySet<string>
  hiddenIds: ReadonlySet<string>
  regions: readonly ImageEditRegion[]
  selectedRegionIds: ReadonlySet<string>
  drawMode: boolean
  draftBox: ImageEditRegion['box'] | null
  snapRegionId: string | null
  opacity: number
  onToggle: (subjectId: string) => void
  onToggleRegion: (regionId: string) => void
  onHoverRegion: (regionId: string | null) => void
  onPointerDown: (event: ReactPointerEvent<SVGSVGElement>) => void
  onPointerMove: (event: ReactPointerEvent<SVGSVGElement>) => void
  onPointerUp: (event: ReactPointerEvent<SVGSVGElement>) => void
}) {
  const subjects = subjectMap?.subjects ?? []
  if (width <= 0 || height <= 0) {
    return <img src={mediaUrl} alt="" />
  }
  return (
    <svg
      className={`notebook-subject-stage-svg${drawMode ? ' drawing' : ''}`}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMidYMid meet"
      role="group"
      aria-label="Image with detected subject overlays"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <title>Detected people and objects</title>
      <image
        href={mediaUrl}
        width={width}
        height={height}
        preserveAspectRatio="xMidYMid meet"
      />
      {drawMode && (
        <rect
          className="notebook-region-draw-layer"
          width={width}
          height={height}
          fill="transparent"
        />
      )}
      <defs>
        {subjects.map((subject, index) => {
          if (!subject.layerUrl) return null
          return (
            <mask
              key={subject.id}
              id={`notebook-subject-mask-${index}`}
              className="notebook-subject-mask"
              maskUnits="userSpaceOnUse"
              x="0"
              y="0"
              width={width}
              height={height}
            >
              <image
                href={subject.layerUrl}
                width={width}
                height={height}
                preserveAspectRatio="none"
              />
            </mask>
          )
        })}
      </defs>
      {subjects.map((subject, index) => {
        if (hiddenIds.has(subject.id)) return null
        const box = subjectBox(subject, width, height)
        const selected = selectedIds.has(subject.id)
        return (
          <g
            key={subject.id}
            className={`notebook-subject-overlay${selected ? ' selected' : ''}`}
            onClick={(event) => {
              if (drawMode) return
              event.stopPropagation()
              onToggle(subject.id)
            }}
            onKeyDown={(event) => {
              if (drawMode) return
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              onToggle(subject.id)
            }}
            role="button"
            tabIndex={drawMode ? -1 : 0}
            aria-label={`${selected ? 'Deselect' : 'Select'} ${subject.label}`}
            aria-pressed={selected}
          >
            <title>{subject.label}</title>
            {subject.layerUrl ? (
              <rect
                width={width}
                height={height}
                fill={subject.color}
                fillOpacity={selected ? Math.min(0.9, opacity + 0.18) : opacity}
                mask={`url(#notebook-subject-mask-${index})`}
                pointerEvents="none"
              />
            ) : box ? (
              <rect
                {...box}
                fill={subject.color}
                fillOpacity={selected ? Math.min(0.72, opacity + 0.14) : opacity}
                pointerEvents="none"
              />
            ) : null}
            {box && (
              <rect
                {...box}
                className="notebook-subject-outline"
                fill="none"
                stroke={selected ? '#ffffff' : subject.color}
                strokeWidth={Math.max(2, width / 480)}
                strokeDasharray={selected ? `${width / 100} ${width / 180}` : undefined}
                vectorEffect="non-scaling-stroke"
              />
            )}
            {box && (
              <rect
                {...box}
                className="notebook-subject-hit"
                fill="transparent"
                pointerEvents={drawMode ? 'none' : 'all'}
              />
            )}
          </g>
        )
      })}
      {regions.map((region, index) => {
        const box = regionPixelBox(region, width, height)
        const selected = selectedRegionIds.has(region.id)
        return (
          <g
            key={region.id}
            className={`notebook-subject-overlay notebook-region-overlay${selected ? ' selected' : ''}`}
            onClick={(event) => {
              if (drawMode) return
              event.stopPropagation()
              onToggleRegion(region.id)
            }}
            onPointerEnter={() => onHoverRegion(region.id)}
            onPointerLeave={() => onHoverRegion(null)}
            role="button"
            tabIndex={drawMode ? -1 : 0}
            aria-label={`${selected ? 'Deselect' : 'Select'} region ${index + 1}`}
            aria-pressed={selected}
          >
            <title>
              {region.matchedSubjectId
                ? `Region ${index + 1} snapped to subject`
                : `Drawn region ${index + 1}`}
            </title>
            <rect
              {...box}
              fill={REGION_COLOR}
              fillOpacity={selected ? 0.28 : 0.16}
              pointerEvents="none"
            />
            <rect
              {...box}
              className="notebook-subject-outline"
              fill="none"
              stroke={selected ? '#ffffff' : REGION_COLOR}
              strokeWidth={Math.max(2, width / 480)}
              strokeDasharray={`${width / 90} ${width / 160}`}
              vectorEffect="non-scaling-stroke"
            />
            <rect
              {...box}
              className="notebook-subject-hit"
              fill="transparent"
              pointerEvents={drawMode ? 'none' : 'all'}
            />
            {snapRegionId === region.id && (
              <title>Snap to nearby subject available</title>
            )}
          </g>
        )
      })}
      {draftBox && (
        <rect
          x={draftBox.x * width}
          y={draftBox.y * height}
          width={draftBox.width * width}
          height={draftBox.height * height}
          className="notebook-region-draft"
          fill={REGION_COLOR}
          fillOpacity={0.18}
          stroke={REGION_COLOR}
          strokeWidth={Math.max(2, width / 480)}
          strokeDasharray={`${width / 80} ${width / 140}`}
          pointerEvents="none"
        />
      )}
    </svg>
  )
}

function ImageRemovalPreview({
  mediaUrl,
  subjectMap,
  selectedIds,
}: {
  mediaUrl: string
  subjectMap: ImageSubjectMap
  selectedIds: ReadonlySet<string>
}) {
  const width = subjectMap.width ?? 0
  const height = subjectMap.height ?? 0
  if (!subjectMap.baseUrl || width <= 0 || height <= 0) {
    return <img src={mediaUrl} alt="" />
  }
  return (
    <svg
      className="notebook-subject-stage-svg"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Preview with selected subjects removed"
    >
      <title>Removal preview</title>
      <image
        href={subjectMap.baseUrl}
        width={width}
        height={height}
        preserveAspectRatio="xMidYMid meet"
      />
      {subjectMap.subjects.map((subject) => (
        !selectedIds.has(subject.id) && subject.layerUrl
          ? (
              <image
                key={subject.id}
                href={subject.layerUrl}
                width={width}
                height={height}
                preserveAspectRatio="none"
              />
            )
          : null
      ))}
    </svg>
  )
}

export function NotebookMediaFullscreen({
  asset,
  address,
  subjectMap = null,
  subjectMapLoading = false,
  analysisUnavailableReason = null,
  composerEditing = false,
  composerPortalRef,
  returnFocus = null,
  initialRegions,
  replacementCandidates = [],
  onAnalyzeSubjects,
  onCaptureFrame,
  onEditingChange,
  onEditSubjects,
  onSelectedSubjectIdsChange,
  onSelectionChange,
  onClose,
}: NotebookMediaFullscreenProps) {
  const dialogRef = useRef<HTMLElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const mountedRef = useRef(false)
  const drawStartRef = useRef<{ x: number; y: number } | null>(null)
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  )
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  )
  const [regions, setRegions] = useState<ImageEditRegion[]>(
    () => [...(initialRegions ?? [])],
  )
  const [selectedRegionIds, setSelectedRegionIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  )
  const [drawMode, setDrawMode] = useState(false)
  const [draftBox, setDraftBox] = useState<ImageEditRegion['box'] | null>(null)
  const [hoveredRegionId, setHoveredRegionId] = useState<string | null>(null)
  const [replacements, setReplacements] = useState<Record<string, string>>({})
  const [overlaysHidden, setOverlaysHidden] = useState(false)
  const [removalPreview, setRemovalPreview] = useState(false)
  const [overlayOpacity, setOverlayOpacity] = useState(0.42)
  const [pendingAction, setPendingAction] = useState<
    'analyze' | 'remove' | 'replace' | null
  >(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [capturePending, setCapturePending] = useState(false)
  const [captureError, setCaptureError] = useState<string | null>(null)
  const [captureMessage, setCaptureMessage] = useState<string | null>(null)
  const isVideo = asset.type === 'video' || asset.type === 'final'
  const playbackUrl = asset.mediaUrl
  const posterUrl = asset.thumbnailUrl
  const mediaUrl = playbackUrl ?? posterUrl
  const hasMedia = isVideo || Boolean(mediaUrl)
  const stageWidth = subjectMap?.width ?? asset.width ?? 1000
  const stageHeight = subjectMap?.height ?? asset.height ?? 1000
  const selectedSubjects = useMemo(
    () => subjectMap?.subjects.filter((subject) => selectedIds.has(subject.id)) ?? [],
    [selectedIds, subjectMap],
  )
  const replacementTargets = useMemo(
    () => imageReplacementTargets(regions, selectedSubjects),
    [regions, selectedSubjects],
  )
  const canReplace = canSubmitRegionReplacements(replacementTargets, replacements)
  const hoveredRegion = regions.find((region) => region.id === hoveredRegionId) ?? null
  const snapOffer = hoveredRegion
    ? bestSubjectSnap(hoveredRegion.box, subjectMap?.subjects ?? [])
    : null

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    onSelectedSubjectIdsChange?.(selectedSubjects.map((subject) => subject.id))
    onSelectionChange?.(imageEditSelectionPayload(
      selectedSubjects.map((subject) => subject.id),
      regions,
    ))
  }, [onSelectedSubjectIdsChange, onSelectionChange, regions, selectedSubjects])

  useEffect(() => {
    if (!hasMedia) return
    restoreFocusRef.current = returnFocus
      ?? (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null)
    const appShell = document.querySelector<HTMLElement>('.app-shell')
    const shellWasInert = appShell?.inert ?? false
    const shellAriaHidden = appShell?.getAttribute('aria-hidden') ?? null
    const bodyOverflow = document.body.style.overflow
    if (appShell) {
      appShell.inert = true
      appShell.setAttribute('aria-hidden', 'true')
    }
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()
    const handleDialogKeys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab' || !dialogRef.current) return
      const focusable = focusableElements(dialogRef.current)
      if (focusable.length === 0) {
        event.preventDefault()
        dialogRef.current.focus()
        return
      }
      const first = focusable[0]
      const last = focusable.at(-1) ?? first
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', handleDialogKeys)
    return () => {
      window.removeEventListener('keydown', handleDialogKeys)
      if (appShell) {
        appShell.inert = shellWasInert
        if (shellAriaHidden === null) appShell.removeAttribute('aria-hidden')
        else appShell.setAttribute('aria-hidden', shellAriaHidden)
      }
      document.body.style.overflow = bodyOverflow
      if (restoreFocusRef.current?.isConnected) restoreFocusRef.current.focus()
    }
  }, [hasMedia, onClose, returnFocus])

  if (!isVideo && !mediaUrl) return null

  const toggleSubject = (subjectId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(subjectId)) next.delete(subjectId)
      else next.add(subjectId)
      return next
    })
  }
  const toggleRegion = (regionId: string) => {
    setSelectedRegionIds((current) => {
      const next = new Set(current)
      if (next.has(regionId)) next.delete(regionId)
      else next.add(regionId)
      return next
    })
  }
  const removeRegion = (regionId: string) => {
    setRegions((current) => current.filter((region) => region.id !== regionId))
    setSelectedRegionIds((current) => {
      const next = new Set(current)
      next.delete(regionId)
      return next
    })
    setReplacements((current) => {
      const next = { ...current }
      delete next[regionId]
      return next
    })
  }
  const snapHoveredRegion = () => {
    if (!hoveredRegion) return
    setRegions((current) => current.map((region) =>
      region.id === hoveredRegion.id
        ? snapRegionToSubject(region, subjectMap?.subjects ?? [])
        : region))
  }
  const toggleSubjectVisibility = (subjectId: string) => {
    setHiddenIds((current) => {
      const next = new Set(current)
      if (next.has(subjectId)) next.delete(subjectId)
      else next.add(subjectId)
      return next
    })
  }
  const beginDraw = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!drawMode || event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const point = viewBoxPoint(event, stageWidth, stageHeight)
    drawStartRef.current = point
    setDraftBox(null)
  }
  const moveDraw = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!drawMode || !drawStartRef.current) return
    setDraftBox(regionBoxFromDrag(
      drawStartRef.current,
      viewBoxPoint(event, stageWidth, stageHeight),
    ))
  }
  const endDraw = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!drawMode || !drawStartRef.current) return
    const box = regionBoxFromDrag(
      drawStartRef.current,
      viewBoxPoint(event, stageWidth, stageHeight),
    )
    drawStartRef.current = null
    setDraftBox(null)
    if (!box) return
    setRegions((current) => {
      const region: ImageEditRegion = { id: nextRegionId(current), box }
      return [...current, region]
    })
    setOverlaysHidden(false)
    setRemovalPreview(false)
  }
  const analyzeSubjects = async (force = false) => {
    if (composerEditing) return
    if (subjectMap?.status === 'ready' && !force) {
      setRemovalPreview(false)
      setOverlaysHidden((current) => !current)
      return
    }
    if (!onAnalyzeSubjects || pendingAction) return
    setPendingAction('analyze')
    setActionError(null)
    setActionMessage(null)
    try {
      await onAnalyzeSubjects(force)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setPendingAction(null)
    }
  }
  const removeSubjects = async () => {
    if (
      !onEditSubjects
      || selectedSubjects.length === 0
      || pendingAction
      || composerEditing
    ) return
    setPendingAction('remove')
    onEditingChange?.(true)
    setActionError(null)
    setActionMessage(null)
    try {
      const queued = await onEditSubjects({
        operation: 'remove',
        subjectIds: selectedSubjects.map((subject) => subject.id),
      })
      if (!queued || !mountedRef.current) return
      setActionMessage('Removal queued as a new image.')
    } catch (error) {
      if (!mountedRef.current) return
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      if (mountedRef.current) {
        setPendingAction(null)
        onEditingChange?.(false)
      }
    }
  }
  const replaceRegions = async () => {
    if (!onEditSubjects || !canReplace || pendingAction || composerEditing) return
    setPendingAction('replace')
    onEditingChange?.(true)
    setActionError(null)
    setActionMessage(null)
    try {
      const queued = await onEditSubjects({
        operation: 'replace',
        subjectIds: selectedSubjects.map((subject) => subject.id),
        regions: regionReplacementPayload(replacementTargets, replacements),
      })
      if (!queued || !mountedRef.current) return
      setActionMessage('Replacement queued as a new image.')
    } catch (error) {
      if (!mountedRef.current) return
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      if (mountedRef.current) {
        setPendingAction(null)
        onEditingChange?.(false)
      }
    }
  }
  const captureCurrentFrame = async () => {
    const video = videoRef.current
    if (!video || !onCaptureFrame || capturePending) return
    const duration = Number.isFinite(video.duration) ? video.duration : null
    const timestamp = Math.max(
      0,
      duration === null
        ? video.currentTime
        : Math.min(video.currentTime, Math.max(0, duration - 0.05)),
    )
    setCapturePending(true)
    setCaptureError(null)
    setCaptureMessage(null)
    try {
      const savedAddress = await onCaptureFrame(timestamp)
      if (!mountedRef.current) return
      setCaptureMessage(`Frame saved to ${savedAddress}`)
    } catch (error) {
      if (!mountedRef.current) return
      setCaptureError(error instanceof Error ? error.message : String(error))
    } finally {
      if (mountedRef.current) setCapturePending(false)
    }
  }
  const ready = subjectMap?.status === 'ready'
  const checkingCache = subjectMapLoading
    && subjectMap?.status !== 'analyzing'
    && pendingAction !== 'analyze'
  const analyzing = subjectMap?.status === 'analyzing'
    || pendingAction === 'analyze'
  const analyzeDisabled = Boolean(
    analysisUnavailableReason
    || !onAnalyzeSubjects
    || composerEditing
    || (pendingAction && pendingAction !== 'analyze')
    || checkingCache
    || analyzing,
  )
  const showSubjectStage = !removalPreview

  const dialog = (
    <section
      ref={dialogRef}
      className={`notebook-media-fullscreen${isVideo ? ' playback-only' : ' subject-editor'}`}
      role="dialog"
      aria-modal="true"
      aria-label={`Fullscreen preview for @${address}`}
      tabIndex={-1}
    >
      <button
        ref={closeRef}
        type="button"
        className="notebook-media-fullscreen-close"
        onClick={onClose}
        aria-label="Close fullscreen preview"
      >
        <X size={20} />
      </button>
      {isVideo ? (
        <div className="notebook-media-playback-stage">
          {playbackUrl ? (
            <video
              ref={videoRef}
              key={playbackUrl}
              src={playbackUrl}
              poster={posterUrl ?? undefined}
              controls
              controlsList="nofullscreen nodownload noremoteplayback"
              disablePictureInPicture
              playsInline
              autoPlay
              preload="auto"
            />
          ) : (
            <div className="notebook-media-unavailable" role="status">
              {posterUrl ? (
                <img src={posterUrl} alt={`@${address} poster`} />
              ) : null}
              <strong>Playback unavailable</strong>
              <p>This video has a preview image but no playable media yet.</p>
            </div>
          )}
          {playbackUrl && onCaptureFrame && (
            <div className="notebook-media-capture-bar">
              <button
                type="button"
                className="notebook-media-capture-button"
                disabled={capturePending}
                onClick={() => void captureCurrentFrame()}
              >
                {capturePending
                  ? <BusyIndicator size={14} />
                  : <Camera size={14} />}
                Extract frame
              </button>
              {(captureError || captureMessage) && (
                <p
                  className={captureError ? 'error' : 'success'}
                  role="status"
                >
                  {captureError ?? captureMessage}
                </p>
              )}
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="notebook-subject-stage">
            {ready && subjectMap && removalPreview ? (
              <ImageRemovalPreview
                mediaUrl={mediaUrl ?? ''}
                subjectMap={subjectMap}
                selectedIds={selectedIds}
              />
            ) : showSubjectStage ? (
              <ImageSubjectOverlay
                mediaUrl={mediaUrl ?? ''}
                width={stageWidth}
                height={stageHeight}
                subjectMap={overlaysHidden ? null : subjectMap}
                selectedIds={selectedIds}
                hiddenIds={hiddenIds}
                regions={overlaysHidden ? [] : regions}
                selectedRegionIds={selectedRegionIds}
                drawMode={drawMode}
                draftBox={draftBox}
                snapRegionId={snapOffer ? hoveredRegionId : null}
                opacity={overlayOpacity}
                onToggle={toggleSubject}
                onToggleRegion={toggleRegion}
                onHoverRegion={setHoveredRegionId}
                onPointerDown={beginDraw}
                onPointerMove={moveDraw}
                onPointerUp={endDraw}
              />
            ) : (
              <img src={mediaUrl ?? ''} alt={`@${address}`} />
            )}
            <div className="notebook-subject-stage-label">
              <span>@{address}</span>
              <strong>
                {removalPreview
                  ? 'Removal preview'
                  : drawMode
                    ? 'Draw region'
                    : ready
                      ? `${subjectMap.subjects.length} subjects`
                      : 'Image editor'}
              </strong>
            </div>
            {snapOffer && hoveredRegion && !drawMode && (
              <button
                type="button"
                className="notebook-region-snap"
                onClick={snapHoveredRegion}
              >
                Snap to {subjectMap?.subjects.find((subject) =>
                  subject.id === snapOffer.subjectId)?.label ?? 'subject'}
              </button>
            )}
          </div>
          <aside className="notebook-subject-panel" aria-label="Subject editor">
            <header>
              <span>SUBJECT WORKSPACE</span>
              <h2>People &amp; objects</h2>
              <p>Select anything you want to remove or transform, or draw a region.</p>
            </header>
            <div className="notebook-subject-toolbar">
              <button
                type="button"
                className={ready && !overlaysHidden ? 'active' : ''}
                aria-pressed={ready ? !overlaysHidden : undefined}
                disabled={analyzeDisabled}
                onClick={() => void analyzeSubjects()}
              >
                {checkingCache || analyzing
                  ? <BusyIndicator size={14} />
                  : ready && !overlaysHidden
                    ? <EyeOff size={14} />
                    : <Layers2 size={14} />}
                {checkingCache
                  ? 'Loading…'
                  : analyzing
                  ? 'Analyzing…'
                  : ready
                    ? overlaysHidden ? 'Show subjects' : 'Hide subjects'
                    : 'Subjects'}
              </button>
              <button
                type="button"
                className={drawMode ? 'active' : ''}
                aria-pressed={drawMode}
                disabled={pendingAction !== null || composerEditing}
                onClick={() => {
                  setDrawMode((current) => !current)
                  setRemovalPreview(false)
                  setOverlaysHidden(false)
                }}
              >
                <SquareDashed size={14} />
                Draw region
              </button>
              {ready && subjectMap.baseUrl && (
                <button
                  type="button"
                  className={removalPreview ? 'active' : ''}
                  aria-pressed={removalPreview}
                  disabled={
                    selectedSubjects.length === 0
                    || pendingAction !== null
                    || composerEditing
                  }
                  onClick={() => {
                    setRemovalPreview((current) => !current)
                    setOverlaysHidden(false)
                    setDrawMode(false)
                  }}
                >
                  <Eraser size={14} />
                  {removalPreview ? 'Show overlays' : 'Preview removal'}
                </button>
              )}
              {ready && subjectMap.subjects.length > 0 && (
                <label className="notebook-subject-opacity">
                  <span>Overlay</span>
                  <input
                    type="range"
                    min="0.15"
                    max="0.8"
                    step="0.05"
                    value={overlayOpacity}
                    onChange={(event) => setOverlayOpacity(Number(event.target.value))}
                  />
                </label>
              )}
            </div>
            <div className="notebook-subject-panel-body" aria-live="polite">
              {analysisUnavailableReason ? (
                <div className="notebook-subject-state unavailable">
                  <Layers2 size={22} />
                  <strong>Subject tools unavailable</strong>
                  <p>{analysisUnavailableReason}</p>
                </div>
              ) : checkingCache ? (
                <div className="notebook-subject-state loading">
                  <BusyIndicator size={22} />
                  <strong>Loading cached subjects</strong>
                  <p>This does not start a new cloud analysis.</p>
                </div>
              ) : analyzing ? (
                <div className="notebook-subject-state loading">
                  <BusyIndicator size={22} />
                  <strong>Finding people and objects</strong>
                  <p>You can close this view. Analysis continues in the background.</p>
                </div>
              ) : subjectMap?.status === 'failed' ? (
                <div className="notebook-subject-state error">
                  <RotateCw size={22} />
                  <strong>Analysis did not finish</strong>
                  <p>{subjectMap.error ?? 'The image could not be decomposed.'}</p>
                  <button type="button" onClick={() => void analyzeSubjects()}>
                    <RotateCw size={13} />Retry
                  </button>
                </div>
              ) : ready && subjectMap.subjects.length === 0 && regions.length === 0 ? (
                <div className="notebook-subject-state empty">
                  <Layers2 size={22} />
                  <strong>No editable subjects found</strong>
                  <p>Draw a region or try analysis again if the image changed.</p>
                  <button type="button" onClick={() => void analyzeSubjects(true)}>
                    <RotateCw size={13} />Analyze again
                  </button>
                </div>
              ) : ready || regions.length > 0 ? (
                <div className="notebook-subject-list">
                  <div className="notebook-subject-list-actions">
                    <span>
                      {selectedSubjects.length + selectedRegionIds.size} selected
                    </span>
                    {ready && subjectMap && (
                      <button
                        type="button"
                        onClick={() => setSelectedIds(new Set(
                          selectedSubjects.length === subjectMap.subjects.length
                            ? []
                            : subjectMap.subjects.map((subject) => subject.id),
                        ))}
                      >
                        {selectedSubjects.length === subjectMap.subjects.length
                          ? 'Clear'
                          : 'Select all'}
                      </button>
                    )}
                  </div>
                  {regions.map((region, index) => {
                    const selected = selectedRegionIds.has(region.id)
                    const matched = subjectMap?.subjects.find((subject) =>
                      subject.id === region.matchedSubjectId)
                    return (
                      <div
                        key={region.id}
                        className={`notebook-subject-row${selected ? ' selected' : ''}`}
                      >
                        <label>
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={() => toggleRegion(region.id)}
                          />
                          <span
                            className="notebook-subject-swatch"
                            style={{ backgroundColor: REGION_COLOR }}
                            aria-hidden="true"
                          />
                          <span className="notebook-subject-copy">
                            <strong>
                              {matched ? `Region · ${matched.label}` : `Region ${index + 1}`}
                            </strong>
                            <small>
                              {region.box.width.toFixed(2)} × {region.box.height.toFixed(2)}
                            </small>
                          </span>
                        </label>
                        <button
                          type="button"
                          className="notebook-subject-visibility"
                          aria-label={`Remove region ${index + 1}`}
                          onClick={() => removeRegion(region.id)}
                        >
                          <X size={14} />
                        </button>
                      </div>
                    )
                  })}
                  {ready && subjectMap.subjects.map((subject) => {
                    const selected = selectedIds.has(subject.id)
                    const hidden = hiddenIds.has(subject.id)
                    return (
                      <div
                        key={subject.id}
                        className={`notebook-subject-row${selected ? ' selected' : ''}`}
                      >
                        <label>
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={() => toggleSubject(subject.id)}
                          />
                          <span
                            className="notebook-subject-swatch"
                            style={{ backgroundColor: subject.color }}
                            aria-hidden="true"
                          />
                          <span className="notebook-subject-copy">
                            <strong>{subject.label}</strong>
                            <small>
                              {subject.description
                                ?? (subject.exactEdit ? 'Exact mask available' : 'Editable layer')}
                            </small>
                          </span>
                        </label>
                        <button
                          type="button"
                          className="notebook-subject-visibility"
                          aria-label={`${hidden ? 'Show' : 'Hide'} ${subject.label} overlay`}
                          aria-pressed={!hidden}
                          onClick={() => toggleSubjectVisibility(subject.id)}
                        >
                          {hidden ? <EyeOff size={14} /> : <Eye size={14} />}
                        </button>
                      </div>
                    )
                  })}
                  {replacementTargets.length > 0 && replacementCandidates.length > 0 && (
                    <div className="notebook-replacement-list">
                      <span>Replacement images</span>
                      {replacementTargets.map((target) => (
                        <div key={target.key} className="notebook-replacement-row">
                          <strong>{target.label}</strong>
                          <div className="notebook-replacement-picker" role="listbox" aria-label={`Replacement for ${target.label}`}>
                            {replacementCandidates.map((candidate) => {
                              const selected = replacements[target.key] === candidate.artifactId
                              return (
                                <button
                                  key={candidate.artifactId}
                                  type="button"
                                  role="option"
                                  aria-selected={selected}
                                  className={`notebook-replacement-option${selected ? ' selected' : ''}`}
                                  onClick={() => setReplacements((current) => ({
                                    ...current,
                                    [target.key]: candidate.artifactId,
                                  }))}
                                >
                                  {candidate.thumbnailUrl ? (
                                    <img
                                      src={candidate.thumbnailUrl}
                                      alt=""
                                    />
                                  ) : null}
                                  @{candidate.address}
                                </button>
                              )
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className="notebook-subject-state idle">
                  <Layers2 size={22} />
                  <strong>Make the image editable</strong>
                  <p>Subjects identifies people and objects, then colors each layer. You can also draw regions immediately.</p>
                </div>
              )}
            </div>
            <div className="notebook-subject-actions">
              <p className="notebook-subject-composer-guidance">
                {replacementTargets.length > 0
                  ? 'Assign a replacement image to each region, then replace, or describe a change in the image edit bar.'
                  : ready && selectedSubjects.length > 0
                  ? `Describe the change for ${selectedSubjects.length} selected ${selectedSubjects.length === 1 ? 'subject' : 'subjects'} in the image edit bar.`
                  : 'Select people or objects, then describe the change in the image edit bar.'}
              </p>
              {(actionError || actionMessage) && (
                <p className={actionError ? 'error' : 'success'} role="status">
                  {actionError ?? actionMessage}
                </p>
              )}
              <div>
                <button
                  type="button"
                  className="remove"
                  disabled={
                    selectedSubjects.length === 0
                    || pendingAction !== null
                    || composerEditing
                  }
                  onClick={() => void removeSubjects()}
                >
                  {pendingAction === 'remove'
                    ? <BusyIndicator size={14} />
                    : <Eraser size={14} />}
                  Remove
                </button>
                <button
                  type="button"
                  className="replace"
                  disabled={
                    !canReplace
                    || pendingAction !== null
                    || composerEditing
                    || !onEditSubjects
                  }
                  onClick={() => void replaceRegions()}
                >
                  {pendingAction === 'replace'
                    ? <BusyIndicator size={14} />
                    : <SquareDashed size={14} />}
                  Replace
                </button>
              </div>
            </div>
          </aside>
          <div
            ref={composerPortalRef}
            className="notebook-media-composer-host"
            aria-label={`Image edit bar for @${address}`}
          />
        </>
      )}
    </section>
  )

  return typeof document === 'undefined'
    ? dialog
    : createPortal(dialog, document.body)
}
