import { cn } from '@/lib/utils';

interface SlugBadgeProps {
  slug: string;
  colorScheme: 'cyan' | 'gold';
  isError: boolean;
  isProcessing?: boolean;
}

export function SlugBadge({ slug, colorScheme, isError, isProcessing }: SlugBadgeProps) {
  const isCyan = colorScheme === 'cyan';
  const isGold = colorScheme === 'gold';

  return (
    <div className="absolute bottom-2 left-2 right-2 z-20 flex justify-start">
      <span
        className={cn(
          'max-w-full text-xs font-mono font-bold truncate px-2 py-1 rounded',
          'bg-black/85 backdrop-blur-md border',
          isError && 'text-red-500',
          !isError && isCyan && (isProcessing ? 'text-primary/70' : 'text-primary'),
          !isError && isGold && 'text-amber-400'
        )}
        style={{
          borderColor: isError
            ? 'rgba(239, 68, 68, 0.7)'
            : isGold
              ? 'rgba(251, 191, 36, 0.5)'
              : 'rgba(0, 255, 255, 0.2)',
          textShadow: isError ? '0 0 8px #ef4444' : isGold ? '0 0 8px #fbbf24' : undefined,
        }}
        title={slug}
      >
        {slug}
      </span>
    </div>
  );
}

interface DurationBadgeProps {
  duration: string;
  isProcessing: boolean;
}

export function DurationBadge({ duration, isProcessing }: DurationBadgeProps) {
  return (
    <div className="absolute top-2 left-2 z-20">
      <div
        className={cn(
          'px-2 py-1 rounded bg-black/70 backdrop-blur-md border text-[10px] font-mono font-bold shadow-[0_0_8px_-2px_var(--color-primary)]',
          isProcessing ? 'border-primary/50 text-primary/70' : 'border-primary/30 text-primary/90'
        )}
      >
        {duration}
      </div>
    </div>
  );
}

interface ResolutionBadgeProps {
  width: number;
  height: number;
}

export function ResolutionBadge({ width, height }: ResolutionBadgeProps) {
  return (
    <div className="absolute top-2 left-2 z-20">
      <div className="px-2 py-1 rounded bg-black/70 backdrop-blur-md border border-primary/30 text-[10px] font-mono text-primary/90 font-bold shadow-[0_0_8px_-2px_var(--color-primary)]">
        {width}x{height}
      </div>
    </div>
  );
}
