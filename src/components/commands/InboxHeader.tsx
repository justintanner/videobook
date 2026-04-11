import { X } from 'lucide-react';

interface InboxHeaderProps {
  reviewCount: number;
  pendingCount: number;
  failedCount: number;
  activeIndex: number;
  onClose: () => void;
  onClearFailed: () => void;
}

export function InboxHeader({
  reviewCount,
  pendingCount,
  failedCount,
  activeIndex,
  onClose,
  onClearFailed,
}: InboxHeaderProps) {
  const activePendingCount = Math.max(0, pendingCount - failedCount);
  return (
    <div className="flex items-center justify-between px-6 py-4 border-b border-border/50 shrink-0">
      <span className="text-xs font-mono font-bold tracking-widest text-primary/70 uppercase">REVIEW_QUEUE</span>
      <div className="flex items-center gap-3">
        {reviewCount > 0 && (
          <span className="text-xs font-mono text-cyan-400/80">
            {activeIndex >= 0
              ? `${activeIndex + 1}/${reviewCount}`
              : `${reviewCount} ${reviewCount === 1 ? 'VIDEO' : 'VIDEOS'}`}
          </span>
        )}
        {activePendingCount > 0 && (
          <span className="text-xs font-mono text-amber-400/80">
            +{activePendingCount} pending
          </span>
        )}
        {failedCount > 0 && (
          <button
            onClick={onClearFailed}
            className="text-[10px] font-mono font-bold tracking-[0.15em] uppercase px-2 py-1 border border-red-900/60 text-red-400 bg-red-950/20 hover:bg-red-950/40 hover:text-red-300 hover:border-red-800 transition-colors rounded"
          >
            Clear {failedCount} failed
          </button>
        )}
        <button
          onClick={onClose}
          aria-label="Close review queue"
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
