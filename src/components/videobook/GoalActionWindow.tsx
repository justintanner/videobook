import { useRef, type PointerEvent } from 'react'
import { Check, Play } from 'lucide-react'
import type { GoalRemixAnalysis } from '../../../server/src/goal-remix-model'
import { formatGoalSeconds } from '@/videobook/goals'

type Props = {
  analysis: GoalRemixAnalysis
  take: string
  duration: number | null
  start: number
  reviewed: boolean
  disabled: boolean
  onStart: (seconds: number) => void
  onPlay: (start: number, end: number) => void
}
type Span = { start: number, end: number }

function percent(value: number, total: number): string {
  return `${Math.min(100, Math.max(0, value / total * 100)).toFixed(3)}%`
}

function range(span: Span): string {
  return `${formatGoalSeconds(span.start)}–${formatGoalSeconds(span.end)} s`
}

function axisTicks(duration: number): number[] {
  const step = duration > 12 ? 5 : duration > 6 ? 2 : 1
  return Array.from({ length: Math.floor(duration / step) + 1 }, (_, index) => index * step)
}

function ShortTrack({ analysis, take, total }: { analysis: GoalRemixAnalysis, take: string, total: number }) {
  const { keep, change } = analysis.recipe
  return <div className="goal-window-row">
    <div className="goal-window-head"><span>The short · {formatGoalSeconds(total)} s</span></div>
    <div className="goal-window-short" aria-hidden="true">
      {keep.map(span => <i key={`keep:${span.start}`} data-tone="keep" style={{ left: percent(span.start, total), width: percent(span.end - span.start, total) }}>Source {range(span)}</i>)}
      {change.map(span => <i key={`change:${span.start}`} data-tone="change" style={{ left: percent(span.start, total), width: percent(span.end - span.start, total) }}>{take} · {range(span)}</i>)}
    </div>
  </div>
}

export function GoalActionWindow({ analysis, take, duration, start, reviewed, disabled, onStart, onPlay }: Props) {
  const assembly = analysis.recipe.assembly!
  const track = useRef<HTMLDivElement>(null)
  const grab = useRef<number | null>(null)
  const length = (assembly.changeEndFrame - assembly.changeStartFrame) / assembly.fps
  const total = assembly.totalFrames / assembly.fps
  const aligned = Math.round(start * assembly.fps) / assembly.fps
  const end = aligned + length
  const fits = duration === null || end <= duration + 0.0001
  const span = Math.max(duration ?? 0, end)
  const change = analysis.recipe.change[0]
  const secondsAt = (clientX: number) => {
    const box = track.current?.getBoundingClientRect()
    return box && box.width > 0 ? (clientX - box.left) / box.width * span : 0
  }
  const move = (seconds: number) => {
    const clamped = Math.max(0, Math.min(Math.max(0, (duration ?? span) - length), seconds))
    onStart(Number((Math.round(clamped * assembly.fps) / assembly.fps).toFixed(3)))
  }
  const press = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled || duration === null) return
    const at = secondsAt(event.clientX)
    const inside = at >= aligned && at <= end
    grab.current = inside ? at - aligned : length / 2
    if (!inside) move(at - length / 2)
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const drag = (event: PointerEvent<HTMLDivElement>) => {
    if (grab.current !== null) move(secondsAt(event.clientX) - grab.current)
  }
  const release = () => { grab.current = null }
  return <fieldset className="goal-action-window" disabled={disabled}>
    <legend>Retained action window</legend>
    <p className="goal-window-lead">Keep {range({ start: aligned, end })} of this take{change ? ` for ${range(change)} of the short` : ''}. Check that the whole action and its payoff fit.</p>
    <div className="goal-window-row">
      <div className="goal-window-head">
        <span>{take}{duration === null ? '' : ` · ${formatGoalSeconds(duration)} s`}</span>
        {reviewed && <span className="goal-window-saved"><Check size={12} strokeWidth={3} aria-hidden="true" />Saved for the short</span>}
      </div>
      <div ref={track} className="goal-window-track" data-draggable={duration !== null && !disabled ? '' : undefined} aria-hidden="true"
        onPointerDown={press} onPointerMove={drag} onPointerUp={release} onPointerCancel={release}>
        <i className="goal-window-bracket" data-fits={fits ? undefined : 'false'} style={{ left: percent(aligned, span), width: percent(length, span) }}><span>{formatGoalSeconds(length)} s</span></i>
      </div>
      {duration !== null && <div className="goal-window-axis" aria-hidden="true">{axisTicks(duration).map(tick => <span key={tick} style={{ left: percent(tick, span) }}>{tick}</span>)}</div>}
    </div>
    <ShortTrack analysis={analysis} take={take} total={total} />
    <div className="goal-window-controls">
      <label>Start in the take
        <input aria-label="Retained action start seconds" type="number" min="0" step={1 / assembly.fps} value={start} onChange={event => onStart(Number(event.target.value))} />
      </label>
      <button type="button" className="goal-panel-button" disabled={!fits} onClick={() => onPlay(aligned, end)}><Play size={11} aria-hidden="true" />Play the window</button>
    </div>
    {!fits && <p role="alert" className="goal-panel-warning">This window runs past the end of the take. Choose an earlier start or make a new take.</p>}
  </fieldset>
}
