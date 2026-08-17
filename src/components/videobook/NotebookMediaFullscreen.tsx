import {
  Eraser,
  Eye,
  EyeOff,
  Layers2,
  RotateCw,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { BusyIndicator } from '@/components/videobook/BusyIndicator'
import type { ImageSubject, ImageSubjectMap } from '@/videobook/image-subject-map'
import type { NotebookCellInspectorAsset } from './NotebookCellInspector'

export type ImageSubjectEditInput = {
  operation: 'remove' | 'edit'
  subjectIds: string[]
  prompt?: string
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
  onAnalyzeSubjects?: (force?: boolean) => Promise<void>
  onEditingChange?: (editing: boolean) => void
  onEditSubjects?: (input: ImageSubjectEditInput) => Promise<boolean>
  onSelectedSubjectIdsChange?: (subjectIds: readonly string[]) => void
  onClose: () => void
}

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

function ImageSubjectOverlay({
  mediaUrl,
  subjectMap,
  selectedIds,
  hiddenIds,
  opacity,
  onToggle,
}: {
  mediaUrl: string
  subjectMap: ImageSubjectMap
  selectedIds: ReadonlySet<string>
  hiddenIds: ReadonlySet<string>
  opacity: number
  onToggle: (subjectId: string) => void
}) {
  const width = subjectMap.width ?? 0
  const height = subjectMap.height ?? 0
  if (width <= 0 || height <= 0) {
    return <img src={mediaUrl} alt="" />
  }
  return (
    <svg
      className="notebook-subject-stage-svg"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMidYMid meet"
      role="group"
      aria-label="Image with detected subject overlays"
    >
      <title>Detected people and objects</title>
      <image
        href={mediaUrl}
        width={width}
        height={height}
        preserveAspectRatio="xMidYMid meet"
      />
      <defs>
        {subjectMap.subjects.map((subject, index) => {
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
      {subjectMap.subjects.map((subject, index) => {
        if (hiddenIds.has(subject.id)) return null
        const box = subjectBox(subject, width, height)
        const selected = selectedIds.has(subject.id)
        return (
          <g
            key={subject.id}
            className={`notebook-subject-overlay${selected ? ' selected' : ''}`}
            onClick={() => onToggle(subject.id)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              onToggle(subject.id)
            }}
            role="button"
            tabIndex={0}
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
                pointerEvents="all"
              />
            )}
          </g>
        )
      })}
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
  onAnalyzeSubjects,
  onEditingChange,
  onEditSubjects,
  onSelectedSubjectIdsChange,
  onClose,
}: NotebookMediaFullscreenProps) {
  const dialogRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const mountedRef = useRef(false)
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  )
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  )
  const [overlaysHidden, setOverlaysHidden] = useState(false)
  const [removalPreview, setRemovalPreview] = useState(false)
  const [overlayOpacity, setOverlayOpacity] = useState(0.42)
  const [pendingAction, setPendingAction] = useState<
    'analyze' | 'remove' | null
  >(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const isVideo = asset.type === 'video' || asset.type === 'final'
  const mediaUrl = asset.mediaUrl ?? asset.thumbnailUrl
  const hasMedia = Boolean(mediaUrl)
  const selectedSubjects = useMemo(
    () => subjectMap?.subjects.filter((subject) => selectedIds.has(subject.id)) ?? [],
    [selectedIds, subjectMap],
  )

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    onSelectedSubjectIdsChange?.(selectedSubjects.map((subject) => subject.id))
  }, [onSelectedSubjectIdsChange, selectedSubjects])

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

  if (!mediaUrl) return null

  const toggleSubject = (subjectId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(subjectId)) next.delete(subjectId)
      else next.add(subjectId)
      return next
    })
  }
  const toggleSubjectVisibility = (subjectId: string) => {
    setHiddenIds((current) => {
      const next = new Set(current)
      if (next.has(subjectId)) next.delete(subjectId)
      else next.add(subjectId)
      return next
    })
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
      {isVideo && asset.mediaUrl ? (
        <div className="notebook-media-playback-stage">
          <video
            key={asset.mediaUrl}
            src={asset.mediaUrl}
            poster={asset.thumbnailUrl ?? undefined}
            controls
            controlsList="nofullscreen nodownload noremoteplayback"
            disablePictureInPicture
            playsInline
            autoPlay
            preload="auto"
          />
        </div>
      ) : (
        <>
          <div className="notebook-subject-stage">
            {ready && subjectMap && removalPreview ? (
              <ImageRemovalPreview
                mediaUrl={mediaUrl}
                subjectMap={subjectMap}
                selectedIds={selectedIds}
              />
            ) : ready && subjectMap && !overlaysHidden ? (
              <ImageSubjectOverlay
                mediaUrl={mediaUrl}
                subjectMap={subjectMap}
                selectedIds={selectedIds}
                hiddenIds={hiddenIds}
                opacity={overlayOpacity}
                onToggle={toggleSubject}
              />
            ) : (
              <img src={mediaUrl} alt={`@${address}`} />
            )}
            <div className="notebook-subject-stage-label">
              <span>@{address}</span>
              <strong>
                {removalPreview
                  ? 'Removal preview'
                  : ready ? `${subjectMap.subjects.length} subjects` : 'Image editor'}
              </strong>
            </div>
          </div>
          <aside className="notebook-subject-panel" aria-label="Subject editor">
            <header>
              <span>SUBJECT WORKSPACE</span>
              <h2>People &amp; objects</h2>
              <p>Select anything you want to remove or transform.</p>
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
              ) : ready && subjectMap.subjects.length === 0 ? (
                <div className="notebook-subject-state empty">
                  <Layers2 size={22} />
                  <strong>No editable subjects found</strong>
                  <p>Try analysis again if the image changed.</p>
                  <button type="button" onClick={() => void analyzeSubjects(true)}>
                    <RotateCw size={13} />Analyze again
                  </button>
                </div>
              ) : ready ? (
                <div className="notebook-subject-list">
                  <div className="notebook-subject-list-actions">
                    <span>{selectedSubjects.length} selected</span>
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
                  </div>
                  {subjectMap.subjects.map((subject) => {
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
                </div>
              ) : (
                <div className="notebook-subject-state idle">
                  <Layers2 size={22} />
                  <strong>Make the image editable</strong>
                  <p>Subjects identifies people and objects, then colors each layer.</p>
                </div>
              )}
            </div>
            <div className="notebook-subject-actions">
              <p className="notebook-subject-composer-guidance">
                {ready && selectedSubjects.length > 0
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
