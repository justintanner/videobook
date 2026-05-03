import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

type PromptHistorySize = 'sm' | 'lg';

interface PromptHistoryArrowsProps {
  cursor: number;            // -1 = on draft (newest+1)
  total: number;             // entries.length
  onPrev: () => void;
  onNext: () => void;
  className?: string;
  colorClass?: string;       // e.g. "text-amber-400" — defaults to muted
  size?: PromptHistorySize;  // default "sm" — popovers / chat input
}

function position(cursor: number, total: number): { current: number; total: number } {
  if (total === 0) return { current: 0, total: 0 };
  // entries are oldest→newest; cursor === total-1 is the newest (position 1 from the user's POV).
  // cursor === -1 (on draft) we treat as "past the newest" → no current position shown.
  if (cursor === -1) return { current: 0, total };
  return { current: total - cursor, total };
}

const SIZE_CLASSES: Record<PromptHistorySize, {
  root: string;
  button: string;
  icon: string;
  count: string;
  empty: string;
}> = {
  sm: {
    root: 'gap-0.5 text-[10px]',
    button: 'h-4 w-4',
    icon: 'h-3 w-3',
    count: 'px-1',
    empty: 'ml-1.5',
  },
  lg: {
    root: 'gap-1 text-sm',
    button: 'h-7 w-7',
    icon: 'h-4 w-4',
    count: 'px-2',
    empty: 'ml-2',
  },
};

function PromptHistoryArrows({
  cursor,
  total,
  onPrev,
  onNext,
  className,
  colorClass = 'text-muted-foreground',
  size = 'sm',
}: PromptHistoryArrowsProps) {
  const { current } = position(cursor, total);
  const canBack = total > 0 && cursor !== 0;
  const canForward = cursor !== -1;
  const empty = total === 0;
  const sz = SIZE_CLASSES[size];

  return (
    <div
      className={cn(
        'inline-flex items-center font-mono tabular-nums',
        sz.root,
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
          'flex items-center justify-center rounded',
          sz.button,
          'hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors',
        )}
      >
        <ChevronLeft className={sz.icon} />
      </button>
      <span className={cn('select-none', sz.count)}>
        {current === 0 ? `${total}` : `${current}/${total}`}
      </span>
      <button
        type="button"
        onClick={onNext}
        disabled={!canForward}
        aria-label="Next prompt"
        className={cn(
          'flex items-center justify-center rounded',
          sz.button,
          'hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors',
        )}
      >
        <ChevronRight className={sz.icon} />
      </button>
      {empty && (
        <span className={cn('italic opacity-60 select-none', sz.empty)}>no history yet</span>
      )}
    </div>
  );
}

export { PromptHistoryArrows };
export type { PromptHistoryArrowsProps };
