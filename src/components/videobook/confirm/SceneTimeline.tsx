import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
} from 'react'
import { RotateCcw } from 'lucide-react'
import {
  DEFAULT_SCENE_MIN_SCORE,
  selectSceneCuts,
  type SceneData,
  type SceneMarker,
} from '../../../../server/src/scene-cuts'
import { formatSplitTimestamp } from '@/videobook/notebook-split-command'
import {
  addSceneCut,
  adjacentCut,
  filmstripTileFrames,
  moveSceneCut,
  removeSceneCut,
  snapToFrame,
  type SceneCutEdit,
} from '@/videobook/scene-timeline-edits'
import './SceneTimeline.css'

const TRACK_HEIGHT = 56
const MIN_SCORE_RANGE = { min: 3, max: 40 } as const

type SceneTimelineProps = {
  cutPointsSeconds: number[]
  frameStep: number | null
  onChange: (edit: SceneCutEdit) => void
  onCutFocus: (index: number) => void
  scenes: SceneData
  selectedIndex: number
  sourceDurationSeconds: number
  videoRef: RefObject<HTMLVideoElement | null>
}

type HollowMarker = SceneMarker & { kind: 'cut' | 'settle' }

function percent(seconds: number, duration: number): string {
  return `${Math.min(100, Math.max(0, (seconds / duration) * 100))}%`
}

function usePlayhead(videoRef: RefObject<HTMLVideoElement | null>): number {
  const [time, setTime] = useState(0)
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    let frame = 0
    const tick = () => {
      setTime(video.currentTime)
      if (!video.paused) frame = requestAnimationFrame(tick)
    }
    const start = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(tick)
    }
    const sync = () => setTime(video.currentTime)
    video.addEventListener('play', start)
    video.addEventListener('seeked', sync)
    video.addEventListener('timeupdate', sync)
    return () => {
      cancelAnimationFrame(frame)
      video.removeEventListener('play', start)
      video.removeEventListener('seeked', sync)
      video.removeEventListener('timeupdate', sync)
    }
  }, [videoRef])
  return time
}

function useTrackWidth(trackRef: RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const track = trackRef.current
    if (!track) return
    const observer = new ResizeObserver((entries) => {
      setWidth(entries[0]?.contentRect.width ?? 0)
    })
    observer.observe(track)
    return () => observer.disconnect()
  }, [trackRef])
  return width
}

function hollowMarkers(
  scenes: SceneData,
  cutPointsSeconds: readonly number[],
  frameStep: number | null,
): HollowMarker[] {
  const tolerance = Math.max(frameStep ?? 0, 0.02)
  const isActive = (marker: SceneMarker) =>
    cutPointsSeconds.some((cut) => Math.abs(cut - marker.t) <= tolerance)
  return [
    ...scenes.cuts.filter((marker) => !isActive(marker)).map((marker) => ({ ...marker, kind: 'cut' as const })),
    ...scenes.settles.filter((marker) => !isActive(marker)).map((marker) => ({ ...marker, kind: 'settle' as const })),
  ]
}

function detectedScore(scenes: SceneData, seconds: number, frameStep: number | null): number | null {
  const tolerance = Math.max(frameStep ?? 0, 0.02)
  return scenes.cuts.find((marker) => Math.abs(marker.t - seconds) <= tolerance)?.score ?? null
}

function Filmstrip({ scenes, width }: { scenes: SceneData; width: number }) {
  const filmstrip = scenes.filmstrip
  if (!filmstrip || width <= 0) return null
  const tileWidth = TRACK_HEIGHT * (filmstrip.frameWidth / filmstrip.frameHeight)
  const tiles = Math.max(1, Math.round(width / tileWidth))
  const shownWidth = width / tiles
  return (
    <div className="scene-timeline-filmstrip" aria-hidden="true">
      {filmstripTileFrames({ frames: filmstrip.frames, tiles }).map((frame, tile) => (
        <span
          key={`${tile}:${frame}`}
          style={{
            backgroundImage: `url(${filmstrip.url})`,
            backgroundSize: `${filmstrip.frames * shownWidth}px ${TRACK_HEIGHT}px`,
            backgroundPosition: `${-frame * shownWidth}px 0`,
            width: `${shownWidth}px`,
          }}
        />
      ))}
    </div>
  )
}

