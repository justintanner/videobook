import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Check, ChevronRight, Undo2, Volume2, VolumeX, X } from 'lucide-react'
import type { SceneData } from '../../../../server/src/scene-cuts'
import {
  cutKey,
  cutReviewRows,
  nextPendingCut,
  previousCut,
  reviewProgress,
  weakerCandidates,
  type CutReviewRow,
} from '@/videobook/cut-review'
import { formatSplitTimestamp } from '@/videobook/notebook-split-command'
import {
  addSceneCut,
  moveSceneCut,
  removeSceneCut,
  snapToFrame,
  type SceneCutEdit,
} from '@/videobook/scene-timeline-edits'
import { frameCaptureKey, useFrameCaptures } from '@/videobook/use-frame-captures'
import { CutReviewTimeline } from './CutReviewTimeline'
import { SegmentLoopTile } from './SegmentLoopTile'
import './SceneCutReview.css'

const FALLBACK_FRAME_STEP = 1 / 30
const SIDE_FRAMES = [1, 2, 3] as const
const NUDGES = [
  { label: '−1s', seconds: -1 },
  { label: '−0.1s', seconds: -0.1 },
  { label: '−1 frame', frames: -1 },
  { label: '+1 frame', frames: 1 },
  { label: '+0.1s', seconds: 0.1 },
  { label: '+1s', seconds: 1 },
] as const

type SceneCutReviewProps = {
  cutPointsSeconds: number[]
  frameStep: number | null
  mediaUrl: string
  onChange: (edit: SceneCutEdit) => void
  scenes: SceneData
  sourceDurationSeconds: number
}

type ReviewState = {
  currentSeconds: number | null
  removedSeconds: number[]
  reviewedKeys: ReadonlySet<string>
}

function FrameImage({ src, label, className }: { src: string | undefined; label: string; className?: string }) {
  return src
    ? <img className={className} src={src} alt={label} draggable={false} />
    : <span className={`cut-review-pending ${className ?? ''}`} aria-label={`${label} loading`} />
}

function statusMark(row: CutReviewRow, current: boolean) {
  if (row.status === 'kept') return <Check size={13} aria-label="Kept" />
  if (row.status === 'removed') return <X size={13} aria-label="Removed" />
  return current ? <ChevronRight size={13} aria-label="Reviewing" /> : <span aria-label="Not reviewed">·</span>
}

function withoutKey(keys: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(keys)
  next.delete(key)
  return next
}

