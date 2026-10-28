import { AudioWaveform, Film } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { formatMediaTime } from '@/videobook/notebook-cell-presentation'

export type MediaLibraryPreviewAsset = {
  type: string
  mediaUrl: string | null
  thumbnailUrl: string | null
  duration: number | null
}

export function MediaLibraryAssetPreview({
  asset,
  eager = false,
  onMeasure,
}: {
  asset: MediaLibraryPreviewAsset
  eager?: boolean
  onMeasure?: (width: number, height: number) => void
}) {
  const [imageFailed, setImageFailed] = useState(false)
  const [videoFailed, setVideoFailed] = useState(false)
  const [videoActive, setVideoActive] = useState(eager)
  const previewRef = useRef<HTMLSpanElement>(null)
  const video = asset.type === 'video' || asset.type === 'final'
  const imageUrl = asset.thumbnailUrl
    ?? (asset.type === 'image' ? asset.mediaUrl : null)
  const previewKey = `${imageUrl ?? ''}:${asset.mediaUrl ?? ''}:${asset.type}:${eager}`
  const [activePreviewKey, setActivePreviewKey] = useState(previewKey)
  if (activePreviewKey !== previewKey) {
    setActivePreviewKey(previewKey)
    setImageFailed(false)
    setVideoFailed(false)
    setVideoActive(eager)
  }
  const hasImagePreview = Boolean(imageUrl && !imageFailed)
  const shouldLoadVideo = video && Boolean(asset.mediaUrl) && !hasImagePreview

  useEffect(() => {
    if (!shouldLoadVideo || videoActive) return
    if (eager || typeof IntersectionObserver === 'undefined') {
      const frame = window.requestAnimationFrame(() => setVideoActive(true))
      return () => window.cancelAnimationFrame(frame)
    }
    const preview = previewRef.current
    if (!preview) return
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      setVideoActive(true)
      observer.disconnect()
    }, {
      root: preview.closest('.media-library-results'),
      rootMargin: '96px 0px',
    })
    observer.observe(preview)
    return () => observer.disconnect()
  }, [eager, shouldLoadVideo, videoActive])

  if (hasImagePreview && imageUrl) {
    return (
      <img
        src={imageUrl}
        alt=""
        loading="lazy"
        decoding="async"
        onLoad={(event) => onMeasure?.(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)}
        onError={() => setImageFailed(true)}
      />
    )
  }
  if (video && asset.mediaUrl) {
    return (
      <span ref={previewRef} className="media-library-asset-preview">
        {videoActive && !videoFailed ? (
          <video
            src={asset.mediaUrl}
            muted
            playsInline
            preload="metadata"
            aria-hidden="true"
            onLoadedMetadata={(event) => onMeasure?.(event.currentTarget.videoWidth, event.currentTarget.videoHeight)}
            onError={() => setVideoFailed(true)}
          />
        ) : (
          <>
            <Film size={28} />
            {asset.duration !== null && <small>{formatMediaTime(asset.duration)}</small>}
          </>
        )}
      </span>
    )
  }
  return (
    <span className="media-library-asset-placeholder">
      {asset.type === 'audio' ? <AudioWaveform size={28} /> : <Film size={28} />}
      {asset.duration !== null && <small>{formatMediaTime(asset.duration)}</small>}
    </span>
  )
}