export function SceneTimeline({
  cutPointsSeconds,
  frameStep,
  onChange,
  onCutFocus,
  scenes,
  selectedIndex,
  sourceDurationSeconds,
  videoRef,
}: SceneTimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null)
  const dragIndex = useRef<number | null>(null)
  const [minScore, setMinScore] = useState(DEFAULT_SCENE_MIN_SCORE)
  const [includeSettles, setIncludeSettles] = useState(false)
  const playhead = usePlayhead(videoRef)
  const trackWidth = useTrackWidth(trackRef)
  const duration = sourceDurationSeconds
  const boundaries = [0, ...cutPointsSeconds, duration]
  const selectedStart = boundaries[selectedIndex] ?? 0
  const selectedEnd = boundaries[selectedIndex + 1] ?? duration
  const hollow = hollowMarkers(scenes, cutPointsSeconds, frameStep)

  const secondsAt = (clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0) return 0
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    return snapToFrame(ratio * duration, frameStep)
  }
  const seek = (seconds: number) => {
    const video = videoRef.current
    if (video) video.currentTime = seconds
  }
  const reselect = (options: { minScore: number; includeSettles: boolean }) => {
    onChange({ cutPointsSeconds: selectSceneCuts(scenes, options), selectedIndex: 0 })
  }
  const addAt = (seconds: number) => {
    const edit = addSceneCut({ cutPointsSeconds, seconds, sourceDurationSeconds: duration })
    if (!edit) return
    onChange(edit)
    onCutFocus(edit.selectedIndex - 1)
  }
  const moveCut = (index: number, seconds: number) => {
    onChange(moveSceneCut({ cutPointsSeconds, index, seconds, sourceDurationSeconds: duration }))
  }

  const handleTrackClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return
    const seconds = secondsAt(event.clientX)
    seek(seconds)
    onChange({ cutPointsSeconds, selectedIndex: cutPointsSeconds.filter((cut) => cut <= seconds).length })
  }
  const handleTrackDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return
    addAt(secondsAt(event.clientX))
  }
  const handleCutPointerDown = (index: number) => (event: PointerEvent<HTMLButtonElement>) => {
    dragIndex.current = index
    onCutFocus(index)
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const handleCutPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    if (dragIndex.current === null) return
    const seconds = secondsAt(event.clientX)
    moveCut(dragIndex.current, seconds)
    seek(seconds)
  }
  const handleCutPointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    dragIndex.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
  }
  const handleCutKeyDown = (index: number) => (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      event.stopPropagation()
      onChange(removeSceneCut({ cutPointsSeconds, index }))
      return
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    event.stopPropagation()
    const step = event.shiftKey ? 0.1 : frameStep ?? 0.01
    const seconds = snapToFrame(cutPointsSeconds[index]! + (event.key === 'ArrowLeft' ? -step : step), frameStep)
    moveCut(index, seconds)
    seek(seconds)
  }
  const handleTimelineKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLInputElement) return
    if (event.key === '[' || event.key === ']') {
      event.preventDefault()
      const target = adjacentCut(cutPointsSeconds, playhead, event.key === '[' ? -1 : 1)
      if (target !== null) seek(target)
      return
    }
    if (event.key === 'c' || event.key === 'C') {
      event.preventDefault()
      addAt(snapToFrame(playhead, frameStep))
    }
  }

  const trackStyle = {
    '--scene-head': percent(playhead, duration),
    '--scene-selected-start': percent(selectedStart, duration),
    '--scene-selected-width': percent(selectedEnd - selectedStart, duration),
    height: `${TRACK_HEIGHT}px`,
  } as CSSProperties

  return (
    <section className="scene-timeline" aria-label="Scene timeline" onKeyDown={handleTimelineKeyDown}>
      <div className="scene-timeline-controls">
        <span className="confirm-section-label">Scenes</span>
        <strong>{cutPointsSeconds.length + 1} clip{cutPointsSeconds.length === 0 ? '' : 's'}</strong>
        <label className="scene-timeline-sensitivity">
          <span>Min cut score</span>
          <input
            type="range"
            min={MIN_SCORE_RANGE.min}
            max={MIN_SCORE_RANGE.max}
            step={1}
            value={minScore}
            onChange={(event) => {
              const next = event.target.valueAsNumber
              setMinScore(next)
              reselect({ minScore: next, includeSettles })
            }}
          />
          <output>{minScore}</output>
        </label>
        <label className="scene-timeline-toggle">
          <input
            type="checkbox"
            checked={includeSettles}
            onChange={(event) => {
              setIncludeSettles(event.target.checked)
              reselect({ minScore, includeSettles: event.target.checked })
            }}
          />
          <span>Motion settles</span>
        </label>
        <button type="button" onClick={() => reselect({ minScore, includeSettles })}>
          <RotateCcw size={12} aria-hidden="true" />Reset
        </button>
        <button type="button" onClick={() => addAt(snapToFrame(playhead, frameStep))}>
          Cut at playhead
        </button>
      </div>
      <div
        ref={trackRef}
        className="scene-timeline-track"
        style={trackStyle}
        onClick={handleTrackClick}
        onDoubleClick={handleTrackDoubleClick}
      >
        <Filmstrip scenes={scenes} width={trackWidth} />
        <span className="scene-timeline-selected" />
        {hollow.map((marker) => (
          <button
            key={`${marker.kind}:${marker.t}`}
            type="button"
            className={`scene-timeline-hint scene-timeline-hint-${marker.kind}`}
            style={{ left: percent(marker.t, duration) }}
            title={`${marker.kind === 'cut' ? 'Camera cut' : 'Motion settle'} ${formatSplitTimestamp(marker.t)} · score ${marker.score} · click to add`}
            aria-label={`Add cut at ${formatSplitTimestamp(marker.t)}`}
            onClick={() => addAt(marker.t)}
          />
        ))}
        {cutPointsSeconds.map((cut, index) => {
          const score = detectedScore(scenes, cut, frameStep)
          return (
            <button
              key={`cut:${index}`}
              type="button"
              className="scene-timeline-cut"
              style={{ left: percent(cut, duration) }}
              title={`Cut ${formatSplitTimestamp(cut)}${score === null ? ' · manual' : ` · score ${score}`} · drag, ← → frame, ⇧ 0.1s, Delete removes`}
              aria-label={`Cut at ${formatSplitTimestamp(cut)}`}
              onPointerDown={handleCutPointerDown(index)}
              onPointerMove={handleCutPointerMove}
              onPointerUp={handleCutPointerUp}
              onDoubleClick={() => onChange(removeSceneCut({ cutPointsSeconds, index }))}
              onKeyDown={handleCutKeyDown(index)}
              onFocus={() => {
                onCutFocus(index)
                seek(cut)
              }}
            />
          )
        })}
        <span className="scene-timeline-head" aria-hidden="true" />
      </div>
      <div className="scene-timeline-axis" aria-hidden="true">
        <span>{formatSplitTimestamp(playhead)}</span>
        <span>click seeks · double-click adds · <kbd>[</kbd> <kbd>]</kbd> jump · <kbd>C</kbd> cut here</span>
        <span>{formatSplitTimestamp(duration)}</span>
      </div>
    </section>
  )
}
