import {
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type RefObject,
} from 'react'
import type { SceneData } from '../../../../server/src/scene-cuts'
import { cutKey, type CutReviewRow } from '@/videobook/cut-review'
import { formatSplitTimestamp } from '@/videobook/notebook-split-command'
import { filmstripTileFrames, snapToFrame } from '@/videobook/scene-timeline-edits'

const TRACK_HEIGHT = 40

type CutReviewTimelineProps = {
  currentSeconds: number | null
  frameStep: number | null
  onAdd: (seconds: number) => void
  onSelect: (seconds: number) => void
  rows: readonly CutReviewRow[]
  scenes: SceneData
}

function percent(seconds: number, duration: number): string {
  return `${Math.min(100, Math.max(0, (seconds / duration) * 100))}%`
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

function Filmstrip({ scenes, width }: { scenes: SceneData; width: number }) {
  const filmstrip = scenes.filmstrip
  if (!filmstrip || width <= 0) return null
  const tileWidth = TRACK_HEIGHT * (filmstrip.frameWidth / filmstrip.frameHeight)
  const tiles = Math.max(1, Math.round(width / tileWidth))
  const shownWidth = width / tiles
  return (
    <div className="cut-review-filmstrip" aria-hidden="true">
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

export function CutReviewTimeline({
  currentSeconds,
  frameStep,
  onAdd,
  onSelect,
  rows,
  scenes,
}: CutReviewTimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null)
  const width = useTrackWidth(trackRef)
  const duration = scenes.durationSeconds
  const handleDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return
    const rect = event.currentTarget.getBoundingClientRect()
    if (rect.width <= 0) return
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
    onAdd(snapToFrame(ratio * duration, frameStep))
  }
  return (
    <div className="cut-review-timeline">
      <div
        ref={trackRef}
        className="cut-review-track"
        style={{ height: `${TRACK_HEIGHT}px` }}
        title="Double-click to add a cut"
        onDoubleClick={handleDoubleClick}
      >
        <Filmstrip scenes={scenes} width={width} />
        {rows.map((row) => (
          <button
            key={cutKey(row.t)}
            type="button"
            className={`cut-review-tick cut-review-tick-${row.status}${row.t === currentSeconds ? ' current' : ''}`}
            style={{ left: percent(row.t, duration) }}
            aria-label={`Cut at ${formatSplitTimestamp(row.t)}, ${row.status}`}
            onClick={() => onSelect(row.t)}
          />
        ))}
      </div>
      <div className="cut-review-axis" aria-hidden="true">
        <span>0:00.000</span>
        <span>double-click the strip to add a cut</span>
        <span>{formatSplitTimestamp(duration)}</span>
      </div>
    </div>
  )
}
