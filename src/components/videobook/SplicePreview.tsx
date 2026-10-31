import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Crosshair, Pause, Play, RefreshCw, Repeat, SkipForward } from 'lucide-react'
import {
  SPLICE_QUALITY_LABELS,
  formatSpliceSeconds,
  overlapDraftValue,
  spliceBestOverlap,
  spliceScorePath,
  splicePlan,
  spliceWindowFraction,
  spliceWindowStart,
  type SplicePlan,
  type SpliceTimeline,
} from '@/videobook/splice-preview'
import { useSplicePlayback } from '@/videobook/use-splice-playback'
import {
  SPLICE_PREVIEW_WINDOW_SECONDS,
  type SplicePreviewMatch,
} from '@/videobook/use-splice-preview'
import './SplicePreview.css'

export type SplicePreviewClip = {
  address: string
  mediaUrl: string
  width: number | null
  height: number | null
  duration: number | null
}

type SplicePreviewProps = {
  first: SplicePreviewClip
  second: SplicePreviewClip
  overlap: string
  busy: boolean
  match: SplicePreviewMatch | null
  loading: boolean
  error: string | null
  onRetry: () => void
  onOverlapChange: (value: string) => void
}

const CURVE_WIDTH = 240
const CURVE_HEIGHT = 40
const FALLBACK_FPS = 30
const CUT_LEAD_IN_SECONDS = 2

function clipAspect(clip: SplicePreviewClip): number {
  return clip.width && clip.height ? clip.width / clip.height : 16 / 9
}

function parsedOverlap(value: string): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

function matchOverlapMaximum(match: SplicePreviewMatch): number {
  return Math.max(match.window, 1 / match.fps)
}

function overlapMaximum(match: SplicePreviewMatch | null, first: SplicePreviewClip): number {
  if (match) return matchOverlapMaximum(match)
  return Math.min(SPLICE_PREVIEW_WINDOW_SECONDS, first.duration ?? SPLICE_PREVIEW_WINDOW_SECONDS)
}

function SpliceCutHeadline({
  plan,
  first,
  second,
}: {
  plan: SplicePlan | null
  first: SplicePreviewClip
  second: SplicePreviewClip
}) {
  if (!plan) {
    return (
      <div className="splice-preview-headline">
        <p className="splice-preview-summary">Scoring frames to find the cut…</p>
      </div>
    )
  }
  const total = plan.total !== null ? ` · ${formatSpliceSeconds(plan.total)} total` : ''
  return (
    <div className="splice-preview-headline">
      <span className="splice-preview-label">
        {plan.trimmed > 0 ? `Cut in ${first.address}` : `${first.address} plays whole`}
      </span>
      <div className="splice-preview-headline-row">
        <strong className="splice-preview-cut-time">{formatSpliceSeconds(plan.cut)}</strong>
        <span className="splice-preview-summary">
          {plan.trimmed > 0
            ? `trims ${formatSpliceSeconds(plan.trimmed)}${total}`
            : `then ${second.address}${total}`}
        </span>
        <SpliceQualityChip plan={plan} />
      </div>
    </div>
  )
}

function SpliceQualityChip({ plan }: { plan: SplicePlan | null }) {
  if (!plan?.quality || plan.score === null) return null
  return (
    <span
      className={`splice-preview-quality splice-preview-quality-${plan.quality}`}
      title={`Mean frame difference ${plan.score.toFixed(1)} of 255`}
    >
      {SPLICE_QUALITY_LABELS[plan.quality]}
    </span>
  )
}

function SpliceFrame({
  clip,
  time,
  tone,
}: {
  clip: SplicePreviewClip
  time: number
  tone: 'first' | 'second'
}) {
  const ref = useRef<HTMLVideoElement | null>(null)
  useEffect(() => {
    const video = ref.current
    if (video && video.readyState >= 1) video.currentTime = time
  }, [time])
  return (
    <figure className={`splice-preview-frame splice-preview-frame-${tone}`}>
      <video
        ref={ref}
        src={clip.mediaUrl}
        preload="auto"
        muted
        playsInline
        aria-label={`${clip.address} at ${formatSpliceSeconds(time)}`}
        onLoadedMetadata={(event) => {
          event.currentTarget.currentTime = time
        }}
      />
      <figcaption>{clip.address} · {formatSpliceSeconds(time)}</figcaption>
    </figure>
  )
}

