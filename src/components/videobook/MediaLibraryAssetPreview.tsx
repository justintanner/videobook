import { AudioWaveform, Film } from 'lucide-react'
import { useState } from 'react'
import { formatMediaTime } from '@/videobook/notebook-cell-presentation'

export type MediaLibraryPreviewAsset = {
  type: string
  mediaUrl: string | null
  thumbnailUrl: string | null
  duration: number | null
}

export function MediaLibraryAssetPreview({
  asset,
}: {
  asset: MediaLibraryPreviewAsset
}) {
  const [imageFailed, setImageFailed] = useState(false)
  const [videoFailed, setVideoFailed] = useState(false)
  const video = asset.type === 'video' || asset.type === 'final'
  const imageUrl = asset.thumbnailUrl
    ?? (asset.type === 'image' ? asset.mediaUrl : null)

  if (imageUrl && !imageFailed) {
    return <img src={imageUrl} alt="" onError={() => setImageFailed(true)} />
  }
  if (video && asset.mediaUrl && !videoFailed) {
    return (
      <video
        src={asset.mediaUrl}
        muted
        playsInline
        preload="metadata"
        aria-hidden="true"
        onError={() => setVideoFailed(true)}
      />
    )
  }
  return (
    <span className="media-library-asset-placeholder">
      {asset.type === 'audio' ? <AudioWaveform size={28} /> : <Film size={28} />}
      {asset.duration !== null && <small>{formatMediaTime(asset.duration)}</small>}
    </span>
  )
}
