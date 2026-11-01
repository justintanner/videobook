import { ChevronLeft, ChevronRight } from 'lucide-react'
import { formatSplitTimestamp } from '@/videobook/notebook-split-command'
import { snapToFrame } from '@/videobook/scene-timeline-edits'
import { frameCaptureKey, useFrameCaptures } from '@/videobook/use-frame-captures'
import './CutInspector.css'

const STRIP_OFFSETS = [-4, -3, -2, -1, 0, 1, 2, 3] as const
const FALLBACK_FRAME_STEP = 1 / 30
const SECOND_STEPS = [-1, -0.1, 0.1, 1] as const

type CutInspectorProps = {
  activeCutIndex: number
  cutPointsSeconds: number[]
  frameStep: number | null
  mediaUrl: string
  onMoveCut: (index: number, seconds: number) => void
  onSelectCut: (index: number) => void
  sourceDurationSeconds: number
}

function frameTimes(cut: number, step: number, duration: number): number[] {
  return STRIP_OFFSETS
    .map((offset) => snapToFrame(cut + offset * step, step))
    .filter((seconds) => seconds >= 0 && seconds < duration)
}

function FrameImage({ src, label }: { src: string | undefined; label: string }) {
  return src
    ? <img src={src} alt={label} draggable={false} />
    : <span className="cut-inspector-pending" aria-label={`${label} loading`} />
}

export function CutInspector({
  activeCutIndex,
  cutPointsSeconds,
  frameStep,
  mediaUrl,
  onMoveCut,
  onSelectCut,
  sourceDurationSeconds,
}: CutInspectorProps) {
  const step = frameStep ?? FALLBACK_FRAME_STEP
  const cut = cutPointsSeconds[activeCutIndex]
  const times = cut === undefined ? [] : frameTimes(cut, step, sourceDurationSeconds)
  const { frames, error } = useFrameCaptures({ mediaUrl, times, frameStep: step })
  if (cut === undefined) {
    return (
      <section className="confirm-section cut-inspector" aria-label="Cut point">
        <span className="confirm-section-label">Cut point</span>
        <p className="confirm-help">Add a cut to compare the frames on either side.</p>
      </section>
    )
  }
  const before = frames.get(frameCaptureKey(snapToFrame(cut - step, step)))
  const after = frames.get(frameCaptureKey(snapToFrame(cut, step)))
  const move = (seconds: number) => onMoveCut(activeCutIndex, snapToFrame(seconds, step))

  return (
    <section className="confirm-section cut-inspector" aria-label="Cut point">
      <div className="confirm-section-heading">
        <span>Cut {activeCutIndex + 1} of {cutPointsSeconds.length}</span>
        <div className="cut-inspector-switch">
          <button
            type="button"
            aria-label="Previous cut"
            disabled={activeCutIndex === 0}
            onClick={() => onSelectCut(activeCutIndex - 1)}
          >
            <ChevronLeft size={13} />
          </button>
          <strong>{formatSplitTimestamp(cut)}</strong>
          <button
            type="button"
            aria-label="Next cut"
            disabled={activeCutIndex >= cutPointsSeconds.length - 1}
            onClick={() => onSelectCut(activeCutIndex + 1)}
          >
            <ChevronRight size={13} />
          </button>
        </div>
      </div>
      <div className="cut-inspector-pair">
        <figure>
          <FrameImage src={before} label="Last frame before the cut" />
          <figcaption>BEFORE · ends {formatSplitTimestamp(cut)}</figcaption>
        </figure>
        <figure>
          <FrameImage src={after} label="First frame after the cut" />
          <figcaption>AFTER · starts {formatSplitTimestamp(cut)}</figcaption>
        </figure>
      </div>
      <div className="cut-inspector-strip" role="group" aria-label="Frames around the cut">
        {times.map((seconds) => {
          const isAfter = seconds >= cut - step / 2
          const isFirst = Math.abs(seconds - cut) < step / 2
          return (
            <button
              key={frameCaptureKey(seconds)}
              type="button"
              className={[
                isAfter ? 'after' : 'before',
                isFirst ? 'first' : '',
              ].filter(Boolean).join(' ')}
              title={`Start the next clip at ${formatSplitTimestamp(seconds)}`}
              aria-label={`Cut at ${formatSplitTimestamp(seconds)}`}
              aria-pressed={isFirst}
              onClick={() => move(seconds)}
            >
              <FrameImage src={frames.get(frameCaptureKey(seconds))} label={formatSplitTimestamp(seconds)} />
            </button>
          )
        })}
      </div>
      <div className="confirm-split-nudges cut-inspector-nudges">
        {SECOND_STEPS.slice(0, 2).map((delta) => (
          <button key={delta} type="button" onClick={() => move(cut + delta)}>−{Math.abs(delta)}s</button>
        ))}
        <button type="button" onClick={() => move(cut - step)}>−1 frame</button>
        <button type="button" onClick={() => move(cut + step)}>+1 frame</button>
        {SECOND_STEPS.slice(2).map((delta) => (
          <button key={delta} type="button" onClick={() => move(cut + delta)}>+{delta}s</button>
        ))}
      </div>
      {error && <p className="confirm-field-error" role="alert">{error}</p>}
    </section>
  )
}
