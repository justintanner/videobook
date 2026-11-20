import { useCallback, useEffect, useId, useRef, useState, type MouseEvent, type RefObject } from 'react'
import type { SegmentPlan } from '../../../../server/src/auto-edit/plan'
import { frameToSeconds } from '../../../../server/src/auto-edit/plan'
import type { AutoEditCue } from '../../../../server/src/auto-edit/style'
import {
  autoEditCuesBetween,
  autoEditInvertZoomPoint,
  autoEditLookFilter,
  autoEditPlanDurationSeconds,
  autoEditScheduleAt,
  autoEditZoomStyle,
  buildAutoEditSegmentRanges,
} from '@/videobook/auto-edit-preview'
import { builtinSoundUrl } from '@/videobook/builtin-sound-preview'
import { graphicsFocusPoint } from '@/videobook/graphics-pointer'

export interface AutoEditSeekCommand {
  nonce: number
  kind: 'segment' | 'source'
  segmentIndex?: number
  sourceSeconds?: number
  play?: boolean
}

interface AutoEditPreviewProps {
  plan: SegmentPlan
  cues: readonly AutoEditCue[]
  mediaUrl: string
  soundsEnabled: boolean
  focusPoint: { x: number; y: number }
  seekCommand: AutoEditSeekCommand | null
  readSourceTimeRef: RefObject<() => number>
  activeSegmentIndex: number
  onActiveSegmentChange: (segmentIndex: number) => void
  onPlaceFocus: (point: { x: number; y: number }) => void
}

