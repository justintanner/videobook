import { useEffect, useRef, type MouseEvent } from 'react'
import { ChevronLeft, ChevronRight, Pause, Play } from 'lucide-react'
import type { AliveCue } from '../../../server/src/remotion/subtitles/alive-types'
import type { AliveWordRow } from '@/videobook/alive-captions'
import { envelopePath, formatAliveTime, placementLabel } from '@/videobook/alive-captions'

const PIXELS_PER_SECOND = 90

type AliveTimelineProps = {
  duration: number
  fps: number
  time: number
  playing: boolean
  envelope: number[]
  rows: AliveWordRow[]
  cues: AliveCue[]
  activeCue: number
  snapped: boolean
  drift: { count: number; minMs: number; maxMs: number }
  onSeek: (seconds: number) => void
  onStep: (frames: number) => void
  onTogglePlay: () => void
  onToggleSnap: () => void
}

function percent(seconds: number, duration: number): string {
  return `${(Math.max(0, seconds) / duration) * 100}%`
}

function driftLabel(snapped: boolean, drift: AliveTimelineProps['drift'], words: number): string {
  if (drift.count === 0) return `All ${words} words already sit on their vocal onsets`
  if (snapped) return `${drift.count} words snapped to their vocal onsets`
  const range = drift.minMs === drift.maxMs ? `${drift.maxMs}` : `${drift.minMs}–${drift.maxMs}`
  return `${drift.count} words start ${range} ms off the vocal`
}

function rulerMarks(duration: number): number[] {
  const step = duration > 120 ? 10 : duration > 30 ? 5 : 1
  const marks: number[] = []
  for (let second = 0; second <= duration; second += step) marks.push(second)
  return marks
}

function useFollowPlayhead(time: number, duration: number, playing: boolean) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const scroller = scrollRef.current
    if (!scroller || !playing) return
    const x = (time / duration) * scroller.scrollWidth
    if (x < scroller.scrollLeft || x > scroller.scrollLeft + scroller.clientWidth * 0.85) {
      scroller.scrollLeft = Math.max(0, x - scroller.clientWidth * 0.2)
    }
  }, [time, duration, playing])
  return scrollRef
}

export function AliveCaptionsTimeline(props: AliveTimelineProps) {
  const { duration, fps, time, playing, envelope, rows, cues, activeCue, snapped, drift } = props
  const safeDuration = Math.max(duration, 0.1)
  const scrollRef = useFollowPlayhead(time, safeDuration, playing)
  const seekFromPointer = (event: MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    props.onSeek(((event.clientX - rect.left) / rect.width) * safeDuration)
  }
  return (
    <section className="alive-panel alive-timeline" aria-label="Caption timeline">
      <div className="alive-transport">
        <button type="button" aria-label="Previous frame" onClick={() => props.onStep(-1)}><ChevronLeft size={16} /></button>
        <button type="button" className="alive-play" aria-label={playing ? 'Pause' : 'Play'} onClick={props.onTogglePlay}>
          {playing ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <button type="button" aria-label="Next frame" onClick={() => props.onStep(1)}><ChevronRight size={16} /></button>
        <strong className="alive-clock">{formatAliveTime(time)}</strong>
        <span className="alive-muted">frame {Math.floor(time * fps)} / {Math.floor(safeDuration * fps)}</span>
        <span className="alive-spacer" />
        <span className="alive-drift" data-drifted={(drift.count > 0 && !snapped) || undefined}>{driftLabel(snapped, drift, rows.length)}</span>
        <button type="button" className={snapped ? 'alive-secondary' : 'alive-primary alive-warn'} disabled={drift.count === 0} onClick={props.onToggleSnap}>
          {snapped ? 'Use transcript timing' : 'Snap words to audio'}
        </button>
      </div>
      <div className="alive-lanes">
        <div className="alive-lane-labels" aria-hidden="true">
          <span className="alive-lane-ruler" />
          <span className="alive-lane-audio">Audio</span>
          <span className="alive-lane-words">Words</span>
          <span className="alive-lane-stacks">Stacks</span>
        </div>
        <div className="alive-lane-scroll" ref={scrollRef}>
          <div
            className="alive-lane-tracks"
            style={{ minWidth: safeDuration * PIXELS_PER_SECOND }}
            onClick={seekFromPointer}
            role="presentation"
          >
            <div className="alive-lane-ruler">
              {rulerMarks(safeDuration).map((second) => (
                <span key={second} style={{ left: percent(second, safeDuration) }}>{second}s</span>
              ))}
            </div>
            <div className="alive-lane-audio">
              <svg viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true">
                <path d={envelopePath(envelope)} />
              </svg>
              {!snapped && rows.filter((row) => row.drifted).map((row) => (
                <span key={row.key} className="alive-onset" style={{ left: percent(row.onset, safeDuration) }} />
              ))}
            </div>
            <div className="alive-lane-words">
              {rows.map((row) => (
                <span
                  key={row.key}
                  className="alive-chip"
                  data-active={(time >= row.start && time < row.end) || undefined}
                  data-drifted={(row.drifted && !snapped) || undefined}
                  style={{ left: percent(row.start, safeDuration), width: percent(row.end - row.start, safeDuration) }}
                >
                  {row.text}
                </span>
              ))}
            </div>
            <div className="alive-lane-stacks">
              {cues.map((cue, index) => (
                <span
                  key={cue.id}
                  className="alive-stack-bar"
                  data-active={index === activeCue || undefined}
                  style={{ left: percent(cue.start, safeDuration), width: percent(cue.end - cue.start, safeDuration) }}
                >
                  {placementLabel(cue)}
                </span>
              ))}
            </div>
            <span className="alive-playhead" style={{ left: percent(time, safeDuration) }} />
          </div>
        </div>
      </div>
      <div className="alive-legend" aria-hidden="true">
        <span><i className="alive-legend-chip" />Transcript word</span>
        <span><i className="alive-legend-drift" />Word off its vocal onset</span>
        <span><i className="alive-legend-onset" />Detected vocal onset</span>
      </div>
    </section>
  )
}
