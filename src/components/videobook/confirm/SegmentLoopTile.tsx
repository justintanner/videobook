import { useEffect, useRef } from 'react'
import { formatSplitTimestamp } from '@/videobook/notebook-split-command'
import { nextSegmentLoopAction } from '@/videobook/segment-loop-playback'

type LoopTileProps = {
  label: string
  mediaUrl: string
  muted: boolean
  playbackRate: number
  windows: Array<{ endSeconds: number; startSeconds: number }>
}

export function SegmentLoopTile({
  label,
  mediaUrl,
  muted,
  playbackRate,
  windows,
}: LoopTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const pendingSeekRef = useRef<number | null>(null)
  const windowIndexRef = useRef(0)
  const windowsKey = windows
    .map((window) => `${window.startSeconds}:${window.endSeconds}`)
    .join('|')

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const parsedWindows = windowsKey.split('|').flatMap((part) => {
      const [start, end] = part.split(':').map(Number)
      return Number.isFinite(start) && Number.isFinite(end) && end! > start!
        ? [{ startSeconds: start!, endSeconds: end! }]
        : []
    })
    windowIndexRef.current = 0
    const startSeconds = parsedWindows[0]?.startSeconds ?? 0
    const startPlayback = () => {
      video.currentTime = startSeconds
      pendingSeekRef.current = startSeconds
      video.playbackRate = playbackRate
      void video.play().catch(() => undefined)
    }
    let raf = 0
    let vfc: number | undefined
    let cancelled = false
    const cancelArm = () => {
      if (vfc !== undefined && typeof video.cancelVideoFrameCallback === 'function') {
        video.cancelVideoFrameCallback(vfc)
        vfc = undefined
      }
      if (raf) {
        cancelAnimationFrame(raf)
        raf = 0
      }
    }
    const tick = () => {
      if (cancelled) return
      const action = nextSegmentLoopAction({
        activeWindowIndex: windowIndexRef.current,
        currentTimeSeconds: video.currentTime,
        pendingSeekSeconds: pendingSeekRef.current,
        windows: parsedWindows,
      })
      if (action.type === 'seek') {
        video.currentTime = action.timeSeconds
        pendingSeekRef.current = action.timeSeconds
        windowIndexRef.current = action.windowIndex
        void video.play().catch(() => undefined)
      } else if (
        pendingSeekRef.current !== null
        && Math.abs(video.currentTime - pendingSeekRef.current) <= 1 / 30
      ) {
        pendingSeekRef.current = null
      }
      arm()
    }
    const arm = () => {
      if (cancelled) return
      if (typeof video.requestVideoFrameCallback === 'function') {
        vfc = video.requestVideoFrameCallback(() => tick())
        return
      }
      raf = requestAnimationFrame(() => tick())
    }
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
      startPlayback()
    } else {
      video.addEventListener('loadedmetadata', startPlayback, { once: true })
    }
    arm()
    return () => {
      cancelled = true
      cancelArm()
      video.removeEventListener('loadedmetadata', startPlayback)
    }
  }, [mediaUrl, playbackRate, windowsKey])

  useEffect(() => {
    const video = videoRef.current
    if (video) video.playbackRate = playbackRate
  }, [playbackRate])

  const span = windows[0]
    ? `${formatSplitTimestamp(windows[0].startSeconds)}–${formatSplitTimestamp(windows[windows.length - 1]!.endSeconds)}`
    : ''

  return (
    <section className="confirm-split-loop">
      <div className="confirm-split-loop-heading">
        <span>{label}</span>
        <strong>{span}</strong>
      </div>
      <video
        ref={videoRef}
        aria-label={label}
        src={mediaUrl}
        muted={muted}
        playsInline
        preload="auto"
      />
    </section>
  )
}
