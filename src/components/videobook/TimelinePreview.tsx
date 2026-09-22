import { useEffect, useRef, type Ref } from 'react'
import { createPortal } from 'react-dom'
import { Film, X } from 'lucide-react'
import type { Sequence } from 'videobook-engine'
import type { CanonicalPlaybackAsset } from '@/remotion/CanonicalSequenceComposition'
import { restoreFocusElement } from '@/videobook/command-composer-focus'
import { handleModalDialogKeyDown } from '@/videobook/modal-dialog-interactions'
import { CanonicalSequencePlayer, type CanonicalSequencePlayerHandle } from './CanonicalSequencePlayer'
import { NotebookTimeline, type NotebookTimelineProps } from './NotebookTimeline'
import './TimelinePreview.css'

type TimelinePreviewProps = Omit<NotebookTimelineProps, 'sequence' | 'onPreview' | 'onRemove' | 'presentation'> & {
  sequence: Sequence
  playbackAssets: CanonicalPlaybackAsset[]
  playerRef: Ref<CanonicalSequencePlayerHandle>
  returnFocus: HTMLElement | null
  onFrameUpdate: (frame: number) => void
  onClose: () => void
}

const ignoreKeyboardAction = () => undefined

export function TimelinePreview({ sequence, assets, assembly, disabled, frame, address, onSeek, onExport, playbackAssets, playerRef, returnFocus, onFrameUpdate, onClose }: TimelinePreviewProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    dialog?.showModal()
    closeRef.current?.focus()
    return () => {
      dialog?.close()
      restoreFocusElement(returnFocus)
    }
  }, [returnFocus])

  return createPortal(
    <dialog
      ref={dialogRef}
      className="timeline-preview-fullscreen timeline-preview-dock"
      aria-label={`Timeline preview ${address}`}
      data-composer-focus="preserve"
      onCancel={(event) => { event.preventDefault(); event.stopPropagation(); onClose() }}
      onKeyDownCapture={(event) => {
        if (event.key !== 'Tab' || !(event.target instanceof Element) || event.target.closest('dialog') !== event.currentTarget) return
        handleModalDialogKeyDown(event, { busy: false, container: event.currentTarget, onClose })
      }}
    >
      <header className="timeline-preview-fullscreen-header">
        <span className="inspector-cell-title">
          <Film size={18} /><strong>Timeline</strong>
          <code className="inspector-cell-address">{address}</code>
          <span className="timeline-preview-label">Preview</span>
        </span>
        <div className="timeline-preview-fullscreen-actions">
          <span className="timeline-preview-format">{sequence.width} × {sequence.height}<span>{Number((sequence.frameRate.numerator / sequence.frameRate.denominator).toFixed(2))} fps</span></span>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close timeline preview"><X size={16} /><span>Close</span></button>
        </div>
      </header>
      <div className="timeline-preview-body">
        <CanonicalSequencePlayer
          ref={playerRef}
          sequence={sequence}
          assets={playbackAssets}
          onFrameUpdate={onFrameUpdate}
          onKeyboardAction={ignoreKeyboardAction}
          editingEnabled={false}
          presentation="preview"
          allowFullscreen={false}
        />
      </div>
      <div className="timeline-preview-fullscreen-tracks">
        <NotebookTimeline
          sequence={sequence}
          assets={assets}
          assembly={assembly}
          disabled={disabled}
          frame={frame}
          address={address}
          onSeek={onSeek}
          onExport={onExport}
          presentation="preview"
        />
      </div>
    </dialog>, document.body,
  )
}
