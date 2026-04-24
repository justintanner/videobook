import type { OverlayProps } from './types';

export function FailedOverlay({ item }: OverlayProps) {
  const message = item.failedMessage?.trim();
  return (
    <div
      className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-red-950/50 overflow-hidden px-2 pt-2 pb-9"
      title={message}
    >
      {/* Scan lines effect */}
      <div
        className="absolute inset-0 pointer-events-none opacity-30"
        style={{
          background:
            'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,0,0,0.1) 2px, rgba(255,0,0,0.1) 4px)',
        }}
      />
      {/* Glitch/noise overlay */}
      <div className="absolute inset-0 bg-gradient-to-b from-red-500/10 to-transparent" />

      {message && (
        <div className="relative z-10 max-w-full text-[9px] font-mono leading-snug text-red-300/90 text-center line-clamp-[8]">
          {message}
        </div>
      )}
    </div>
  );
}