export function SceneCutReview({
  cutPointsSeconds,
  frameStep,
  mediaUrl,
  onChange,
  scenes,
  sourceDurationSeconds,
}: SceneCutReviewProps) {
  const step = frameStep ?? FALLBACK_FRAME_STEP
  const [review, setReview] = useState<ReviewState>(() => ({
    currentSeconds: cutPointsSeconds[0] ?? null,
    removedSeconds: [],
    reviewedKeys: new Set(),
  }))
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const frame = requestAnimationFrame(() => rootRef.current?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(frame)
  }, [])
  const [soundOn, setSoundOn] = useState(false)
  const [slow, setSlow] = useState(false)
  const rows = cutReviewRows({
    cutPointsSeconds,
    frameStep,
    removedSeconds: review.removedSeconds,
    reviewedKeys: review.reviewedKeys,
    scenes,
  })
  const progress = reviewProgress(rows)
  const weaker = weakerCandidates({ cutPointsSeconds, frameStep, removedSeconds: review.removedSeconds, scenes })
  const currentIndex = review.currentSeconds === null ? -1 : cutPointsSeconds.indexOf(review.currentSeconds)
  const current = currentIndex >= 0 ? cutPointsSeconds[currentIndex]! : null
  const currentRow = rows.find((row) => row.t === review.currentSeconds) ?? null
  const frameTimes = current === null
    ? []
    : [-3, -2, -1, 0, 1, 2, 3].map((offset) => snapToFrame(current + offset * step, step))
      .filter((seconds) => seconds >= 0 && seconds < sourceDurationSeconds)
  const { frames, error } = useFrameCaptures({ mediaUrl, times: frameTimes, frameStep: step })
  const frameAt = (offset: number) => current === null
    ? undefined
    : frames.get(frameCaptureKey(snapToFrame(current + offset * step, step)))

  const select = (seconds: number) => setReview((state) => ({ ...state, currentSeconds: seconds }))
  const keep = () => {
    if (current === null) return
    const reviewedKeys = new Set(review.reviewedKeys).add(cutKey(current))
    const nextRows = rows.map((row) => row.t === current ? { ...row, status: 'kept' as const } : row)
    setReview({ ...review, reviewedKeys, currentSeconds: nextPendingCut(nextRows, current) ?? current })
  }
  const remove = () => {
    if (current === null) return
    const nextRows = rows.map((row) => row.t === current ? { ...row, status: 'removed' as const } : row)
    onChange(removeSceneCut({ cutPointsSeconds, index: currentIndex }))
    setReview({
      reviewedKeys: withoutKey(review.reviewedKeys, cutKey(current)),
      removedSeconds: [...review.removedSeconds, current],
      currentSeconds: nextPendingCut(nextRows, current) ?? current,
    })
  }
  const restore = (seconds: number) => {
    const edit = addSceneCut({ cutPointsSeconds, seconds, sourceDurationSeconds })
    if (!edit) return
    onChange(edit)
    setReview({
      ...review,
      removedSeconds: review.removedSeconds.filter((t) => t !== seconds),
      currentSeconds: seconds,
    })
  }
  const addCut = (seconds: number) => {
    const edit = addSceneCut({ cutPointsSeconds, seconds, sourceDurationSeconds })
    if (!edit) return
    onChange(edit)
    select(seconds)
  }
  const addWeaker = () => {
    const added = weaker.reduce<number[]>((cuts, marker) =>
      addSceneCut({ cutPointsSeconds: cuts, seconds: marker.t, sourceDurationSeconds })?.cutPointsSeconds ?? cuts,
    cutPointsSeconds)
    onChange({ cutPointsSeconds: added, selectedIndex: 0 })
  }
  const moveTo = (seconds: number) => {
    if (current === null) return
    const edit = moveSceneCut({ cutPointsSeconds, index: currentIndex, seconds: snapToFrame(seconds, step), sourceDurationSeconds })
    const moved = edit.cutPointsSeconds[currentIndex]!
    onChange(edit)
    const reviewedKeys = review.reviewedKeys.has(cutKey(current))
      ? new Set(withoutKey(review.reviewedKeys, cutKey(current))).add(cutKey(moved))
      : review.reviewedKeys
    setReview({ ...review, reviewedKeys, currentSeconds: moved })
  }
  const previous = () => {
    if (review.currentSeconds === null) return
    const target = previousCut(rows, review.currentSeconds)
    if (target !== null) select(target)
  }
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLInputElement || event.metaKey || event.ctrlKey) return
    const key = event.key.toLowerCase()
    const handled = key === 'k' || key === 'x' || key === 'j' || key === 'delete' || key === 'backspace'
      || key === 'arrowleft' || key === 'arrowright'
    if (!handled || current === null) return
    event.preventDefault()
    event.stopPropagation()
    if (key === 'k') keep()
    else if (key === 'x' || key === 'delete' || key === 'backspace') remove()
    else if (key === 'j') previous()
    else moveTo(current + (key === 'arrowleft' ? -1 : 1) * (event.shiftKey ? 0.1 : step))
  }

  return (
    <div ref={rootRef} className="cut-review" tabIndex={-1} aria-label="Review scene cuts" onKeyDown={handleKeyDown}>
      <nav className="cut-review-list" aria-label="Detected cuts">
        <div className="cut-review-progress">
          <span>{progress.done} of {progress.total} reviewed</span>
          <span className="cut-review-meter" aria-hidden="true">
            <span style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
          </span>
        </div>
        <ol>
          {rows.map((row) => {
            const isCurrent = row.t === review.currentSeconds
            return (
              <li key={cutKey(row.t)}>
                <button
                  type="button"
                  className={`cut-review-row cut-review-row-${row.status}${isCurrent ? ' current' : ''}`}
                  aria-current={isCurrent ? 'true' : undefined}
                  onClick={() => row.status === 'removed' ? restore(row.t) : select(row.t)}
                  title={row.status === 'removed' ? 'Restore this cut' : undefined}
                >
                  <span className="cut-review-mark">{statusMark(row, isCurrent)}</span>
                  <span className="cut-review-time">{formatSplitTimestamp(row.t)}</span>
                  <span className="cut-review-score">{row.score === null ? 'manual' : row.score.toFixed(1)}</span>
                  {row.status === 'removed' && <Undo2 size={12} aria-hidden="true" />}
                </button>
              </li>
            )
          })}
        </ol>
        {weaker.length > 0 && (
          <div className="cut-review-weaker">
            <span>{weaker.length} weaker candidate{weaker.length === 1 ? '' : 's'} hidden</span>
            <button type="button" onClick={addWeaker}>Add them for review</button>
          </div>
        )}
      </nav>

      <section className="cut-review-stage" aria-label="Cut point">
        {current === null
          ? <p className="cut-review-empty">No cuts left. Double-click the strip below to add one, or apply to keep the video whole.</p>
          : (
              <>
                <div className="cut-review-title">
                  <span>CUT {currentIndex + 1}</span>
                  <strong>{formatSplitTimestamp(current)}</strong>
                  <span className="cut-review-chip">
                    {currentRow?.score === null || currentRow === null ? 'added by hand' : `camera cut · score ${currentRow.score.toFixed(1)}`}
                  </span>
                </div>
                <div className="cut-review-frames">
                  <div className="cut-review-side before">
                    {[...SIDE_FRAMES].reverse().map((offset) => (
                      <button
                        key={`before-${offset}`}
                        type="button"
                        aria-label={`Move the cut ${offset} frame${offset === 1 ? '' : 's'} earlier`}
                        onClick={() => moveTo(current - offset * step)}
                      >
                        <FrameImage src={frameAt(-offset)} label={`${offset} frames earlier`} />
                      </button>
                    ))}
                  </div>
                  <figure>
                    <FrameImage className="cut-review-big" src={frameAt(-1)} label="Last frame before the cut" />
                    <figcaption>BEFORE · ends {formatSplitTimestamp(current)}</figcaption>
                  </figure>
                  <span className="cut-review-line" aria-hidden="true" />
                  <figure className="after">
                    <FrameImage className="cut-review-big" src={frameAt(0)} label="First frame after the cut" />
                    <figcaption>AFTER · starts {formatSplitTimestamp(current)}</figcaption>
                  </figure>
                  <div className="cut-review-side after">
                    {SIDE_FRAMES.map((offset) => (
                      <button
                        key={`after-${offset}`}
                        type="button"
                        aria-label={`Move the cut ${offset} frame${offset === 1 ? '' : 's'} later`}
                        onClick={() => moveTo(current + offset * step)}
                      >
                        <FrameImage src={frameAt(offset)} label={`${offset} frames later`} />
                      </button>
                    ))}
                  </div>
                </div>
                <div className="cut-review-nudges">
                  {NUDGES.map((nudge) => (
                    <button
                      key={nudge.label}
                      type="button"
                      onClick={() => moveTo(current + ('frames' in nudge ? nudge.frames * step : nudge.seconds))}
                    >
                      {nudge.label}
                    </button>
                  ))}
                </div>
                {error && <p className="confirm-field-error" role="alert">{error}</p>}
              </>
            )}
      </section>

      <aside className="cut-review-decide" aria-label="Decision">
        <span className="cut-review-label">Play across the cut</span>
        {current !== null && (
          <SegmentLoopTile
            label="±1s"
            mediaUrl={mediaUrl}
            muted={!soundOn}
            playbackRate={slow ? 0.25 : 1}
            windows={[{
              startSeconds: Math.max(0, current - 1),
              endSeconds: Math.min(sourceDurationSeconds, current + 1),
            }]}
          />
        )}
        <div className="cut-review-toggles">
          <button type="button" aria-pressed={soundOn} onClick={() => setSoundOn((on) => !on)}>
            {soundOn ? <Volume2 size={13} /> : <VolumeX size={13} />}{soundOn ? 'Sound on' : 'Sound off'}
          </button>
          <button type="button" aria-pressed={slow} onClick={() => setSlow((on) => !on)}>Slow ×0.25</button>
        </div>
        <div className="cut-review-decisions">
          <button type="button" className="cut-review-keep" disabled={current === null} onClick={keep}>
            Keep, next <kbd>K</kbd>
          </button>
          <button type="button" className="cut-review-remove" disabled={current === null} onClick={remove}>
            Remove <kbd>X</kbd>
          </button>
        </div>
        <span className="cut-review-keys">← → one frame · ⇧ 0.1s · <kbd>J</kbd> previous</span>
      </aside>

      <CutReviewTimeline
        currentSeconds={review.currentSeconds}
        frameStep={frameStep}
        rows={rows}
        scenes={scenes}
        onAdd={addCut}
        onSelect={(seconds) => {
          const row = rows.find((candidate) => candidate.t === seconds)
          if (row?.status === 'removed') restore(seconds)
          else select(seconds)
        }}
      />
    </div>
  )
}
