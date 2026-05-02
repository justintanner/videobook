import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

interface PromptHistoryArrowsProps {
  cursor: number;            // -1 = on draft (newest+1)
  total: number;             // entries.length
  onPrev: () => void;
  onNext: () => void;
  className?: string;
  colorClass?: string;       // e.g. "text-amber-400" — defaults to muted
}

function position(cursor: number, total: number): { current: number; total: number } {
  if (total === 0) return { current: 0, total: 0 };
  // entries are oldest→newest; cursor === total-1 is the newest (position 1 from the user's POV).
  // cursor === -1 (on draft) we treat as "past the newest" → no current position shown.
  if (cursor === -1) return { current: 0, total };
  return { current: total - cursor, total };
}

function PromptHistoryArrows({
  cursor,
  total,
  onPrev,
  onNext,
  className,
  colorClass = 'text-muted-foreground',
}: PromptHistoryArrowsProps) {
  if (total === 0) return null;
  const { current } = position(cursor, total);
  const canBack = total > 0 && cursor !== 0;
  const canForward = cursor !== -1;

  return (
    <div
      className={cn(
        'inline-flex items-center gap-0.5 text-[10px] font-mono tabular-nums',
        colorClass,
        className,
      )}
    >
      <button
        type="button"
        onClick={onPrev}
        disabled={!canBack}
        aria-label="Previous prompt"
        className={cn(
          'h-4 w-4 flex items-center justify-center rounded',
          'hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors',
        )}
      >
        <ChevronLeft className="h-3 w-3" />
      </button>
      <span className="px-1 select-none">
        {current === 0 ? `·/${total}` : `${current}/${total}`}
      </span>
      <button
        type="button"
        onClick={onNext}
        disabled={!canForward}
        aria-label="Next prompt"
        className={cn(
          'h-4 w-4 flex items-center justify-center rounded',
          'hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors',
        )}
      >
        <ChevronRight className="h-3 w-3" />
      </button>
    </div>
  );
}

export { PromptHistoryArrows };
export type { PromptHistoryArrowsProps };
