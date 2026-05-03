import type { OverlayProps } from './types';
import { colorWithAlpha, getCardVisualState } from '../stateColors';

export function FailedOverlay({ item }: OverlayProps) {
  const message = item.failedMessage?.trim();
  const visual = getCardVisualState(item);
  return (
    <div
      className="absolute inset-0 z-30 flex flex-col items-center justify-center overflow-hidden px-2 pt-2 pb-9"
      style={{ backgroundColor: colorWithAlpha(visual, 0.22) }}
      title={message}
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

      {message && (
        <div className="relative z-10 max-w-full text-[9px] font-mono leading-snug text-center line-clamp-[8]" style={{ color: colorWithAlpha(visual, 0.9) }}>
          {message}
        </div>
      )}
    </div>
  );
}
