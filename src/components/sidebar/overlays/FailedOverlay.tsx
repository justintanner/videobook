import type { OverlayProps } from './types';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function FailedOverlay({ item: _item }: OverlayProps) {
  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-red-950/50 overflow-hidden">
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

      {/* FAILED label */}
      <div className="relative z-10 text-sm font-mono font-bold tracking-[0.2em] text-red-500">FAILED</div>
    </div>
  );
}