function SpliceFramePair({
  plan,
  first,
  second,
  frameSeconds,
}: {
  plan: SplicePlan | null
  first: SplicePreviewClip
  second: SplicePreviewClip
  frameSeconds: number
}) {
  if (!plan) return null
  return (
    <div className="splice-preview-frames" aria-label="Frames on either side of the cut">
      <SpliceFrame clip={first} time={Math.max(0, plan.cut - frameSeconds)} tone="first" />
      <SpliceFrame clip={second} time={0} tone="second" />
    </div>
  )
}

function SpliceCurve({
  match,
  plan,
  overlap,
  loading,
  error,
  onRetry,
  slider,
}: {
  match: SplicePreviewMatch | null
  plan: SplicePlan | null
  overlap: number
  loading: boolean
  error: string | null
  onRetry: () => void
  slider: (style?: CSSProperties) => ReactNode
}) {
  if (error) {
    return (
      <>
        <div className="splice-preview-curve splice-preview-curve-message" role="alert">
          <span>{error}</span>
          <button type="button" onClick={onRetry}>
            <RefreshCw size={12} aria-hidden="true" />
            Retry
          </button>
        </div>
        {slider()}
      </>
    )
  }
  if (!match) {
    return (
      <>
        <div className="splice-preview-curve splice-preview-curve-message" aria-busy={loading}>
          <span>{loading ? 'Scoring frames…' : 'Frame scores unavailable'}</span>
        </div>
        {slider()}
      </>
    )
  }
  const windowLeft = spliceWindowFraction(match, Math.max(0, match.firstDuration - overlap)) * 100
  const cutLeft = plan ? spliceWindowFraction(match, plan.cut) * 100 : null
  const sliderLeft = spliceWindowFraction(match, match.firstDuration - matchOverlapMaximum(match)) * 100
  const marks = { '--splice-window': `${windowLeft}%` } as CSSProperties
  return (
    <div className="splice-preview-curve">
      <div className="splice-preview-curve-plot" style={marks}>
        <svg
          viewBox={`0 0 ${CURVE_WIDTH} ${CURVE_HEIGHT}`}
          preserveAspectRatio="none"
          role="img"
          aria-label="How closely each frame matches the next clip's first frame; higher is closer"
        >
          <rect
            className="splice-preview-curve-window"
            x={(windowLeft / 100) * CURVE_WIDTH}
            y="0"
            width={CURVE_WIDTH - (windowLeft / 100) * CURVE_WIDTH}
            height={CURVE_HEIGHT}
          />
          <path
            className="splice-preview-curve-line"
            d={spliceScorePath(match.scores, CURVE_WIDTH, CURVE_HEIGHT)}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        <span className="splice-preview-curve-edge" aria-hidden="true" />
        <span className="splice-preview-curve-grip" aria-hidden="true" />
        {cutLeft !== null && (
          <span className="splice-preview-curve-cut" style={{ left: `${cutLeft}%` }} aria-hidden="true" />
        )}
        {slider({ left: `${sliderLeft}%`, width: `${100 - sliderLeft}%` })}
      </div>
      <div className="splice-preview-curve-axis" aria-hidden="true">
        <span>{formatSpliceSeconds(spliceWindowStart(match))}</span>
        <span>{formatSpliceSeconds(match.firstDuration)} end</span>
      </div>
    </div>
  )
}

function SpliceBestHint({
  plan,
  bestPlan,
  bestOverlap,
}: {
  plan: SplicePlan | null
  bestPlan: SplicePlan | null
  bestOverlap: number | null
}) {
  if (!plan || !bestPlan || bestOverlap === null) return null
  if (bestPlan.frameIndex === plan.frameIndex || bestPlan.score === null || plan.score === null) return null
  if (bestPlan.score >= plan.score) return null
  return (
    <p className="splice-preview-hint">
      A closer frame sits at {formatSpliceSeconds(bestPlan.cut)}. Best match widens the overlap to {formatSpliceSeconds(bestOverlap)}.
    </p>
  )
}

