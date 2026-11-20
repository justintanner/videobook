import type { AutoEditSegmentRange } from '@/videobook/auto-edit-preview'

export function AutoEditStrip({
  ranges,
  activeIndex,
  totalDurationSeconds,
  onSelectSegment,
}: {
  ranges: readonly AutoEditSegmentRange[]
  activeIndex: number
  totalDurationSeconds: number
  onSelectSegment: (index: number) => void
}) {
  return (
    <section className="auto-edit-strip-section" aria-label="Edit plan strip">
      <div className="auto-edit-strip-header">
        <strong>Plan segments</strong>
        <span>{`${totalDurationSeconds.toFixed(2)}s output`}</span>
      </div>
      <div className="auto-edit-strip" role="group" aria-label="Segment strip">
        {ranges.map((range) => (
          <button
            key={range.segment.id}
            type="button"
            className="auto-edit-strip-block"
            data-segment-id={range.segment.id}
            data-role={range.segment.role}
            aria-pressed={range.index === activeIndex}
            style={{
              flexGrow: range.outputFrames,
              width: `${range.widthPercent.toFixed(2)}%`,
            }}
            title={`${range.label} (${range.outputDurationSeconds.toFixed(2)}s)`}
            onClick={() => onSelectSegment(range.index)}
          >
            {range.label}
          </button>
        ))}
      </div>
    </section>
  )
}
