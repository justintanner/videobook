import { Camera, PencilLine, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { BusyIndicator } from '@/components/videobook/BusyIndicator'
import {
  ImageEditorWorkspace,
  type ImageEditInstructionOutcome,
  type ImageReplacementCandidate,
  type ImageSubjectEditInput,
} from '@/components/videobook/ImageEditorWorkspace'
import type { ImageSubjectMap } from '@/videobook/image-subject-map'
import { capturePointerComposerFocus, restoreFocusElement } from '@/videobook/command-composer-focus'
import { focusableModalDialogElements } from '@/videobook/modal-dialog-interactions'
import type { ImageEditRegion, ImageEditSelection } from '@/videobook/image-edit-regions'
import type { ImageEditModelOption } from '@/videobook/use-image-edit-models'
import type { NotebookCellInspectorAsset } from './NotebookCellInspector'
import { mediaDetailParts, type MediaFullscreenMode } from '@/videobook/image-editor-copy'

export type {
  ImageEditInstructionOutcome,
  ImageReplacementCandidate,
  ImageSubjectEditInput,
}

type NotebookMediaFullscreenProps = {
  asset: NotebookCellInspectorAsset
  address: string
  initialMode?: MediaFullscreenMode
  subjectMap?: ImageSubjectMap | null
  subjectMapLoading?: boolean
  analysisUnavailableReason?: string | null
  composerPortalRef?: (element: HTMLDivElement | null) => void
  actionsOpen?: boolean
  returnFocus?: HTMLElement | null
  initialRegions?: readonly ImageEditRegion[]
  replacementCandidates?: readonly ImageReplacementCandidate[]
  imageEditModels?: readonly ImageEditModelOption[]
  imageEditModelsLoading?: boolean
  lastUsedImageEditModelId?: string | null
  onEstimateImageEditCost?: (
    modelId: string,
    operation: 'edit' | 'replace',
  ) => Promise<string | null>
  onAnalyzeSubjects?: (force?: boolean) => Promise<void>
  onCaptureFrame?: (timestampSeconds: number) => Promise<string>
  onEditingChange?: (editing: boolean) => void
  onEditSubjects?: (input: ImageSubjectEditInput) => Promise<boolean>
  onSubmitEditInstruction?: (
    instruction: string,
    selection: ImageEditSelection,
  ) => Promise<ImageEditInstructionOutcome>
  onClose: () => void
}

function MediaDetails({ address, asset }: { address: string; asset: NotebookCellInspectorAsset }) {
  return (
    <p className="media-fullscreen-details">
      <strong>@{address}</strong>
      {mediaDetailParts(asset).map((part) => <span key={part}>{part}</span>)}
    </p>
  )
}

function typingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
}

function VideoStage({
  address,
  playbackUrl,
  posterUrl,
  videoRef,
}: {
  address: string
  playbackUrl: string | null
  posterUrl: string | null
  videoRef: React.RefObject<HTMLVideoElement | null>
}) {
  if (!playbackUrl) {
    return (
      <div className="notebook-media-unavailable" role="status">
        {posterUrl ? <img src={posterUrl} alt={`@${address} poster`} /> : null}
        <strong>Playback unavailable</strong>
        <p>This video has a preview image but no playable media yet.</p>
      </div>
    )
  }
  return (
    <video
      ref={videoRef}
      key={playbackUrl}
      src={playbackUrl}
      poster={posterUrl ?? undefined}
      controls
      tabIndex={0}
      controlsList="nofullscreen nodownload noremoteplayback"
      disablePictureInPicture
      playsInline
      autoPlay
      preload="auto"
    />
  )
}