function SpliceTimelineBar({
  timeline,
  position,
  first,
  second,
  onSeek,
}: {
  timeline: SpliceTimeline | null
  position: number
  first: SplicePreviewClip
  second: SplicePreviewClip
  onSeek: (seconds: number) => void
}) {
  const total = timeline?.total ?? 0
  const cutPercent = timeline && total > 0 ? (timeline.cut / total) * 100 : 50
  const headPercent = total > 0 ? (position / total) * 100 : 0
  const segments = { '--splice-cut': `${cutPercent}%`, '--splice-head': `${headPercent}%` } as CSSProperties
  return (
    <div className="splice-timeline" style={segments}>
      <div className="splice-timeline-track" aria-hidden="true">
        <span className="splice-timeline-segment splice-timeline-first">{first.address}</span>
        <span className="splice-timeline-segment splice-timeline-second">{second.address}</span>
        <span className="splice-timeline-cut" />
        <span className="splice-timeline-head" />
      </div>
      <input
        type="range"
        className="splice-timeline-scrubber"
        aria-label="Spliced video position"
        aria-valuetext={`${formatSpliceSeconds(position)} of ${formatSpliceSeconds(total)}`}
        min="0"
        max={total}
        step={timeline?.frameSeconds ?? 1 / FALLBACK_FPS}
        value={Math.min(position, total)}
        disabled={!timeline}
        onChange={(event) => onSeek(event.target.valueAsNumber)}
      />
      <div className="splice-timeline-axis" aria-hidden="true">
        <span>{formatSpliceSeconds(position)}</span>
        {timeline && <span>cut {formatSpliceSeconds(timeline.cut)}</span>}
        <span>{formatSpliceSeconds(total)}</span>
      </div>
    </div>
  )
}

