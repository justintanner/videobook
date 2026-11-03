import type { CSSProperties } from 'react'
import { formatSplitTimestamp } from '@/videobook/notebook-split-command'
import type { SplitResultTimeline as Timeline, TimelineSpan } from '@/videobook/split-result-timeline'

function percent(seconds: number, totalSeconds: number): string {
  if (!(totalSeconds > 0)) return '0%'
  return `${Math.min(100, Math.max(0, (seconds / totalSeconds) * 100))}%`
}

function spanStyle(span: TimelineSpan, totalSeconds: number): CSSProperties {
  return {
    left: percent(span.startSeconds, totalSeconds),
    width: percent(span.endSeconds - span.startSeconds, totalSeconds),
  }
}

export function SplitResultTimeline({
  resultLabel,
  timeline,
}: {
  resultLabel: string
  timeline: Timeline
}) {
  const total = timeline.sourceSeconds
  return (
    <section className="confirm-section confirm-split-result" aria-label="Result preview">
      <span className="confirm-section-label">Result</span>
      <div className="confirm-split-result-row">
        <div className="confirm-split-result-heading">
          <span>Source</span>
          <strong>{formatSplitTimestamp(total)}</strong>
        </div>
        <div className="confirm-split-result-track">
          {timeline.kept.map((span) => (
            <span
              key={`kept:${span.startSeconds}`}
              className="confirm-split-result-kept"
              style={spanStyle(span, total)}
            />
          ))}
          {timeline.removed.map((span) => (
            <span
              key={`removed:${span.startSeconds}`}
              className="confirm-split-result-removed"
              style={spanStyle(span, total)}
            />
          ))}
        </div>
      </div>
      <div className="confirm-split-result-row">
        <div className="confirm-split-result-heading">
          <span>{resultLabel}</span>
          <strong>{formatSplitTimestamp(timeline.keptSeconds)}</strong>
        </div>
        <div className="confirm-split-result-track" data-result="true">
          <span
            className="confirm-split-result-kept"
            style={spanStyle({ startSeconds: 0, endSeconds: timeline.keptSeconds }, total)}
          />
          {timeline.splicePointsSeconds.map((seconds) => (
            <span
              key={`splice:${seconds}`}
              className="confirm-split-result-splice"
              title={`Splice at ${formatSplitTimestamp(seconds)}`}
              style={{ left: percent(seconds, total) }}
            />
          ))}
        </div>
      </div>
      <dl className="confirm-split-result-stats">
        <div>
          <dt>Before</dt>
          <dd>{formatSplitTimestamp(timeline.sourceSeconds)}</dd>
        </div>
        <div>
          <dt>Removed</dt>
          <dd data-tone="removed">{formatSplitTimestamp(timeline.removedSeconds)}</dd>
        </div>
        <div>
          <dt>After</dt>
          <dd data-tone="kept">{formatSplitTimestamp(timeline.keptSeconds)}</dd>
        </div>
      </dl>
    </section>
  )
}
