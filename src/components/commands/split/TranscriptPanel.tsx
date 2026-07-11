import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { Loader2 } from 'lucide-react'
import { EmptyState } from '@/components/ui/EmptyState'
import type { TimedCue, TranscriptState } from './types'
import { findActiveCueIndex } from './utils'

interface TranscriptPanelProps {
  state: TranscriptState
  currentTime: number
  splitSec?: number | null
  onSelectTime?: (sec: number) => void
  compact?: boolean
}

export function TranscriptPanel({
  state,
  currentTime,
  splitSec = null,
  onSelectTime,
  compact = false,
}: TranscriptPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  if (state.status === 'loading') {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2">
        <Loader2 className="w-4 h-4 animate-spin text-neutral-500" />
        <span className="font-mono text-[11px] text-neutral-500">Loading transcript…</span>
      </div>
    )
  }

  if (state.status === 'missing') {
    return <EmptyState size="sm" className="flex items-center justify-center h-full">No transcript</EmptyState>
  }

  if (state.status === 'silence') {
    return <EmptyState size="sm" className="flex items-center justify-center h-full">No dialog detected</EmptyState>
  }

  if (state.status === 'error') {
    return (
      <div className="px-3 py-2 font-mono text-[11px] text-red-300 break-words">
        {state.message}
      </div>
    )
  }

  if (state.status === 'timed') {
    if (state.cues.length === 0) {
      return <EmptyState size="sm" className="flex items-center justify-center h-full">No speech at this boundary</EmptyState>
    }
    return (
      <TimedTranscript
        cues={state.cues}
        currentTime={currentTime}
        splitSec={splitSec}
        onSelectTime={onSelectTime}
        scrollRef={scrollRef}
      />
    )
  }

  return (
    <div className={cn('h-full px-3 py-2', compact ? 'flex items-center overflow-hidden' : 'overflow-y-auto')}>
      <p className={cn('font-mono text-[11px] text-neutral-300 whitespace-pre-wrap leading-relaxed', compact && 'line-clamp-2')}>
        {state.text}
      </p>
    </div>
  )
}

function TimedTranscript({
  cues,
  currentTime,
  splitSec,
  onSelectTime,
  scrollRef,
}: {
  cues: TimedCue[]
  currentTime: number
  splitSec: number | null
  onSelectTime?: (sec: number) => void
  scrollRef: React.RefObject<HTMLDivElement | null>
}) {
  const playbackIndex = findActiveCueIndex(cues, currentTime)
  const splitIndex = splitSec != null ? findActiveCueIndex(cues, splitSec) : -1
  const scrollTargetIndex = (
    splitSec != null && Math.abs(currentTime - splitSec) <= 0.08
      ? splitIndex
      : playbackIndex
  )

  useEffect(() => {
    const container = scrollRef.current
    if (!container || scrollTargetIndex < 0) return
    const el = container.querySelector<HTMLElement>(`[data-cue-index="${scrollTargetIndex}"]`)
    if (!el) return
    const containerRect = container.getBoundingClientRect()
    const elRect = el.getBoundingClientRect()
    if (elRect.top < containerRect.top || elRect.bottom > containerRect.bottom) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  }, [scrollTargetIndex, scrollRef])

  const clickable = Boolean(onSelectTime)

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto px-3 py-2">
      <div className="flex flex-wrap gap-x-0.5 gap-y-1">
        {cues.map((cue, i) => {
          const isPlayback = i === playbackIndex
          const isSplit = i === splitIndex
          const isPast = cue.end < currentTime
          return (
            <span
              key={`cue-${cue.start}-${i}`}
              data-cue-index={i}
              role={clickable ? 'button' : undefined}
              tabIndex={clickable ? 0 : undefined}
              onClick={clickable ? () => onSelectTime?.(cue.start) : undefined}
              onKeyDown={clickable ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onSelectTime?.(cue.start)
                }
              } : undefined}
              title={clickable ? `Set split at ${cue.start.toFixed(2)}s` : undefined}
              className={cn(
                'relative font-mono text-[12px] leading-relaxed rounded px-0.5 transition-colors duration-100',
                clickable && 'cursor-pointer hover:bg-neutral-600/40',
                isPlayback && 'bg-cyan-500/25 text-cyan-200',
                !isPlayback && isPast && 'text-neutral-400',
                !isPlayback && !isPast && 'text-neutral-500',
                isSplit && 'text-cyan-100',
              )}
            >
              {isSplit && (
                <span
                  aria-hidden
                  className="absolute left-0 top-0.5 bottom-0.5 w-0.5 -translate-x-1/2 rounded-full bg-cyan-300 shadow-[0_0_8px_rgba(34,211,238,0.7)] pointer-events-none"
                />
              )}
              {cue.text}
            </span>
          )
        })}
      </div>
    </div>
  )
}
