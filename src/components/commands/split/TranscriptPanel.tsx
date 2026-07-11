import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { Loader2 } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import type { TimedCue, TranscriptState } from './types';

interface TranscriptPanelProps {
  state: TranscriptState;
  currentTime: number;
  compact?: boolean
}

export function TranscriptPanel({ state, currentTime, compact = false }: TranscriptPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  if (state.status === 'loading') {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2">
        <Loader2 className="w-4 h-4 animate-spin text-neutral-500" />
        <span className="font-mono text-[11px] text-neutral-500">Loading transcript…</span>
      </div>
    );
  }

  if (state.status === 'missing') {
    return <EmptyState size="sm" className="flex items-center justify-center h-full">No transcript</EmptyState>;
  }

  if (state.status === 'silence') {
    return <EmptyState size="sm" className="flex items-center justify-center h-full">No dialog detected</EmptyState>;
  }

  if (state.status === 'error') {
    return (
      <div className="px-3 py-2 font-mono text-[11px] text-red-300 break-words">
        {state.message}
      </div>
    );
  }

  if (state.status === 'timed') {
    if (compact) {
      const activeIndex = findActiveCueIndex(state.cues, currentTime)
      const activeCue = activeIndex >= 0 ? state.cues[activeIndex] : null
      return (
        <div className="flex h-full items-center px-3 py-2">
          <p className="line-clamp-2 font-mono text-[12px] leading-relaxed text-neutral-300">
            {activeCue?.text ?? 'No speech at this boundary'}
          </p>
        </div>
      )
    }
    return <TimedTranscript cues={state.cues} currentTime={currentTime} scrollRef={scrollRef} />;
  }

  return (
    <div className={cn('h-full px-3 py-2', compact ? 'flex items-center overflow-hidden' : 'overflow-y-auto')}>
      <p className={cn('font-mono text-[11px] text-neutral-300 whitespace-pre-wrap leading-relaxed', compact && 'line-clamp-2')}>
        {state.text}
      </p>
    </div>
  );
}

function TimedTranscript({
  cues,
  currentTime,
  scrollRef,
}: {
  cues: TimedCue[];
  currentTime: number;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  const activeIndex = findActiveCueIndex(cues, currentTime);
  const activeRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (activeRef.current && scrollRef.current) {
      const container = scrollRef.current;
      const el = activeRef.current;
      const containerRect = container.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      if (elRect.top < containerRect.top || elRect.bottom > containerRect.bottom) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
  }, [activeIndex, scrollRef]);

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto px-3 py-2">
      <div className="flex flex-wrap gap-x-0.5 gap-y-1">
        {cues.map((cue, i) => {
          const isActive = i === activeIndex;
          const isPast = cue.end < currentTime;
          return (
            <span
              key={`cue-${cue.start}-${i}`}
              ref={isActive ? activeRef : undefined}
              className={cn(
                'font-mono text-[12px] leading-relaxed rounded px-0.5 transition-colors duration-100',
                isActive && 'bg-cyan-500/25 text-cyan-200',
                !isActive && isPast && 'text-neutral-400',
                !isActive && !isPast && 'text-neutral-500',
              )}
            >
              {cue.text}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function findActiveCueIndex(cues: TimedCue[], currentTime: number): number {
  for (let i = 0; i < cues.length; i++) {
    if (currentTime >= cues[i].start && currentTime < cues[i].end) return i;
  }
  let lastPast = -1;
  for (let i = 0; i < cues.length; i++) {
    if (cues[i].end <= currentTime) lastPast = i;
  }
  return lastPast;
}
