import { X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { NotebookCellInspectorAsset } from './NotebookCellInspector'

type NotebookMediaFullscreenProps = {
  asset: NotebookCellInspectorAsset
  slug: string
  onClose: () => void
}

export function NotebookMediaFullscreen({
  asset,
  slug,
  onClose,
}: NotebookMediaFullscreenProps) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const isVideo = asset.type === 'video' || asset.type === 'final'
  const mediaUrl = asset.mediaUrl ?? asset.thumbnailUrl

  useEffect(() => {
    restoreFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    closeRef.current?.focus()
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('keydown', closeOnEscape)
      restoreFocusRef.current?.focus()
    }
  }, [onClose])

  if (!mediaUrl) return null

  return (
    <section
      className="notebook-media-fullscreen"
      role="dialog"
      aria-modal="true"
      aria-label={`Fullscreen preview for @${slug}`}
    >
      {isVideo && asset.mediaUrl ? (
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
      ) : (
        <img src={mediaUrl} alt={`@${slug}`} />
      )}
      <button
        ref={closeRef}
        type="button"
        className="notebook-media-fullscreen-close"
        onClick={onClose}
        aria-label="Close fullscreen preview"
      >
        <X size={20} />
      </button>
    </section>
  )
}
