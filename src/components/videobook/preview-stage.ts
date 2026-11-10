import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { PlayerRef } from '@remotion/player'

const TRANSPORT_HEIGHT = 34
const DESKTOP_PREVIEW_FRACTION = 0.42
const STACKED_BREAKPOINT = 900

export function usePlayerFrame(playerRef: RefObject<PlayerRef | null>, onFrameChange: (frame: number) => void) {
  const [frame, setFrame] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(false)
  const callback = useRef(onFrameChange)
  useLayoutEffect(() => {
    callback.current = onFrameChange
  }, [onFrameChange])
  useEffect(() => {
    const player = playerRef.current
    if (!player) return
    const onFrame = (event: { detail: { frame: number } }) => {
      setFrame(event.detail.frame)
      callback.current(event.detail.frame)
    }
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    const onMute = (event: { detail: { isMuted: boolean } }) => setMuted(event.detail.isMuted)
    player.addEventListener('frameupdate', onFrame)
    player.addEventListener('seeked', onFrame)
    player.addEventListener('play', onPlay)
    player.addEventListener('pause', onPause)
    player.addEventListener('mutechange', onMute)
    return () => {
      player.removeEventListener('frameupdate', onFrame)
      player.removeEventListener('seeked', onFrame)
      player.removeEventListener('play', onPlay)
      player.removeEventListener('pause', onPause)
      player.removeEventListener('mutechange', onMute)
    }
  }, [playerRef])
  return { frame, playing, muted }
}

export function useStageSize(containerRef: RefObject<HTMLDivElement | null>, aspect: { width: number; height: number }, gridSelector: string, reserve = 0) {
  const [box, setBox] = useState({ width: 0, height: 0, stacked: false })
  useEffect(() => {
    const element = containerRef.current
    const grid = element?.closest<HTMLElement>(gridSelector)
    if (!element || !grid) return
    const measure = () => {
      const stacked = grid.clientWidth < STACKED_BREAKPOINT
      const availableHeight = Math.max(80, element.clientHeight - TRANSPORT_HEIGHT - reserve)
      const availableWidth = stacked ? element.clientWidth : grid.clientWidth * DESKTOP_PREVIEW_FRACTION
      const scale = Math.min(availableWidth / aspect.width, availableHeight / aspect.height)
      const next = { width: Math.floor(aspect.width * scale), height: Math.floor(aspect.height * scale), stacked }
      setBox((current) => (current.width === next.width && current.height === next.height && current.stacked === next.stacked ? current : next))
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    observer.observe(grid)
    return () => observer.disconnect()
  }, [aspect.height, aspect.width, containerRef, gridSelector, reserve])
  return box
}
