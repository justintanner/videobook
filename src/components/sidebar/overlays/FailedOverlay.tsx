import { RotateCcw } from 'lucide-react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { MediaItem } from '../types';
import type { OverlayProps } from './types';
import { colorWithAlpha, getCardVisualState } from '../stateColors';

export function FailedOverlay({ item, onRetry }: OverlayProps & { onRetry?: (item: MediaItem) => void }) {
  const message = item.failedMessage?.trim();
  const visual = getCardVisualState(item);
  return (
    <div
      className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-1 overflow-hidden px-2 pt-2 pb-8"
      style={{ backgroundColor: colorWithAlpha(visual, 0.22) }}
      title={message ?? 'Generation failed'}
    >
      {/* Scan lines effect */}
      <div
        className="absolute inset-0 pointer-events-none opacity-30"
        style={{
          background:
            `repeating-linear-gradient(0deg, transparent, transparent 2px, ${colorWithAlpha(visual, 0.1)} 2px, ${colorWithAlpha(visual, 0.1)} 4px)`,
        }}
      />
      {/* Glitch/noise overlay */}
      <div
        className="absolute inset-0"
        style={{ background: `linear-gradient(to bottom, ${colorWithAlpha(visual, 0.12)}, transparent)` }}
      />

      <div className="relative z-10 text-[9px] font-mono font-bold tracking-widest uppercase text-center" style={{ color: colorWithAlpha(visual, 0.95) }}>
        Generation failed
      </div>
      {message && (
        <div className="relative z-10 max-w-full text-[9px] font-mono leading-snug text-center line-clamp-3" style={{ color: colorWithAlpha(visual, 0.9) }}>
          {message}
        </div>
      )}
      {onRetry && (
        <button
          type="button"
          onClick={(e: ReactMouseEvent) => {
            e.stopPropagation();
            onRetry(item);
          }}
          aria-label={`Retry ${item.slug}`}
          title="Retry generation"
          className="relative z-20 mt-0.5 flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[9px] font-mono font-bold tracking-wider text-white transition-colors"
          style={{ backgroundColor: colorWithAlpha(visual, 0.85) }}
        >
 <RotateCcw className="size-2.5" />
          RETRY
        </button>
      )}
    </div>
  );
}
