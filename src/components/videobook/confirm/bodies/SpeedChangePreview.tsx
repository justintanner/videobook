import { useEffect, useRef, useState } from 'react'
import { formatSpeedMultiplier } from '@/videobook/chat-action-review'
import { formatMediaTime } from '@/videobook/notebook-cell-presentation'

type SpeedChangePreviewProps = {
  effectiveSpeed: number | null
  mediaUrl: string
  thumbnailUrl: string | null
  sectionStartSeconds?: number
  sectionEndSeconds?: number | null
}

function previewRate(
  currentTime: number,
  speed: number,
  start: number,
  end: number | null,
): number {
  return currentTime >= start && (end === null || currentTime < end) ? speed : 1
}

function previewDescription(
  speed: number | null,
  start: number,
  end: number | null,
): string {
  if (!speed) return 'source preview'
  const rate = `${formatSpeedMultiplier(speed)}×`
  if (start <= 0 && end === null) return `preview at ${rate}`
  const range = `${formatMediaTime(start)}–${end === null ? 'end' : formatMediaTime(end)}`
  return `preview at ${rate} on ${range}`
}

export function SpeedChangePreview({
  effectiveSpeed,
  mediaUrl,
  thumbnailUrl,
  sectionStartSeconds = 0,
  sectionEndSeconds = null,
}: SpeedChangePreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = useState(false)
  const speed = effectiveSpeed && effectiveSpeed > 0 ? effectiveSpeed : 1

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const markPlaying = () => setPlaying(true)
    const markPaused = () => setPlaying(false)
    const startPlayback = () => {
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
  }, [mediaUrl])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const applyRate = () => {
      const rate = previewRate(video.currentTime, speed, sectionStartSeconds, sectionEndSeconds)
      if (video.playbackRate !== rate) video.playbackRate = rate
    }
    applyRate()
    video.addEventListener('timeupdate', applyRate)
    video.addEventListener('seeked', applyRate)
    return () => {
      video.removeEventListener('timeupdate', applyRate)
      video.removeEventListener('seeked', applyRate)
    }
  }, [sectionEndSeconds, sectionStartSeconds, speed])

  const description = previewDescription(effectiveSpeed, sectionStartSeconds, sectionEndSeconds)

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
