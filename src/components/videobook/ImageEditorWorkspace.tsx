import {
  ChevronLeft,
  Eraser,
  Eye,
  EyeOff,
  Layers2,
  RotateCw,
  SquareDashed,
  WandSparkles,
  X,
} from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
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
  snapRegionToSubject,
  type ImageEditRegion,
  type ImageEditSelection,
  type ImageRegionReplacement,
  type ImageReplacementTarget,
} from '@/videobook/image-edit-regions'
import { imageEditInstructionPlaceholder, imageEditTargetSummary } from '@/videobook/image-editor-copy'
import { notebookReferences } from '@/videobook/notebook-addressing'
import type { ImageEditModelOption } from '@/videobook/use-image-edit-models'

export type ImageSubjectEditInput = {
  operation: 'remove' | 'edit' | 'replace' | 'whole_image'
  subjectIds: string[]
  prompt?: string
  regions?: ImageRegionReplacement[]
  editRegions?: ImageEditRegion['box'][]
  model?: string
}

export type ImageReplacementCandidate = {
  artifactId: string
  address: string
  label: string
  thumbnailUrl: string | null
}

export type ImageEditInstructionOutcome = {
  ok: boolean
  message: string
}

export type ImageEditorWorkspaceProps = {
  address: string
  mediaUrl: string
  width: number
  height: number
  details: ReactNode
  subjectMap: ImageSubjectMap | null
  subjectMapLoading: boolean
  analysisUnavailableReason: string | null
  initialRegions?: readonly ImageEditRegion[]
  replacementCandidates: readonly ImageReplacementCandidate[]
  closeRef: RefObject<HTMLButtonElement | null>
  imageEditModels?: readonly ImageEditModelOption[]
  imageEditModelsLoading?: boolean
  lastUsedImageEditModelId?: string | null
  onEstimateImageEditCost?: (
    modelId: string,
    operation: 'edit' | 'replace',
  ) => Promise<string | null>
  onAnalyzeSubjects?: (force?: boolean) => Promise<void>
  onEditingChange?: (editing: boolean) => void
  onEditSubjects?: (input: ImageSubjectEditInput) => Promise<boolean>
  onSubmitInstruction?: (
    instruction: string,
    selection: ImageEditSelection,
  ) => Promise<ImageEditInstructionOutcome>
  onBack: () => void
  onClose: (event: React.MouseEvent<HTMLButtonElement>) => void
}

type PendingAction = 'analyze' | 'remove' | 'apply'

const REGION_COLOR = '#f5d76e'

