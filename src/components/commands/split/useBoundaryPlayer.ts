import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

const LOOP_WINDOW = 2

interface UseBoundaryPlayerResult {
  videoRef: RefObject<HTMLVideoElement | null>
  playing: boolean
  togglePlay: () => void
  currentTime: number
}

export function useBoundaryPlayer(
  videoSrc: string,
  boundarySec: number | null,
  duration: number,
): UseBoundaryPlayerResult {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)

  const togglePlay = useCallback(() => {
    const video = videoRef.current
    if (!video || boundarySec === null) return
    if (!video.paused) {
      video.pause()
      return
    }

    const loopStart = Math.max(0, boundarySec - LOOP_WINDOW)
    const loopEnd = Math.min(duration || Infinity, boundarySec + LOOP_WINDOW)
    const atBoundary = Math.abs(video.currentTime - boundarySec) < 0.05
    if (atBoundary || video.currentTime < loopStart || video.currentTime >= loopEnd) {
      video.currentTime = loopStart
      setCurrentTime(loopStart)
    }
    void video.play().catch(() => setPlaying(false))
  }, [boundarySec, duration])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    video.addEventListener('play', onPlay)
    video.addEventListener('pause', onPause)
    return () => {
      video.removeEventListener('play', onPlay)
      video.removeEventListener('pause', onPause)
    }
  }, [])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (boundarySec === null) {
      video.pause()
      const frame = requestAnimationFrame(() => setCurrentTime(0))
      return () => cancelAnimationFrame(frame)
    }

    const cursorTime = Math.max(0, Math.min(duration || boundarySec, boundarySec))
    const loopStart = Math.max(0, boundarySec - LOOP_WINDOW)
    const loopEnd = Math.min(duration || Infinity, boundarySec + LOOP_WINDOW)
    const followCursor = () => {
      video.pause()
      video.currentTime = cursorTime
      setCurrentTime(cursorTime)
    }
    const onTimeUpdate = () => {
      if (!video.paused && (video.currentTime >= loopEnd || video.currentTime < loopStart - 0.1)) {
        video.currentTime = loopStart
        setCurrentTime(loopStart)
        return
      }
      setCurrentTime(video.currentTime)
    }
    const onSeeked = () => setCurrentTime(video.currentTime)

    video.addEventListener('timeupdate', onTimeUpdate)
    video.addEventListener('seeked', onSeeked)
    video.addEventListener('loadedmetadata', followCursor)
    const frame = video.readyState >= 1 ? requestAnimationFrame(followCursor) : null

    return () => {
      if (frame !== null) cancelAnimationFrame(frame)
      video.removeEventListener('timeupdate', onTimeUpdate)
      video.removeEventListener('seeked', onSeeked)
      video.removeEventListener('loadedmetadata', followCursor)
    }
  }, [boundarySec, duration, videoSrc])

  return { videoRef, playing, togglePlay, currentTime }
}