export function NotebookMediaFullscreen({
  asset,
  address,
  initialMode = 'view',
  subjectMap = null,
  subjectMapLoading = false,
  analysisUnavailableReason = null,
  composerPortalRef,
  actionsOpen = false,
  returnFocus = null,
  initialRegions,
  replacementCandidates = [],
  imageEditModels,
  imageEditModelsLoading,
  lastUsedImageEditModelId,
  onEstimateImageEditCost,
  onAnalyzeSubjects,
  onCaptureFrame,
  onEditingChange,
  onEditSubjects,
  onSubmitEditInstruction,
  onClose,
}: NotebookMediaFullscreenProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const dismissFocusRef = useRef<(() => void) | null>(null)
  const mountedRef = useRef(false)
  const isVideo = asset.type === 'video' || asset.type === 'final'
  const playbackUrl = asset.mediaUrl
  const posterUrl = asset.thumbnailUrl
  const mediaUrl = playbackUrl ?? posterUrl
  const hasMedia = isVideo || Boolean(mediaUrl)
  const editable = !isVideo && Boolean(onEditSubjects || onSubmitEditInstruction)
  const [mode, setMode] = useState<MediaFullscreenMode>(isVideo ? 'view' : initialMode)
  const [capturePending, setCapturePending] = useState(false)
  const [captureStatus, setCaptureStatus] = useState<{ tone: 'error' | 'success'; text: string } | null>(null)
  const editing = mode === 'edit' && !isVideo

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!hasMedia) return
    const dialog = dialogRef.current
    if (!dialog) return
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
    dialog.showModal()
    closeRef.current?.focus()
    return () => {
      dialog.close()
      if (appShell) {
        appShell.inert = shellWasInert
        if (shellAriaHidden === null) appShell.removeAttribute('aria-hidden')
        else appShell.setAttribute('aria-hidden', shellAriaHidden)
      }
      document.body.style.overflow = bodyOverflow
      const dismissFocus = dismissFocusRef.current
      if (dismissFocus) {
        dismissFocusRef.current = null
        dismissFocus()
        return
      }
      const restore = restoreFocusRef.current
      restoreFocusElement(restore)
      requestAnimationFrame(() => restoreFocusElement(restore))
    }
  }, [hasMedia, returnFocus])

  if (!isVideo && !mediaUrl) return null

  const focusDialogEdge = (edge: 'first' | 'last') => {
    if (!dialogRef.current) return
    const elements = focusableModalDialogElements(dialogRef.current)
    const target = edge === 'first' ? elements[0] : elements.at(-1)
    target?.focus({ preventScroll: true })
  }

  const close = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (event.detail > 0) dismissFocusRef.current = capturePointerComposerFocus()
    onClose()
  }

  const leaveEditor = () => {
    setMode('view')
    requestAnimationFrame(() => closeRef.current?.focus())
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
    setCaptureStatus(null)
    try {
      const savedAddress = await onCaptureFrame(timestamp)
      if (mountedRef.current) setCaptureStatus({ tone: 'success', text: `Frame saved to ${savedAddress}` })
    } catch (error) {
      if (mountedRef.current) {
        setCaptureStatus({ tone: 'error', text: error instanceof Error ? error.message : String(error) })
      }
    } finally {
      if (mountedRef.current) setCapturePending(false)
    }
  }

  const handleViewerKey = (event: ReactKeyboardEvent<HTMLDialogElement>) => {
    if (editing || event.defaultPrevented || typingTarget(event.target)) return
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (!editable || event.key.toLowerCase() !== 'e') return
    event.preventDefault()
    setMode('edit')
  }

  const viewer = (
    <>
      <header className="media-fullscreen-chrome">
        <MediaDetails address={address} asset={asset} />
        <div className="notebook-media-fullscreen-actions">
          {editable && (
            <button
              type="button"
              className="media-fullscreen-edit"
              aria-keyshortcuts="E"
              onClick={() => setMode('edit')}
            >
              <PencilLine size={16} />
              Edit image
            </button>
          )}
          {isVideo && playbackUrl && onCaptureFrame && (
            <button
              type="button"
              className="notebook-media-capture-button"
              disabled={capturePending}
              onClick={() => void captureCurrentFrame()}
            >
              {capturePending ? <BusyIndicator size={16} /> : <Camera size={16} />}
              Extract frame
            </button>
          )}
          <button
            ref={closeRef}
            type="button"
            className="notebook-media-fullscreen-close"
            onClick={close}
            aria-label="Close fullscreen preview"
            aria-keyshortcuts="Escape"
            data-composer-focus="return"
          >
            <X size={20} />
          </button>
          {captureStatus && (
            <p className={`notebook-media-capture-status ${captureStatus.tone}`} role="status">
              {captureStatus.text}
            </p>
          )}
        </div>
      </header>
      <div className="media-fullscreen-stage">
        {isVideo
          ? <VideoStage address={address} playbackUrl={playbackUrl} posterUrl={posterUrl} videoRef={videoRef} />
          : <img src={mediaUrl ?? ''} alt={`@${address}`} />}
      </div>
      {editable && (
        <p className="media-fullscreen-keys" aria-hidden="true">
          <span><kbd>E</kbd> edit</span>
          <span><kbd>Esc</kbd> close</span>
        </p>
      )}
    </>
  )

  const dialog = (
    <dialog
      ref={dialogRef}
      className={`notebook-media-fullscreen ${editing ? 'image-editor' : 'media-viewer'}${isVideo ? ' playback-only' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={`Fullscreen preview for @${address}`}
      onKeyDown={handleViewerKey}
      onCancel={(event) => {
        event.preventDefault()
        if (editing) leaveEditor()
        else onClose()
      }}
    >
      {actionsOpen && <div ref={composerPortalRef} className="notebook-media-composer-host actions-only" aria-label="Media actions input" />}
      <span className="sr-only" tabIndex={0} aria-hidden="true" onFocus={() => focusDialogEdge('last')} />
      {editing ? (
        <ImageEditorWorkspace
          address={address}
          mediaUrl={mediaUrl ?? ''}
          width={subjectMap?.width ?? asset.width ?? 1000}
          height={subjectMap?.height ?? asset.height ?? 1000}
          details={<MediaDetails address={address} asset={asset} />}
          subjectMap={subjectMap}
          subjectMapLoading={subjectMapLoading}
          analysisUnavailableReason={analysisUnavailableReason}
          initialRegions={initialRegions}
          replacementCandidates={replacementCandidates}
          imageEditModels={imageEditModels}
          imageEditModelsLoading={imageEditModelsLoading}
          lastUsedImageEditModelId={lastUsedImageEditModelId}
          onEstimateImageEditCost={onEstimateImageEditCost}
          closeRef={closeRef}
          onAnalyzeSubjects={onAnalyzeSubjects}
          onEditingChange={onEditingChange}
          onEditSubjects={onEditSubjects}
          onSubmitInstruction={onSubmitEditInstruction}
          onBack={leaveEditor}
          onClose={close}
        />
      ) : viewer}
      <span className="sr-only" tabIndex={0} aria-hidden="true" onFocus={() => focusDialogEdge('first')} />
    </dialog>
  )

  return typeof document === 'undefined'
    ? dialog
    : createPortal(dialog, document.body)
}
