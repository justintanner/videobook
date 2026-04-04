import { X } from 'lucide-react';

interface StatusHeaderProps {
  entryCount: number;
  failureCount: number;
  onClose: () => void;
}

export function StatusHeader({ entryCount, failureCount, onClose }: StatusHeaderProps) {
  return (
    <div className="flex items-center justify-between px-6 py-4 border-b border-border/50 shrink-0">
      <span className="text-xs font-mono font-bold tracking-widest text-zinc-400/70 uppercase">
        ACTIVITY_LOG
      </span>
      <div className="flex items-center gap-3">
        {entryCount > 0 && (
          <span className="text-xs font-mono text-zinc-400/80">
            {entryCount} {entryCount === 1 ? 'EVENT' : 'EVENTS'}
          </span>
        )}
        {failureCount > 0 && (
          <span className="text-xs font-mono text-red-400/80">
            {failureCount} failed
          </span>
        )}
        <button
          onClick={onClose}
          aria-label="Close activity log"
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
