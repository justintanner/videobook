import type { OverlayProps } from './types';

function getBadgeText(status: string | undefined): string {
  if (status === 'rendering-landscape') return 'RENDERING LANDSCAPE';
  if (status === 'rendering-portrait') return 'RENDERING PORTRAIT';
  if (status === 'render-queued') return 'QUEUED';
  if (status === 'render-queued-landscape') return 'QUEUED LANDSCAPE';
  if (status === 'render-queued-portrait') return 'QUEUED PORTRAIT';
  if (status === 'rendering-square') return 'RENDERING SQUARE';
  if (status === 'render-queued-square') return 'QUEUED SQUARE';
  return 'RENDERING';
}

export function RenderingOverlay({ item }: OverlayProps) {
  const badgeText = getBadgeText(item.status);

  return (
    <>
      {/* Scanning line */}
      <div className="absolute inset-0 z-30 overflow-hidden pointer-events-none">
        <div
          className="absolute inset-y-0 w-20 bg-gradient-to-r from-transparent via-primary/50 to-transparent"
          style={{ animation: 'clip-scan-line 20s linear infinite' }}
        />
      </div>
      {/* Subtle grid overlay */}
      <div
        className="absolute inset-0 z-30 pointer-events-none"
        style={{
          backgroundImage:
            'linear-gradient(rgba(0, 255, 255, 0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(0, 255, 255, 0.08) 1px, transparent 1px)',
          backgroundSize: '8px 8px',
          animation: 'clip-scan-glow 10s ease-in-out infinite',
        }}
      />
      {/* Status badge - readable contrast */}
      <div className="absolute top-2 right-2 z-40">
        <div className="px-2 py-1 rounded bg-black/70 backdrop-blur-md border border-primary/50 text-[9px] font-mono text-primary font-bold uppercase tracking-wide whitespace-nowrap animate-pulse">
          {badgeText}
        </div>
      </div>
    </>
  );
}
