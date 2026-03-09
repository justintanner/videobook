import type { OverlayProps } from './types';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function UntranscribedOverlay({ item: _item }: OverlayProps) {
  return (
    <>
      {/* Subtle static grid overlay - matches transcribing but muted and no animation */}
      <div
        className="absolute inset-0 z-30 pointer-events-none"
        style={{
          backgroundImage:
            'linear-gradient(rgba(0, 255, 255, 0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(0, 255, 255, 0.05) 1px, transparent 1px)',
          backgroundSize: '8px 8px',
        }}
      />
      {/* Status badge - muted cyan theme with readable contrast */}
      <div className="absolute top-2 right-2 z-40">
        <div className="px-2 py-1 rounded bg-black/70 backdrop-blur-md border border-primary/40 text-[9px] font-mono text-primary/80 font-bold uppercase tracking-wide whitespace-nowrap">
          PENDING
        </div>
      </div>
    </>
  );
}
