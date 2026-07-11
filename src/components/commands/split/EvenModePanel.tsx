import { cn } from '@/lib/utils'
import { formatDurationMS, formatPrecise } from './utils'
import type { IntervalSeconds } from './types'

const INTERVALS: IntervalSeconds[] = [5, 10, 15];

interface EvenModePanelProps {
  duration: number;
  interval: IntervalSeconds;
  onIntervalChange: (interval: IntervalSeconds) => void;
  boundaries: number[];
  clipDurations: number[];
  clipCount: number;
  disabled: boolean;
  disabledReason: string | null;
  activeBoundaryIndex: number;
  onActiveBoundaryChange: (index: number) => void;
}

export function EvenModePanel({
  duration,
  interval,
  onIntervalChange,
  boundaries,
  clipDurations,
  clipCount,
  disabled,
  disabledReason,
  activeBoundaryIndex,
  onActiveBoundaryChange,
}: EvenModePanelProps) {
  const activeBoundary = boundaries[activeBoundaryIndex] ?? null
  const fullClipCount = clipDurations.filter((value) => Math.abs(value - interval) < 0.01).length
  const tailDuration = clipDurations.at(-1)
  const hasTail = tailDuration !== undefined && Math.abs(tailDuration - interval) >= 0.01

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <span className="font-mono text-[10px] tracking-[0.2em] uppercase text-neutral-500">Interval</span>
        <div className="flex gap-1" role="group" aria-label="Interval selection">
          {INTERVALS.map((secs) => (
            <button
              key={secs}
              type="button"
              aria-pressed={interval === secs}
              onClick={() => onIntervalChange(secs)}
              className={cn(
                'px-3 py-1 rounded font-mono text-[11px] border transition-colors',
                'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neutral-400',
                interval === secs
                  ? 'bg-neutral-100 text-neutral-900 border-neutral-100'
                  : 'bg-neutral-800/50 text-neutral-400 border-neutral-600/50 hover:border-neutral-500 hover:text-neutral-200',
              )}
            >
              {secs}s
            </button>
          ))}
        </div>
      </div>

      <BoundaryStrip
        duration={duration}
        boundaries={boundaries}
        activeIndex={activeBoundaryIndex}
        onSelect={onActiveBoundaryChange}
      />

      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-mono text-[10px] tracking-[0.2em] uppercase text-neutral-500">
          {disabled ? 'Unavailable' : `${clipCount} clips`}
        </span>
        {!disabled && fullClipCount > 0 && (
          <span className="font-mono text-[11px] text-neutral-300">
            {fullClipCount} × {formatDurationMS(interval)}
            {hasTail ? ` + ${formatDurationMS(tailDuration)} tail` : ''}
          </span>
        )}
        {!disabled && activeBoundary !== null && (
          <span className="ml-auto font-mono text-[11px] text-neutral-400">
            Cut {activeBoundaryIndex + 1}/{boundaries.length} · {formatPrecise(activeBoundary)}
          </span>
        )}
        {disabled && disabledReason && (
          <span className="font-mono text-[10px] text-amber-400/70">{disabledReason}</span>
        )}
      </div>
    </div>
  )
}

function BoundaryStrip({
  duration,
  boundaries,
  activeIndex,
  onSelect,
}: {
  duration: number;
  boundaries: number[];
  activeIndex: number;
  onSelect: (index: number) => void;
}) {
  if (duration <= 0) return null
  if (boundaries.length === 0) {
    return <div className="h-10 rounded-md border border-neutral-700/50 bg-neutral-800/50" />
  }
  const selectNearest = (clientX: number, element: HTMLDivElement) => {
    if (boundaries.length === 0) return
    const rect = element.getBoundingClientRect()
    const time = Math.max(0, Math.min(duration, ((clientX - rect.left) / rect.width) * duration))
    let nearestIndex = 0
    let nearestDistance = Infinity
    for (let index = 0; index < boundaries.length; index++) {
      const distance = Math.abs(boundaries[index] - time)
      if (distance < nearestDistance) {
        nearestDistance = distance
        nearestIndex = index
      }
    }
    onSelect(nearestIndex)
  }

  return (
    <div
      className="relative h-10 bg-neutral-800/50 border border-neutral-700/50 rounded-md overflow-hidden cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neutral-400"
      role="slider"
      tabIndex={0}
      aria-label="Selected cut boundary"
      aria-valuemin={1}
      aria-valuemax={Math.max(1, boundaries.length)}
      aria-valuenow={Math.min(boundaries.length, activeIndex + 1)}
      onPointerDown={(event) => selectNearest(event.clientX, event.currentTarget)}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') {
          event.preventDefault()
          onSelect(Math.max(0, activeIndex - 1))
        } else if (event.key === 'ArrowRight') {
          event.preventDefault()
          onSelect(Math.min(boundaries.length - 1, activeIndex + 1))
        } else if (event.key === 'Home') {
          event.preventDefault()
          onSelect(0)
        } else if (event.key === 'End') {
          event.preventDefault()
          onSelect(Math.max(0, boundaries.length - 1))
        }
      }}
    >
      <div className="absolute inset-0 flex">
        <div className="flex-1 border-r border-neutral-700/40" />
        <div className="flex-1" />
      </div>
      {boundaries.map((b, i) => {
        const pct = duration > 0 ? (b / duration) * 100 : 0;
        return (
          <div
            key={`bound-${i}`}
            className={cn(
              'absolute top-0 bottom-0 w-0.5 pointer-events-none transition-all',
              activeIndex === i
                ? 'bg-cyan-300 shadow-[0_0_10px_rgba(34,211,238,0.6)] w-1 z-10'
                : 'bg-neutral-400',
            )}
            style={{ left: `${pct}%`, transform: 'translateX(-50%)' }}
            title={`${b.toFixed(1)}s`}
          >
            <span className="absolute -top-0.5 left-1/2 -translate-x-1/2 w-1.5 h-1.5 rounded-full bg-current" />
          </div>
        );
      })}
      <div className="absolute bottom-0 inset-x-0 flex justify-between px-2 pb-0.5">
        <span className="font-mono text-[9px] text-neutral-600">0:00</span>
        <span className="font-mono text-[9px] text-neutral-600">{formatDurationMS(duration)}</span>
      </div>
    </div>
  )
}
