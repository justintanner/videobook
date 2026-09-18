import {
  AudioWaveform,
  Braces,
  Film,
  Image as ImageIcon,
} from 'lucide-react'
import { useState } from 'react'

export type ArtifactThumbAsset = {
  artifactId: string
  type: string
  mediaUrl?: string | null
  thumbnailUrl?: string | null
}

export function ArtifactThumb({
  asset,
  kindHint,
}: {
  asset?: ArtifactThumbAsset | null
  kindHint?: string
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const thumbnailUrl = asset?.thumbnailUrl
    ?? (asset?.type === 'image' ? asset.mediaUrl : null)
  const kind = asset?.type ?? kindHint ?? 'unknown'
  const audio = kind === 'audio'
    || kindHint === 'generate_audio'
    || kindHint === 'extract_audio'
  const video = kind === 'video'
    || kind === 'final'
    || kindHint === 'generate_video'
    || kindHint === 'split_video'
    || kindHint === 'concat'
    || kindHint === 'splice'
  const image = kind === 'image'
    || kindHint === 'generate_image'

  return (
    <span className="inspector-source-thumb" aria-hidden="true">
      {thumbnailUrl && thumbnailUrl !== failedUrl ? (
        <img src={thumbnailUrl} alt="" loading="lazy" decoding="async" onError={() => setFailedUrl(thumbnailUrl)} />
      ) : audio ? (
        <AudioWaveform size={16} />
      ) : video ? (
        <Film size={16} />
      ) : image ? (
        <ImageIcon size={16} />
      ) : (
        <Braces size={15} />
      )}
    </span>
  )
}