export function SplicePreview({
  first,
  second,
  overlap,
  busy,
  match,
  loading,
  error,
  onRetry,
  onOverlapChange,
}: SplicePreviewProps) {
  const [loop, setLoop] = useState(false)
  const [loadedSecondDuration, setLoadedSecondDuration] = useState<number | null>(null)
  const frameSeconds = 1 / (match?.fps ?? FALLBACK_FPS)
  const { firstRef, secondRef, phase, position, playing, play, stop, seekTo } = useSplicePlayback()
  const overlapSeconds = parsedOverlap(overlap)
  const secondDuration = second.duration ?? loadedSecondDuration
  const plan = splicePlan(overlapSeconds, match, first.duration, secondDuration)
  const maximum = overlapMaximum(match, first)
  const bestOverlap = match ? spliceBestOverlap(match) : null
  const bestPlan = bestOverlap !== null ? splicePlan(bestOverlap, match, first.duration, secondDuration) : null
  const aspect = clipAspect(first)
  const sliderLabelId = useId()
  const cut = plan?.cut ?? null
  const total = plan?.total ?? (cut !== null && secondDuration !== null ? cut + secondDuration : null)
  const timeline = useMemo<SpliceTimeline | null>(
    () => (cut !== null && total !== null ? { cut, total, frameSeconds } : null),
    [cut, total, frameSeconds],
  )
  const shownCut = useRef<number | null>(null)

  useEffect(() => {
    if (!timeline || playing || shownCut.current === timeline.cut) return
    shownCut.current = timeline.cut
    seekTo(timeline, Math.max(0, timeline.cut - CUT_LEAD_IN_SECONDS))
  }, [timeline, playing, seekTo])

  const timelineFor = (value: string): SpliceTimeline | null => {
    const next = splicePlan(parsedOverlap(value), match, first.duration, secondDuration)
    if (!next || secondDuration === null) return null
    return { cut: next.cut, total: next.cut + secondDuration, frameSeconds }
  }
  const changeOverlap = (value: string) => {
    onOverlapChange(value)
    const next = timelineFor(value)
    if (!next) return
    shownCut.current = next.cut
    const target = Math.max(0, next.cut - CUT_LEAD_IN_SECONDS)
    if (playing) play(next, target, loop)
    else seekTo(next, target)
  }
  const togglePlay = () => {
    if (playing) {
      stop()
      return
    }
    if (timeline) play(timeline, position, loop)
  }
  const playFromCut = () => {
    if (timeline) play(timeline, Math.max(0, timeline.cut - CUT_LEAD_IN_SECONDS), loop)
  }
  const toggleLoop = () => {
    const next = !loop
    setLoop(next)
    if (playing && timeline) play(timeline, position, next)
  }
  const seek = (seconds: number) => {
    if (!timeline) return
    if (playing) play(timeline, seconds, loop)
    else seekTo(timeline, seconds)
  }
  const restorePosition = () => {
    if (timeline && !playing) seekTo(timeline, position)
  }

  const slider = (style?: CSSProperties) => (
    <input
      type="range"
      className={`splice-preview-slider${style ? ' splice-preview-slider-overlay' : ''}`}
      style={style}
      aria-labelledby={sliderLabelId}
      aria-valuetext={`${formatSpliceSeconds(overlapSeconds)} overlap`}
      min="0"
      max={maximum}
      step={frameSeconds}
      value={Math.min(maximum, overlapSeconds)}
      disabled={busy}
      onChange={(event) => changeOverlap(overlapDraftValue(event.target.valueAsNumber))}
    />
  )

  return (
    <section
      className={`splice-preview${aspect < 1 ? ' is-portrait' : ''}`}
      style={{ '--splice-aspect': String(aspect) } as CSSProperties}
      aria-label="Splice preview"
    >
      <div className="splice-preview-stage">
        <video
          ref={firstRef}
          src={first.mediaUrl}
          className={phase === 'first' ? 'is-active' : undefined}
          preload="auto"
          playsInline
          onLoadedMetadata={restorePosition}
        />
        <video
          ref={secondRef}
          src={second.mediaUrl}
          className={phase === 'second' ? 'is-active' : undefined}
          preload="auto"
          playsInline
          onLoadedMetadata={(event) => {
            const duration = event.currentTarget.duration
            if (Number.isFinite(duration)) setLoadedSecondDuration(duration)
            restorePosition()
          }}
        />
        <span className="splice-preview-badge">
          {phase === 'first' ? first.address : second.address}
        </span>
      </div>
      <div className="splice-preview-side">
        <div className="splice-preview-cut">
          <SpliceCutHeadline plan={plan} first={first} second={second} />
          <SpliceFramePair plan={plan} first={first} second={second} frameSeconds={frameSeconds} />
        </div>
        <div className="splice-preview-tune">
          <div className="splice-preview-overlap-header">
            <span id={sliderLabelId} className="splice-preview-label">Overlap</span>
            {match && <span className="splice-preview-label-hint">drag the window · higher is closer</span>}
          </div>
          <SpliceCurve
            match={match}
            plan={plan}
            overlap={overlapSeconds}
            loading={loading}
            error={error}
            onRetry={onRetry}
            slider={slider}
          />
          <div className="splice-preview-overlap">
            <label className="splice-preview-overlap-value">
              <input
                type="number"
                aria-label="Overlap seconds"
                min="0"
                step="0.01"
                value={overlap}
                disabled={busy}
                onChange={(event) => changeOverlap(event.target.value)}
              />
              <span aria-hidden="true">s</span>
            </label>
            <button
              type="button"
              onClick={() => bestOverlap !== null && changeOverlap(overlapDraftValue(bestOverlap))}
              disabled={busy || bestOverlap === null}
              title="Widen the overlap to reach the closest-matching frame"
            >
              <Crosshair size={14} aria-hidden="true" />
              <span>Best match</span>
            </button>
          </div>
          <SpliceBestHint plan={plan} bestPlan={bestPlan} bestOverlap={bestOverlap} />
        </div>
      </div>
      <div className="splice-preview-transport">
        <button
          type="button"
          className="splice-preview-icon"
          onClick={togglePlay}
          disabled={!timeline}
          aria-label={playing ? 'Pause spliced video' : 'Play spliced video'}
        >
          {playing ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
        </button>
        <button
          type="button"
          onClick={playFromCut}
          disabled={!timeline}
          title={`Play from ${CUT_LEAD_IN_SECONDS}s before the cut`}
        >
          <SkipForward size={14} aria-hidden="true" />
          <span>From cut</span>
        </button>
        <button
          type="button"
          className="splice-preview-icon splice-preview-loop"
          aria-pressed={loop}
          aria-label="Loop splice preview"
          title="Loop"
          onClick={toggleLoop}
        >
          <Repeat size={14} aria-hidden="true" />
        </button>
        <SpliceTimelineBar
          timeline={timeline}
          position={position}
          first={first}
          second={second}
          onSeek={seek}
        />
      </div>
    </section>
  )
}
