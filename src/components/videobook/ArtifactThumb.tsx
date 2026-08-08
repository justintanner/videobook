import {
  AudioWaveform,
  Braces,
  Film,
  Image as ImageIcon,
} from 'lucide-react'

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
    || kindHint === 'extract_frame'
  const videoUrl = !thumbnailUrl && (kind === 'video' || kind === 'final')
    ? asset?.mediaUrl
    : null

  return (
    <span className="inspector-source-thumb" aria-hidden="true">
      {thumbnailUrl ? (
        <img src={thumbnailUrl} alt="" loading="lazy" decoding="async" />
      ) : videoUrl ? (
        <video src={videoUrl} muted playsInline preload="metadata" />
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