export function AutoEditPreview({
  plan,
  cues,
  mediaUrl,
  soundsEnabled,
  focusPoint,
  seekCommand,
  readSourceTimeRef,
  activeSegmentIndex,
  onActiveSegmentChange,
  onPlaceFocus,
}: AutoEditPreviewProps) {
  const crashFilterId = useId().replace(/:/g, '-') + '-crash'
  const rgbSplitFilterId = useId().replace(/:/g, '-') + '-rgb'
  const videoRef = useRef<HTMLVideoElement>(null)
  const rangeInputRef = useRef<HTMLInputElement>(null)
  const readoutRef = useRef<HTMLOutputElement>(null)
  const modeRef = useRef<'plan' | 'source'>('plan')
  const segmentIndexRef = useRef(0)
  const seekingTargetRef = useRef<number | null>(null)
  const lastOutputTimeRef = useRef(0)
  const firedCuesRef = useRef(new Set<number>())
  const playingAudioRef = useRef(new Set<HTMLAudioElement>())
  const initializedPlanRef = useRef(false)
  const [playing, setPlaying] = useState(false)
  const pausedZoomRef = useRef<{ scale: number; x: number; y: number }>({ scale: 1, x: 0.5, y: 0.5 })
  const firedCueNamesRef = useRef<string[]>([])
  const [playbackError, setPlaybackError] = useState<string | null>(null)

  const ranges = buildAutoEditSegmentRanges(plan)
  const totalDuration = autoEditPlanDurationSeconds(plan)
  const fps = plan.source.fps
  const rgbShiftPx = Math.max(3, Math.round(Math.min(18, plan.source.width * 0.012)))

  const stopCueAudio = useCallback(() => {
    for (const audio of playingAudioRef.current) {
      audio.pause()
    }
    playingAudioRef.current.clear()
  }, [])

  const playCueSound = useCallback((cue: AutoEditCue) => {
    firedCueNamesRef.current.push(cue.sound)
    if (videoRef.current) videoRef.current.dataset.firedCues = firedCueNamesRef.current.join(',')
    const audio = new Audio(builtinSoundUrl(cue.sound))
    audio.volume = Math.min(1, Math.max(0, cue.volume / 100))
    playingAudioRef.current.add(audio)
    audio.onended = () => playingAudioRef.current.delete(audio)
    void audio.play().catch(() => {
      playingAudioRef.current.delete(audio)
    })
  }, [])

  const applySampleVisuals = useCallback((outputSeconds: number) => {
    const video = videoRef.current
    if (!video) return
    const sample = autoEditScheduleAt(plan, outputSeconds)
    if (!sample) return
    const zoom = autoEditZoomStyle(sample.zoom)
    video.style.transform = zoom.transform
    video.style.transformOrigin = zoom.transformOrigin
    video.style.filter = autoEditLookFilter(sample.look, sample.lookHueTurns, {
      crash: crashFilterId,
      rgbSplit: rgbSplitFilterId,
    })
    video.dataset.look = sample.look
    pausedZoomRef.current = sample.zoom
    if (rangeInputRef.current) rangeInputRef.current.value = sample.outputTime.toFixed(3)
    if (readoutRef.current) {
      readoutRef.current.value = `${sample.segmentLabel} · ${sample.outputTime.toFixed(2)} / ${totalDuration.toFixed(2)}s · src ${sample.sourceTime.toFixed(2)}s`
    }
  }, [crashFilterId, plan, rgbSplitFilterId, totalDuration])

  const enterSegment = useCallback((index: number, shouldPlay: boolean, resetCues = false) => {
    const video = videoRef.current
    const range = ranges[index]
    if (!video || !range) return
    modeRef.current = 'plan'
    segmentIndexRef.current = index
    onActiveSegmentChange(index)
    lastOutputTimeRef.current = range.outputStartSeconds
    if (resetCues || index === 0) {
      firedCuesRef.current.clear()
      cues.forEach((cue, cueIndex) => {
        if (cue.startSeconds < range.outputStartSeconds - 0.03) firedCuesRef.current.add(cueIndex)
      })
    }
    seekingTargetRef.current = range.sourceStartSeconds
    video.playbackRate = range.segment.speed
    video.currentTime = range.sourceStartSeconds
    applySampleVisuals(range.outputStartSeconds)
    if (shouldPlay) {
      void video.play().catch(() => {
        video.muted = true
        void video.play().catch(() => setPlaybackError('Press Play to preview this video.'))
      })
    }
  }, [applySampleVisuals, cues, onActiveSegmentChange, ranges])

  const playFromOutputTime = useCallback((outputTimeSeconds: number, shouldPlay: boolean) => {
    const video = videoRef.current
    const sample = autoEditScheduleAt(plan, outputTimeSeconds)
    const range = sample ? ranges[sample.segmentIndex] : undefined
    if (!video || !sample || !range) return
    modeRef.current = 'plan'
    segmentIndexRef.current = sample.segmentIndex
    onActiveSegmentChange(sample.segmentIndex)
    lastOutputTimeRef.current = sample.outputTime
    firedCuesRef.current.clear()
    cues.forEach((cue, idx) => {
      if (cue.startSeconds < sample.outputTime - 0.03) firedCuesRef.current.add(idx)
    })
    seekingTargetRef.current = sample.sourceTime
    video.playbackRate = sample.playbackRate
    video.currentTime = sample.sourceTime
    applySampleVisuals(sample.outputTime)
    if (shouldPlay) {
      void video.play().catch(() => {
        video.muted = true
        void video.play().catch(() => setPlaybackError('Press Play to preview this video.'))
      })
    }
  }, [applySampleVisuals, cues, onActiveSegmentChange, plan, ranges])

  useEffect(() => {
    readSourceTimeRef.current = () => {
      const video = videoRef.current
      return video ? video.currentTime : frameToSeconds(plan.segments[0]?.startFrame ?? 0, fps)
    }
  }, [fps, plan.segments, readSourceTimeRef])

  useEffect(() => {
    if (initializedPlanRef.current) return
    initializedPlanRef.current = true
    enterSegment(0, true)
  }, [enterSegment])

  useEffect(() => {
    if (!seekCommand) return
    const video = videoRef.current
    if (!video) return
    stopCueAudio()
    setPlaybackError(null)
    if (seekCommand.kind === 'segment' && typeof seekCommand.segmentIndex === 'number') {
      enterSegment(Math.max(0, Math.min(ranges.length - 1, seekCommand.segmentIndex)), seekCommand.play ?? true, true)
      return
    }
    if (seekCommand.kind === 'source' && typeof seekCommand.sourceSeconds === 'number') {
      modeRef.current = 'source'
      video.pause()
      video.playbackRate = 1
      video.style.transform = 'none'
      video.style.transformOrigin = '50% 50%'
      video.style.filter = 'none'
      video.dataset.look = 'none'
      pausedZoomRef.current = { scale: 1, x: 0.5, y: 0.5 }
      seekingTargetRef.current = seekCommand.sourceSeconds
      video.currentTime = seekCommand.sourceSeconds
      if (readoutRef.current) {
        readoutRef.current.value = `Source ${seekCommand.sourceSeconds.toFixed(2)}s / ${frameToSeconds(plan.source.frames, fps).toFixed(2)}s`
      }
    }
  }, [enterSegment, fps, plan.source.frames, ranges.length, seekCommand, stopCueAudio])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    let frameId = 0
    const tick = () => {
      if (modeRef.current === 'plan') {
        const idx = Math.max(0, Math.min(ranges.length - 1, segmentIndexRef.current))
        const range = ranges[idx]
        if (range) {
          const target = seekingTargetRef.current
          const pendingSeek = target !== null && (video.seeking || Math.abs(video.currentTime - target) > Math.max(0.25, 2 / fps))
          if (!pendingSeek) {
            seekingTargetRef.current = null
            const rawLocalSource = Math.max(0, video.currentTime - range.sourceStartSeconds)
            const localOutput = rawLocalSource / range.segment.speed
            const outputTime = Math.min(range.outputEndSeconds, range.outputStartSeconds + localOutput)
            applySampleVisuals(outputTime)
            if (soundsEnabled && !video.paused) {
              const matched = autoEditCuesBetween(cues, lastOutputTimeRef.current, outputTime)
              for (const entry of matched) {
                if (firedCuesRef.current.has(entry.index)) continue
                firedCuesRef.current.add(entry.index)
                playCueSound(entry.cue)
              }
            }
            lastOutputTimeRef.current = outputTime
            const endThreshold = Math.max(0.015, 0.5 / fps)
            if (!video.paused && video.currentTime >= range.sourceEndSeconds - endThreshold) {
              if (idx + 1 < ranges.length) {
                enterSegment(idx + 1, true)
              } else {
                video.pause()
                stopCueAudio()
              }
            }
          }
        }
      }
      frameId = requestAnimationFrame(tick)
    }
    frameId = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(frameId)
    }
  }, [applySampleVisuals, cues, enterSegment, fps, playCueSound, ranges, soundsEnabled, stopCueAudio])

  useEffect(() => {
    if (modeRef.current === 'plan') {
      applySampleVisuals(lastOutputTimeRef.current)
    }
  }, [applySampleVisuals, plan])

  useEffect(() => () => {
    stopCueAudio()
  }, [stopCueAudio])

  const togglePlay = () => {
    const video = videoRef.current
    if (!video) return
    setPlaybackError(null)
    if (video.paused) {
      video.muted = false
      if (modeRef.current !== 'plan' || lastOutputTimeRef.current >= totalDuration - 0.04) {
        enterSegment(0, true)
        return
      }
      const range = ranges[segmentIndexRef.current]
      if (range) video.playbackRate = range.segment.speed
      void video.play().catch(() => {
        video.muted = true
        void video.play().catch(() => setPlaybackError('Unable to start preview playback.'))
      })
    } else {
      video.pause()
      stopCueAudio()
    }
  }

  const handleStageClick = (event: MouseEvent<HTMLDivElement>) => {
    const video = videoRef.current
    if (!video) return
    if (!video.paused) {
      video.pause()
      stopCueAudio()
      return
    }
    const point = graphicsFocusPoint({ x: event.clientX, y: event.clientY }, event.currentTarget.getBoundingClientRect())
    const inverted = modeRef.current === 'plan' ? autoEditInvertZoomPoint(point, pausedZoomRef.current) : point
    onPlaceFocus({
      x: Number(inverted.x.toFixed(3)),
      y: Number(inverted.y.toFixed(3)),
    })
  }

  const aspectRatio = `${plan.source.width} / ${plan.source.height}`
  const activeRange = ranges[activeSegmentIndex]

  return (
    <div className="auto-edit-preview-pane">
      <svg className="auto-edit-filters" width="0" height="0" aria-hidden="true">
        <defs>
          <filter id={rgbSplitFilterId} colorInterpolationFilters="sRGB" primitiveUnits="userSpaceOnUse">
            <feColorMatrix in="SourceGraphic" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="r" />
            <feOffset in="r" dx={-rgbShiftPx} dy="0" result="rShift" />
            <feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="g" />
            <feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="b" />
            <feOffset in="b" dx={rgbShiftPx} dy="0" result="bShift" />
            <feBlend in="rShift" in2="g" mode="screen" result="rg" />
            <feBlend in="rg" in2="bShift" mode="screen" />
          </filter>
          <filter id={crashFilterId} colorInterpolationFilters="sRGB">
            <feColorMatrix
              in="SourceGraphic"
              type="matrix"
              values="0.2126 0.7152 0.0722 0 0  0.2126 0.7152 0.0722 0 0  0.2126 0.7152 0.0722 0 0  0 0 0 1 0"
              result="luma"
            />
            <feColorMatrix
              in="luma"
              type="matrix"
              values="0.45 0 0 0 0.275  0 1.088 0 0 -0.044  0 0 1.75 0 -0.375  0 0 0 1 0"
            />
          </filter>
        </defs>
      </svg>
      <div
        className="auto-edit-stage"
        style={{ aspectRatio }}
        onClick={handleStageClick}
      >
        <video
          ref={videoRef}
          src={mediaUrl}
          aria-label="Auto-edit preview"
          data-segment-id={activeRange?.segment.id ?? ''}
          playsInline
          preload="auto"
          onSeeked={() => {
            seekingTargetRef.current = null
          }}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            if (modeRef.current === 'plan' && segmentIndexRef.current + 1 < ranges.length) {
              enterSegment(segmentIndexRef.current + 1, true)
            } else {
              stopCueAudio()
            }
          }}
        />
        <span
          className="auto-edit-focus-dot"
          aria-hidden="true"
          style={{ left: `${focusPoint.x * 100}%`, top: `${focusPoint.y * 100}%` }}
        />
      </div>
      <div className="auto-edit-transport">
        <button type="button" onClick={togglePlay}>{playing ? 'Pause' : 'Play'}</button>
        <input
          ref={rangeInputRef}
          type="range"
          min={0}
          max={totalDuration || 1}
          step={1 / fps}
          defaultValue={0}
          aria-label="Preview position"
          onChange={(event) => {
            stopCueAudio()
            playFromOutputTime(Number(event.target.value), false)
          }}
        />
        <output ref={readoutRef}>{`${totalDuration.toFixed(2)}s output`}</output>
      </div>
      <p className="auto-edit-preview-note">Preview approximates looks and slow motion; the render is exact.</p>
      {playbackError && <p className="auto-edit-alert" role="alert">{playbackError}</p>}
    </div>
  )
}
