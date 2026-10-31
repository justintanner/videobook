import { useEffect, useId, useState } from 'react'
import type { CSSProperties } from 'react'
import { Crosshair, Pause, Play, RefreshCw, Repeat } from 'lucide-react'
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

function stageStyle(clip: SplicePreviewClip): CSSProperties {
  const ratio = clip.width && clip.height ? clip.width / clip.height : 16 / 9
  return { '--splice-aspect': String(ratio) } as CSSProperties
}

function parsedOverlap(value: string): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

function overlapMaximum(match: SplicePreviewMatch | null, first: SplicePreviewClip): number {
  if (match) return Math.max(match.window, 1 / match.fps)
  return Math.min(SPLICE_PREVIEW_WINDOW_SECONDS, first.duration ?? SPLICE_PREVIEW_WINDOW_SECONDS)
}

function SpliceSummary({
  plan,
  first,
  second,
}: {
  plan: SplicePlan | null
  first: SplicePreviewClip
  second: SplicePreviewClip
}) {
  if (!plan) return <p className="splice-preview-summary">Scoring frames to find the cut…</p>
  return (
    <p className="splice-preview-summary">
      {plan.trimmed > 0
        ? <>Cuts <strong>{first.address}</strong> at <strong>{formatSpliceSeconds(plan.cut)}</strong>, trimming {formatSpliceSeconds(plan.trimmed)}</>
        : <>Plays <strong>{first.address}</strong> whole, then <strong>{second.address}</strong></>}
      {plan.total !== null && <> · {formatSpliceSeconds(plan.total)} total</>}
    </p>
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

function SpliceCurve({
  match,
  plan,
  overlap,
  loading,
  error,
  onRetry,
}: {
  match: SplicePreviewMatch | null
  plan: SplicePlan | null
  overlap: number
  loading: boolean
  error: string | null
  onRetry: () => void
}) {
  if (error) {
    return (
      <div className="splice-preview-curve splice-preview-curve-message" role="alert">
        <span>{error}</span>
        <button type="button" onClick={onRetry}>
          <RefreshCw size={12} aria-hidden="true" />
          Retry
        </button>
      </div>
    )
  }
  if (!match) {
    return (
      <div className="splice-preview-curve splice-preview-curve-message" aria-busy={loading}>
        <span>{loading ? 'Scoring frames…' : 'Frame scores unavailable'}</span>
      </div>
    )
  }
  const windowStart = Math.max(0, match.firstDuration - overlap)
  const windowLeft = spliceWindowFraction(match, windowStart) * 100
  const cutLeft = plan ? spliceWindowFraction(match, plan.cut) * 100 : null
  return (
    <div className="splice-preview-curve">
      <svg
        viewBox={`0 0 ${CURVE_WIDTH} ${CURVE_HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="How closely each frame matches the next clip's first frame"
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
      {cutLeft !== null && (
        <span className="splice-preview-curve-cut" style={{ left: `${cutLeft}%` }} aria-hidden="true" />
      )}
      <div className="splice-preview-curve-axis" aria-hidden="true">
        <span>{formatSpliceSeconds(spliceWindowStart(match))}</span>
        <span>{formatSpliceSeconds(match.firstDuration)}</span>
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
  const frameSeconds = 1 / (match?.fps ?? FALLBACK_FPS)
  const { firstRef, secondRef, phase, playing, play, stop, showCut } = useSplicePlayback(frameSeconds)
  const overlapSeconds = parsedOverlap(overlap)
  const plan = splicePlan(overlapSeconds, match, first.duration, second.duration)
  const maximum = overlapMaximum(match, first)
  const bestOverlap = match ? spliceBestOverlap(match) : null
  const sliderLabelId = useId()
  const cut = plan?.cut ?? null

  useEffect(() => {
    if (cut !== null && !playing) showCut(cut)
  }, [cut, playing, showCut])

  const changeOverlap = (value: string) => {
    onOverlapChange(value)
    const next = splicePlan(parsedOverlap(value), match, first.duration, second.duration)
    if (next && playing) play(next.cut, loop)
  }
  const togglePlay = () => {
    if (playing) {
      stop()
      return
    }
    if (plan) play(plan.cut, loop)
  }
  const toggleLoop = () => {
    const next = !loop
    setLoop(next)
    if (playing && plan) play(plan.cut, next)
  }
  const firstLoaded = () => {
    if (cut !== null && !playing) showCut(cut)
  }

  return (
    <section className="splice-preview" aria-label="Splice preview">
      <div className="splice-preview-stage" style={stageStyle(first)}>
        <video
          ref={firstRef}
          src={first.mediaUrl}
          className={phase === 'first' ? 'is-active' : undefined}
          preload="auto"
          playsInline
          onLoadedMetadata={firstLoaded}
        />
        <video
          ref={secondRef}
          src={second.mediaUrl}
          className={phase === 'second' ? 'is-active' : undefined}
          preload="auto"
          playsInline
        />
        <span className="splice-preview-badge">
          {phase === 'first' ? first.address : second.address}
        </span>
        {phase === 'first' && !playing && (
          <figure className="splice-preview-next">
            <video src={`${second.mediaUrl}#t=0.001`} muted playsInline preload="metadata" aria-hidden="true" />
            <figcaption>Next · {second.address}</figcaption>
          </figure>
        )}
      </div>
      <div className="splice-preview-transport">
        <button
          type="button"
          className="splice-preview-play"
          onClick={togglePlay}
          disabled={!plan}
          aria-label={playing ? 'Pause splice preview' : 'Play splice preview'}
        >
          {playing ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
          <span>{playing ? 'Pause' : 'Play cut'}</span>
        </button>
        <button
          type="button"
          className="splice-preview-loop"
          aria-pressed={loop}
          aria-label="Loop splice preview"
          title="Loop"
          onClick={toggleLoop}
        >
          <Repeat size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => bestOverlap !== null && changeOverlap(overlapDraftValue(bestOverlap))}
          disabled={busy || bestOverlap === null}
          title="Widen the overlap to reach the closest-matching frame"
        >
          <Crosshair size={14} aria-hidden="true" />
          <span>Best match</span>
        </button>
        <SpliceQualityChip plan={plan} />
      </div>
      <SpliceCurve
        match={match}
        plan={plan}
        overlap={overlapSeconds}
        loading={loading}
        error={error}
        onRetry={onRetry}
      />
      <div className="splice-preview-overlap">
        <div className="splice-preview-overlap-header">
          <span id={sliderLabelId}>Overlap</span>
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
        </div>
        <input
          type="range"
          className="splice-preview-slider"
          aria-labelledby={sliderLabelId}
          aria-valuetext={`${formatSpliceSeconds(overlapSeconds)} overlap`}
          min="0"
          max={maximum}
          step={frameSeconds}
          value={Math.min(maximum, overlapSeconds)}
          disabled={busy}
          onChange={(event) => changeOverlap(overlapDraftValue(event.target.valueAsNumber))}
        />
      </div>
      <SpliceSummary plan={plan} first={first} second={second} />
    </section>
  )
}
