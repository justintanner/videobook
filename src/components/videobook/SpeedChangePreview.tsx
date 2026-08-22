import { useEffect, useRef, useState } from 'react'
import { formatSpeedMultiplier } from '@/videobook/chat-action-review'

type SpeedChangePreviewProps = {
  effectiveSpeed: number | null
  mediaUrl: string
  thumbnailUrl: string | null
}

export function SpeedChangePreview({
  effectiveSpeed,
  mediaUrl,
  thumbnailUrl,
}: SpeedChangePreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = useState(false)
  const playbackRate = effectiveSpeed && effectiveSpeed > 0 ? effectiveSpeed : 1

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const markPlaying = () => setPlaying(true)
    const markPaused = () => setPlaying(false)
    video.defaultPlaybackRate = playbackRate
    const startPlayback = () => {
      video.defaultPlaybackRate = playbackRate
      video.playbackRate = playbackRate
      video.muted = true
      void video.play().catch(() => setPlaying(false))
    }
    video.addEventListener('play', markPlaying)
    video.addEventListener('pause', markPaused)
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
      startPlayback()
    } else {
      video.addEventListener('loadedmetadata', startPlayback, { once: true })
    }
    return () => {
      video.removeEventListener('loadedmetadata', startPlayback)
      video.removeEventListener('play', markPlaying)
      video.removeEventListener('pause', markPaused)
      video.pause()
    }
  }, [mediaUrl, playbackRate])

  const description = effectiveSpeed
    ? `preview at ${formatSpeedMultiplier(effectiveSpeed)}×`
    : 'source preview'

  return (
    <>
      <video
        ref={videoRef}
        src={mediaUrl}
        poster={thumbnailUrl ?? undefined}
        controls
        loop
        muted
        playsInline
        preload="auto"
      />
      <small>
        {playing
          ? `Live ${description} — source not yet changed`
          : `Press Play for ${description} — source not yet changed`}
      </small>
    </>
  )
}
