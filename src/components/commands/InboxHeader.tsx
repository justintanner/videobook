import { X } from 'lucide-react';

interface InboxHeaderProps {
  reviewCount: number;
  pendingCount: number;
  activeIndex: number;
  onClose: () => void;
}

export function InboxHeader({ reviewCount, pendingCount, activeIndex, onClose }: InboxHeaderProps) {
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
        {pendingCount > 0 && (
          <span className="text-xs font-mono text-amber-400/80">
            +{pendingCount} pending
          </span>
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