function toggledSet(current: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(current)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

function SubjectAnalysisState({
  analysisUnavailableReason,
  checkingCache,
  analyzing,
  analysisFailed,
  ready,
  hasTargets,
  subjectCount,
  regionCount,
  error,
  onAnalyze,
}: {
  analysisUnavailableReason: string | null
  checkingCache: boolean
  analyzing: boolean
  analysisFailed: boolean
  ready: boolean
  hasTargets: boolean
  subjectCount: number
  regionCount: number
  error: string | null
  onAnalyze: (force?: boolean) => void
}) {
  if (analysisUnavailableReason) {
    return (
      <div className="notebook-subject-state unavailable">
        <Layers2 size={18} />
        <strong>Subject tools unavailable</strong>
        <p>{analysisUnavailableReason}</p>
      </div>
    )
  }
  if (checkingCache && !hasTargets) {
    return (
      <div className="notebook-subject-state loading">
        <BusyIndicator size={18} />
        <strong>Loading cached subjects</strong>
        <p>This does not start a new cloud analysis.</p>
      </div>
    )
  }
  if (analyzing) {
    return (
      <div className={`notebook-subject-state loading${hasTargets ? ' compact' : ''}`}>
        <BusyIndicator size={hasTargets ? 14 : 18} />
        <strong>Finding people and objects</strong>
        <p>
          {hasTargets
            ? 'Analysis continues in the background.'
            : 'Analysis continues in the background. You can draw a region meanwhile.'}
        </p>
      </div>
    )
  }
  if (analysisFailed) {
    return (
      <div className={`notebook-subject-state error${hasTargets ? ' compact' : ''}`}>
        <RotateCw size={hasTargets ? 14 : 18} />
        <strong>Analysis did not finish</strong>
        <p>{error ?? 'The image could not be decomposed.'}</p>
        {!hasTargets && (
          <p>You can still draw a region to edit, replace, or remove.</p>
        )}
        <button type="button" onClick={() => onAnalyze()}>
          <RotateCw size={13} />Retry
        </button>
      </div>
    )
  }
  if (ready && subjectCount === 0 && regionCount === 0) {
    return (
      <div className="notebook-subject-state empty">
        <Layers2 size={18} />
        <strong>No editable subjects found</strong>
        <p>Draw a region or try analysis again if the image changed.</p>
        <button type="button" onClick={() => onAnalyze(true)}>
          <RotateCw size={13} />Analyze again
        </button>
      </div>
    )
  }
  if (!ready && !checkingCache && !hasTargets) {
    return (
      <div className="notebook-subject-state idle">
        <Layers2 size={18} />
        <strong>Pick what to change</strong>
        <p>Find subjects detects people and objects you can select. Draw region marks any area by hand.</p>
      </div>
    )
  }
  return null
}

function ReplacementPicker({
  targets,
  candidates,
  replacements,
  onPick,
}: {
  targets: readonly ImageReplacementTarget[]
  candidates: readonly ImageReplacementCandidate[]
  replacements: Readonly<Record<string, string>>
  onPick: (targetKey: string, artifactId: string) => void
}) {
  return (
    <div className="notebook-replacement-list">
      <span>Replacement images</span>
      {candidates.length === 0 ? (
        <p className="notebook-replacement-empty">
          Place another image on the grid, then pick it here or mention it as @address in the instructions.
        </p>
      ) : (
        targets.map((target) => (
          <div key={target.key} className="notebook-replacement-row">
            <strong>{target.label}</strong>
            {replacements[target.key] && (
              <button type="button" onClick={() => onPick(target.key, '')}>
                Clear replacement for {target.label}
              </button>
            )}
            <div className="notebook-replacement-picker" role="listbox" aria-label={`Replacement for ${target.label}`}>
              {candidates.map((candidate) => {
                const selected = replacements[target.key] === candidate.artifactId
                return (
                  <button
                    key={candidate.artifactId}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={`notebook-replacement-option${selected ? ' selected' : ''}`}
                    onClick={() => onPick(target.key, candidate.artifactId)}
                  >
                    {candidate.thumbnailUrl ? <img src={candidate.thumbnailUrl} alt="" /> : null}
                    @{candidate.address}
                  </button>
                )
              })}
            </div>
          </div>
        ))
      )}
    </div>
  )
}

export function ImageEditorWorkspace({
  address,
  mediaUrl,
  width,
  height,
  details,
  subjectMap,
  subjectMapLoading,
  analysisUnavailableReason,
  initialRegions,
  replacementCandidates,
  closeRef,
  imageEditModels,
  imageEditModelsLoading,
  lastUsedImageEditModelId,
  onEstimateImageEditCost,
  onAnalyzeSubjects,
  onEditingChange,
  onEditSubjects,
  onSubmitInstruction,
  onBack,
  onClose,
}: ImageEditorWorkspaceProps) {
  const instructionId = useId()
  const hintId = useId()
  const modelSelectId = useId()
  const mountedRef = useRef(false)
  const drawStartRef = useRef<{ x: number; y: number } | null>(null)
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set())
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(() => new Set())
  const [regions, setRegions] = useState<ImageEditRegion[]>(() => [...(initialRegions ?? [])])
  const [selectedRegionIds, setSelectedRegionIds] = useState<ReadonlySet<string>>(
    () => new Set(initialRegions?.map((region) => region.id)),
  )
  const [drawMode, setDrawMode] = useState(false)
  const [draftBox, setDraftBox] = useState<ImageEditRegion['box'] | null>(null)
  const [hoveredRegionId, setHoveredRegionId] = useState<string | null>(null)
  const [replacements, setReplacements] = useState<Record<string, string>>({})
  const [overlaysHidden, setOverlaysHidden] = useState(false)
  const [removalPreview, setRemovalPreview] = useState(false)
  const [overlayOpacity, setOverlayOpacity] = useState(0.42)
  const [instruction, setInstruction] = useState('')
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)
  const [status, setStatus] = useState<{ tone: 'error' | 'success'; text: string } | null>(null)
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null)
  const [costEstimate, setCostEstimate] = useState<string | null>(null)

  const ready = subjectMap?.status === 'ready'
  const subjects = useMemo(() => subjectMap?.subjects ?? [], [subjectMap])
  const selectedSubjects = useMemo(
    () => subjects.filter((subject) => selectedIds.has(subject.id)),
    [selectedIds, subjects],
  )
  const selectedRegions = useMemo(
    () => regions.filter((region) => selectedRegionIds.has(region.id)),
    [regions, selectedRegionIds],
  )
  const replacementTargets = useMemo(
    () => imageReplacementTargets(selectedRegions, selectedSubjects, regions),
    [regions, selectedRegions, selectedSubjects],
  )
  const canReplace = canSubmitRegionReplacements(replacementTargets, replacements)
  const replacing = notebookReferences(instruction).length > 0
    || replacementTargets.some((target) => Boolean(replacements[target.key]))
  const editOperation: 'edit' | 'replace' = replacing ? 'replace' : 'edit'
  const effectiveModelId = selectedModelId
    ?? lastUsedImageEditModelId
    ?? imageEditModels?.[0]?.id
    ?? null
  const modelSupportsTarget = (model: ImageEditModelOption) =>
    model.capabilities[replacing ? 'regionReplace' : 'semantic']
  const refreshCostEstimate = (modelId: string) => {
    if (!onEstimateImageEditCost) return
    void onEstimateImageEditCost(modelId, editOperation)
      .then((estimate) => {
        if (mountedRef.current) setCostEstimate(estimate)
      })
      .catch(() => {
        if (mountedRef.current) setCostEstimate(null)
      })
  }
  const hoveredRegion = regions.find((region) => region.id === hoveredRegionId) ?? null
  const snapOffer = hoveredRegion ? bestSubjectSnap(hoveredRegion.box, subjects) : null
  const checkingCache = subjectMapLoading
    && subjectMap?.status !== 'analyzing'
    && pendingAction !== 'analyze'
  const analyzing = subjectMap?.status === 'analyzing' || pendingAction === 'analyze'
  const analysisFailed = subjectMap?.status === 'failed'
  const analyzeDisabled = Boolean(
    analysisUnavailableReason
    || !onAnalyzeSubjects
    || (pendingAction && pendingAction !== 'analyze')
    || checkingCache
    || analyzing,
  )
  const hasTargets = regions.length > 0 || (ready && subjects.length > 0)
  const targetSummary = imageEditTargetSummary(selectedSubjects, replacementTargets, replacing)
  const wholeImageTarget = !replacing && replacementTargets.length === 0
  const trimmedInstruction = instruction.trim()
  const canApply = Boolean(onSubmitInstruction)
    && pendingAction === null
    && (trimmedInstruction.length > 0
      ? targetSummary !== null || wholeImageTarget
      : canReplace)
  const applyLabel = replacing
    ? 'Replace with image'
    : 'Apply edit'

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const runAction = async (action: PendingAction, work: () => Promise<string | null>) => {
    if (pendingAction) return
    setPendingAction(action)
    setStatus(null)
    if (action !== 'analyze') onEditingChange?.(true)
    try {
      const message = await work()
      if (mountedRef.current && message) setStatus({ tone: 'success', text: message })
    } catch (error) {
      if (mountedRef.current) setStatus({ tone: 'error', text: errorMessage(error) })
    } finally {
      if (mountedRef.current) {
        setPendingAction(null)
        if (action !== 'analyze') onEditingChange?.(false)
      }
    }
  }

  const analyzeSubjects = (force = false) => {
    if (ready && !force) {
      setRemovalPreview(false)
      setOverlaysHidden((current) => !current)
      return
    }
    if (!onAnalyzeSubjects) return
    void runAction('analyze', async () => {
      await onAnalyzeSubjects(force)
      return null
    })
  }

  const removeSubjects = () => {
    if (!onEditSubjects || replacementTargets.length === 0) return
    void runAction('remove', async () => {
      const queued = await onEditSubjects({
        operation: 'remove',
        subjectIds: selectedSubjects.map((subject) => subject.id),
        ...(selectedRegions.length > 0 ? {
          editRegions: selectedRegions.map((region) => region.box),
          ...(effectiveModelId ? { model: effectiveModelId } : {}),
        } : {}),
      })
      return queued ? 'Removal queued as a new image.' : null
    })
  }

  const applyInstruction = () => {
    if (!onSubmitInstruction || !canApply) return
    const selection: ImageEditSelection = {
      ...imageEditSelectionPayload(
        selectedSubjects.map((subject) => subject.id),
        selectedRegions,
        Object.fromEntries(replacementTargets.flatMap((target) =>
          replacements[target.key] ? [[target.key, replacements[target.key]!]] : [])),
      ),
      ...(effectiveModelId ? { model: effectiveModelId } : {}),
    }
    void runAction('apply', async () => {
      const outcome = await onSubmitInstruction(trimmedInstruction, selection)
      if (!outcome.ok) throw new Error(outcome.message)
      if (mountedRef.current) setInstruction('')
      return outcome.message
    })
  }

  const submitOnShortcut = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return
    event.preventDefault()
    applyInstruction()
  }

  const toggleDrawMode = () => {
    setDrawMode((current) => !current)
    setRemovalPreview(false)
    setOverlaysHidden(false)
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
      region.id === hoveredRegion.id ? snapRegionToSubject(region, subjects) : region))
  }

  const beginDraw = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!drawMode || event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drawStartRef.current = viewBoxPoint(event, width, height)
    setDraftBox(null)
  }
  const moveDraw = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!drawMode || !drawStartRef.current) return
    setDraftBox(regionBoxFromDrag(drawStartRef.current, viewBoxPoint(event, width, height)))
  }
  const endDraw = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!drawMode || !drawStartRef.current) return
    const box = regionBoxFromDrag(drawStartRef.current, viewBoxPoint(event, width, height))
    drawStartRef.current = null
    setDraftBox(null)
    if (!box) return
    const region = { id: nextRegionId(regions), box }
    setRegions((current) => [...current, region])
    setSelectedRegionIds((current) => new Set([...current, region.id]))
    setOverlaysHidden(false)
    setRemovalPreview(false)
  }

  const subjectsLabel = checkingCache
    ? 'Loading…'
    : analyzing
      ? 'Analyzing…'
      : ready
        ? overlaysHidden ? 'Show subjects' : 'Hide subjects'
        : 'Find subjects'

  return (
    <>
      <header className="image-editor-header">
        <button
          type="button"
          className="image-editor-icon-button"
          aria-label="Back to fullscreen view"
          title="Back to fullscreen view (Esc)"
          onClick={onBack}
        >
          <ChevronLeft size={18} />
        </button>
        {details}
        <button
          ref={closeRef}
          type="button"
          className="image-editor-icon-button notebook-media-fullscreen-close"
          aria-label="Close fullscreen preview"
          data-composer-focus="return"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </header>
      <nav className="image-editor-tools" aria-label="Selection tools">
        <button
          type="button"
          className={ready && !overlaysHidden ? 'active' : ''}
          aria-pressed={ready ? !overlaysHidden : undefined}
          disabled={analyzeDisabled}
          title={subjectsLabel}
          onClick={() => analyzeSubjects()}
        >
          {checkingCache || analyzing
            ? <BusyIndicator size={18} />
            : ready && !overlaysHidden ? <EyeOff size={18} /> : <Layers2 size={18} />}
          <span>{subjectsLabel}</span>
        </button>
        <button
          type="button"
          className={drawMode ? 'active' : ''}
          aria-pressed={drawMode}
          disabled={pendingAction !== null}
          title="Draw region"
          onClick={toggleDrawMode}
        >
          <SquareDashed size={18} />
          <span>Draw region</span>
        </button>
        {ready && subjectMap?.baseUrl && (
          <button
            type="button"
            className={removalPreview ? 'active' : ''}
            aria-pressed={removalPreview}
            disabled={selectedSubjects.length === 0 || selectedRegions.length > 0 || pendingAction !== null}
            title="Preview removal"
            onClick={() => {
              setRemovalPreview((current) => !current)
              setOverlaysHidden(false)
              setDrawMode(false)
            }}
          >
            <Eraser size={18} />
            <span>{removalPreview ? 'Show overlays' : 'Preview removal'}</span>
          </button>
        )}
      </nav>
      <div className="notebook-subject-stage">
        {ready && subjectMap && removalPreview ? (
          <ImageRemovalPreview mediaUrl={mediaUrl} subjectMap={subjectMap} selectedIds={selectedIds} />
        ) : (
          <ImageSubjectOverlay
            mediaUrl={mediaUrl}
            width={width}
            height={height}
            subjectMap={overlaysHidden ? null : subjectMap}
            selectedIds={selectedIds}
            hiddenIds={hiddenIds}
            regions={overlaysHidden ? [] : regions}
            selectedRegionIds={selectedRegionIds}
            drawMode={drawMode}
            draftBox={draftBox}
            snapRegionId={snapOffer ? hoveredRegionId : null}
            opacity={overlayOpacity}
            onToggle={(id) => setSelectedIds((current) => toggledSet(current, id))}
            onToggleRegion={(id) => setSelectedRegionIds((current) => toggledSet(current, id))}
            onHoverRegion={setHoveredRegionId}
            onPointerDown={beginDraw}
            onPointerMove={moveDraw}
            onPointerUp={endDraw}
          />
        )}
        {drawMode && (
          <p className="image-editor-stage-hint" aria-live="polite">Drag on the image to draw a region</p>
        )}
        {snapOffer && hoveredRegion && !drawMode && (
          <button type="button" className="notebook-region-snap" onClick={snapHoveredRegion}>
            Snap to {subjects.find((subject) => subject.id === snapOffer.subjectId)?.label ?? 'subject'}
          </button>
        )}
      </div>
      <aside className="notebook-subject-panel" aria-label="Subject editor">
        <form
          className="image-editor-instructions"
          aria-label={`Edit instructions for @${address}`}
          onSubmit={(event) => {
            event.preventDefault()
            applyInstruction()
          }}
        >
          <div className="image-editor-target">
            <span>Applies to</span>
            <strong className={targetSummary ? '' : 'empty'}>
              {targetSummary ?? 'Whole image'}
            </strong>
          </div>
          <label htmlFor={instructionId}>What should change?</label>
          <textarea
            id={instructionId}
            value={instruction}
            rows={5}
            aria-describedby={hintId}
            placeholder={imageEditInstructionPlaceholder(selectedSubjects, replacementTargets, replacing)}
            disabled={!onSubmitInstruction}
            autoFocus
            onChange={(event) => setInstruction(event.target.value)}
            onKeyDown={submitOnShortcut}
          />
          <p id={hintId} className="image-editor-hint">
            The result lands in a new cell next to @{address}.
          </p>
          {(imageEditModels?.length ?? 0) > 0 && (
            <div className="image-editor-model">
              <label htmlFor={modelSelectId}>Model</label>
              <select
                id={modelSelectId}
                value={effectiveModelId ?? ''}
                disabled={imageEditModelsLoading}
                onChange={(event) => {
                  setSelectedModelId(event.target.value)
                  setCostEstimate(null)
                  refreshCostEstimate(event.target.value)
                }}
                onFocus={() => {
                  if (effectiveModelId && costEstimate === null) {
                    refreshCostEstimate(effectiveModelId)
                  }
                }}
              >
                {(imageEditModels ?? []).map((model) => (
                  <option
                    key={model.id}
                    value={model.id}
                    disabled={!modelSupportsTarget(model)}
                  >
                    {model.label}
                    {modelSupportsTarget(model) ? '' : ' — cannot edit this target'}
                  </option>
                ))}
              </select>
              <p className="image-editor-cost" role="status">
                {imageEditModelsLoading
                  ? 'Loading models…'
                  : costEstimate === null
                    ? 'Cost estimate unavailable'
                    : `Estimated provider cost ${costEstimate}`}
              </p>
            </div>
          )}
          {status && (
            <p className={`image-editor-status ${status.tone}`} role="status">{status.text}</p>
          )}
          <div className="image-editor-submit">
            <button type="submit" className="apply" disabled={!canApply}>
              {pendingAction === 'apply' ? <BusyIndicator size={14} /> : <WandSparkles size={14} />}
              {applyLabel}
              <kbd aria-hidden="true">⌘↵</kbd>
            </button>
            <button
              type="button"
              className="remove"
              disabled={replacementTargets.length === 0 || pendingAction !== null || !onEditSubjects}
              onClick={removeSubjects}
            >
              {pendingAction === 'remove' ? <BusyIndicator size={14} /> : <Eraser size={14} />}
              Remove
            </button>
          </div>
        </form>
        <div className="notebook-subject-panel-body" aria-live="polite">
          <SubjectAnalysisState
            analysisUnavailableReason={analysisUnavailableReason}
            checkingCache={checkingCache}
            analyzing={analyzing}
            analysisFailed={analysisFailed && !analyzing}
            ready={ready}
            hasTargets={hasTargets}
            subjectCount={subjects.length}
            regionCount={regions.length}
            error={subjectMap?.error ?? null}
            onAnalyze={analyzeSubjects}
          />
          {hasTargets && (
            <div className="notebook-subject-list">
              <div className="notebook-subject-list-actions">
                <span>{selectedSubjects.length + selectedRegionIds.size} selected</span>
                {ready && subjects.length > 0 && (
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
                {ready && subjects.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setSelectedIds(new Set(
                      selectedSubjects.length === subjects.length ? [] : subjects.map((subject) => subject.id),
                    ))}
                  >
                    {selectedSubjects.length === subjects.length ? 'Clear' : 'Select all'}
                  </button>
                )}
              </div>
              {regions.map((region, index) => {
                const selected = selectedRegionIds.has(region.id)
                const matched = subjects.find((subject) => subject.id === region.matchedSubjectId)
                return (
                  <div key={region.id} className={`notebook-subject-row${selected ? ' selected' : ''}`}>
                    <label>
                      <input
                        type="checkbox"
                        checked={selected}
                        aria-label={`Select region ${index + 1}`}
                        onChange={() => setSelectedRegionIds((current) => toggledSet(current, region.id))}
                      />
                      <span className="notebook-subject-swatch" style={{ backgroundColor: REGION_COLOR }} aria-hidden="true" />
                      <span className="notebook-subject-copy">
                        <strong>{matched ? `Region · ${matched.label}` : `Region ${index + 1}`}</strong>
                        <small>{region.box.width.toFixed(2)} × {region.box.height.toFixed(2)}</small>
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
              {ready && subjects.map((subject) => {
                const selected = selectedIds.has(subject.id)
                const hidden = hiddenIds.has(subject.id)
                return (
                  <div key={subject.id} className={`notebook-subject-row${selected ? ' selected' : ''}`}>
                    <label>
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => setSelectedIds((current) => toggledSet(current, subject.id))}
                      />
                      <span className="notebook-subject-swatch" style={{ backgroundColor: subject.color }} aria-hidden="true" />
                      <span className="notebook-subject-copy">
                        <strong>{subject.label}</strong>
                        <small>{subject.description ?? (subject.exactEdit ? 'Exact mask available' : 'Editable layer')}</small>
                      </span>
                    </label>
                    <button
                      type="button"
                      className="notebook-subject-visibility"
                      aria-label={`${hidden ? 'Show' : 'Hide'} ${subject.label} overlay`}
                      aria-pressed={!hidden}
                      onClick={() => setHiddenIds((current) => toggledSet(current, subject.id))}
                    >
                      {hidden ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                )
              })}
              {replacementTargets.length > 0 && (
                <ReplacementPicker
                  targets={replacementTargets}
                  candidates={replacementCandidates}
                  replacements={replacements}
                  onPick={(key, artifactId) => setReplacements((current) => ({ ...current, [key]: artifactId }))}
                />
              )}
            </div>
          )}
        </div>
      </aside>
    </>
  )
}
