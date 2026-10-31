import { useCallback, useEffect, useRef, useState } from 'react'

export type SplicePlaybackPhase = 'first' | 'second'

const SPLICE_LEAD_IN_SECONDS = 2
const SPLICE_TAIL_SECONDS = 2

function seek(video: HTMLVideoElement | null, seconds: number): void {
  if (!video) return
  video.pause()
  video.currentTime = Math.max(0, seconds)
}

function reachedCut(video: HTMLVideoElement, cut: number, frameSeconds: number): boolean {
  return video.ended || video.currentTime >= cut - frameSeconds / 2
}

function reachedTail(video: HTMLVideoElement): boolean {
  return video.ended || video.currentTime >= SPLICE_TAIL_SECONDS
}

export function useSplicePlayback(frameSeconds: number) {
  const firstRef = useRef<HTMLVideoElement | null>(null)
  const secondRef = useRef<HTMLVideoElement | null>(null)
  const frameRef = useRef(0)
  const phaseRef = useRef<SplicePlaybackPhase>('first')
  const [phase, setPhaseState] = useState<SplicePlaybackPhase>('first')
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

  const showCut = useCallback((cut: number) => {
    stop()
    seek(firstRef.current, cut - frameSeconds)
    seek(secondRef.current, 0)
    setPhase('first')
  }, [frameSeconds, setPhase, stop])

  const play = useCallback((cut: number, loop: boolean) => {
    const first = firstRef.current
    const second = secondRef.current
    if (!first || !second) return
    cancelFrame()
    setPlaying(true)
    const start = () => {
      seek(first, cut - SPLICE_LEAD_IN_SECONDS)
      seek(second, 0)
      setPhase('first')
      void first.play().catch(stop)
    }
    const finish = () => {
      second.pause()
      frameRef.current = 0
      setPlaying(false)
    }
    const tick = () => {
      if (phaseRef.current === 'first' && reachedCut(first, cut, frameSeconds)) {
        first.pause()
        setPhase('second')
        void second.play().catch(stop)
      }
      if (phaseRef.current === 'second' && reachedTail(second)) {
        if (!loop) {
          finish()
          return
        }
        start()
      }
      frameRef.current = requestAnimationFrame(tick)
    }
    start()
    frameRef.current = requestAnimationFrame(tick)
  }, [cancelFrame, frameSeconds, setPhase, stop])

  useEffect(() => cancelFrame, [cancelFrame])

  return { firstRef, secondRef, phase, playing, play, stop, showCut }
}
