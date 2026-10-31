import { useCallback, useEffect, useRef, useState } from 'react'
import {
  spliceTimelineSource,
  type SplicePlaybackPhase,
  type SpliceTimeline,
} from './splice-preview'

function reachedCut(video: HTMLVideoElement, timeline: SpliceTimeline): boolean {
  return video.ended || video.currentTime >= timeline.cut - timeline.frameSeconds / 2
}

function reachedEnd(video: HTMLVideoElement, timeline: SpliceTimeline): boolean {
  return video.ended || timeline.cut + video.currentTime >= timeline.total
}

export function useSplicePlayback() {
  const firstRef = useRef<HTMLVideoElement | null>(null)
  const secondRef = useRef<HTMLVideoElement | null>(null)
  const frameRef = useRef(0)
  const phaseRef = useRef<SplicePlaybackPhase>('first')
  const [phase, setPhaseState] = useState<SplicePlaybackPhase>('first')
  const [position, setPosition] = useState(0)
  const [playing, setPlaying] = useState(false)

  const setPhase = useCallback((next: SplicePlaybackPhase) => {
    phaseRef.current = next
    setPhaseState(next)
  }, [])

  const cancelFrame = useCallback(() => {
    cancelAnimationFrame(frameRef.current)
    frameRef.current = 0
  }, [])

  const stop = useCallback(() => {
    cancelFrame()
    firstRef.current?.pause()
    secondRef.current?.pause()
    setPlaying(false)
  }, [cancelFrame])

  const place = useCallback((timeline: SpliceTimeline, target: number) => {
    const first = firstRef.current
    const second = secondRef.current
    const source = spliceTimelineSource(timeline, target)
    first?.pause()
    second?.pause()
    if (first) first.currentTime = source.phase === 'first' ? source.time : Math.max(0, timeline.cut - timeline.frameSeconds)
    if (second) second.currentTime = source.phase === 'second' ? source.time : 0
    setPhase(source.phase)
    setPosition(Math.min(Math.max(0, target), timeline.total))
  }, [setPhase])

  const seekTo = useCallback((timeline: SpliceTimeline, target: number) => {
    stop()
    place(timeline, target)
  }, [place, stop])

  const play = useCallback((timeline: SpliceTimeline, from: number, loop: boolean) => {
    const first = firstRef.current
    const second = secondRef.current
    if (!first || !second) return
    cancelFrame()
    setPlaying(true)
    const start = (target: number) => {
      place(timeline, target)
      const active = phaseRef.current === 'first' ? first : second
      void active.play().catch(stop)
    }
    const tick = () => {
      if (phaseRef.current === 'first' && reachedCut(first, timeline)) {
        first.pause()
        setPhase('second')
        second.currentTime = 0
        void second.play().catch(stop)
      }
      if (phaseRef.current === 'second' && reachedEnd(second, timeline)) {
        if (!loop) {
          second.pause()
          setPosition(timeline.total)
          frameRef.current = 0
          setPlaying(false)
          return
        }
        start(0)
      }
      setPosition(phaseRef.current === 'first' ? first.currentTime : timeline.cut + second.currentTime)
      frameRef.current = requestAnimationFrame(tick)
    }
    start(from >= timeline.total ? 0 : from)
    frameRef.current = requestAnimationFrame(tick)
  }, [cancelFrame, place, setPhase, stop])

  useEffect(() => cancelFrame, [cancelFrame])

  return { firstRef, secondRef, phase, position, playing, play, stop, seekTo }
}
