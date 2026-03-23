import { cn } from '@/lib/utils';
import type { MediaItem } from '@/components/sidebar/types';

interface RenderingReadoutProps {
  asset: MediaItem;
  className?: string;
}

function getBadgeText(status: string | undefined): string {
  if (status === 'rendering-landscape') return 'RENDERING LANDSCAPE';
  if (status === 'rendering-portrait') return 'RENDERING PORTRAIT';
  if (status === 'rendering-square') return 'RENDERING SQUARE';
  if (status === 'render-queued') return 'QUEUED';
  if (status === 'render-queued-landscape') return 'QUEUED LANDSCAPE';
  if (status === 'render-queued-portrait') return 'QUEUED PORTRAIT';
  if (status === 'render-queued-square') return 'QUEUED SQUARE';
  return 'RENDERING';
}

function isQueued(status: string | undefined): boolean {
  return status?.startsWith('render-queued') ?? false;
}

function RenderIcon({ isFinal, color }: { isFinal: boolean; color: string }) {
  if (isFinal) {
    // Clapperboard — angular, bold strokes
    return (
      <svg viewBox="0 0 32 32" fill="none" className="w-10 h-10">
        <path d="M4 10L28 10L28 28L4 28Z" stroke={color} strokeWidth="1.5" fill={`${color}08`} />
        <path d="M4 10L8 4L28 4L28 10" stroke={color} strokeWidth="1.5" fill={`${color}10`} />
        <path d="M10 4L12 10M16 4L18 10M22 4L24 10" stroke={color} strokeWidth="1" opacity="0.5" />
        <rect x="8" y="15" width="16" height="2" rx="0.5" fill={color} opacity="0.3" />
        <rect x="10" y="20" width="12" height="1.5" rx="0.5" fill={color} opacity="0.15" />
      </svg>
    );
  }
  // Film reel — concentric rings
  return (
    <svg viewBox="0 0 32 32" fill="none" className="w-10 h-10">
      <circle cx="16" cy="16" r="12" stroke={color} strokeWidth="1.5" fill={`${color}08`} />
      <circle cx="16" cy="16" r="4" stroke={color} strokeWidth="1" opacity="0.6" />
      <circle cx="16" cy="16" r="1.5" fill={color} opacity="0.4" />
      <circle cx="16" cy="8" r="1.5" fill={color} opacity="0.3" />
      <circle cx="16" cy="24" r="1.5" fill={color} opacity="0.3" />
      <circle cx="8" cy="16" r="1.5" fill={color} opacity="0.3" />
      <circle cx="24" cy="16" r="1.5" fill={color} opacity="0.3" />
    </svg>
  );
}

export function RenderingReadout({ asset, className }: RenderingReadoutProps) {
  const badgeText = getBadgeText(asset.status);
  const isFinal = asset.type === 'final';
  const queued = isQueued(asset.status);
  const primaryColor = isFinal ? '#fbbf24' : 'var(--color-primary)';

  return (
    <div
      className={cn(
        'w-full h-full bg-black font-mono text-xs flex flex-col items-center justify-center relative overflow-hidden select-none',
        className
      )}
    >
      {/* Slow horizontal scan line */}
      {!queued && (
        <div className="absolute inset-0 pointer-events-none overflow-hidden">
          <div
            className="absolute left-0 right-0 h-px opacity-40"
            style={{
              backgroundColor: primaryColor,
              boxShadow: `0 0 8px 1px ${primaryColor}`,
              animation: 'readout-scan 4s ease-in-out infinite',
            }}
          />
        </div>
      )}

      {/* Content */}
      <div className="relative z-10 flex flex-col items-center gap-3">
        <div className={cn(!queued && 'animate-[readout-breathe_3s_ease-in-out_infinite]')}>
          <RenderIcon isFinal={isFinal} color={primaryColor} />
        </div>

        <span
          className="text-[10px] font-bold tracking-[0.2em] uppercase"
          style={{ color: primaryColor, opacity: queued ? 0.5 : 0.9 }}
        >
          {badgeText}
        </span>

        <span className="text-[11px] opacity-40" style={{ color: primaryColor }}>
          {asset.slug}
        </span>
      </div>

    </div>
  );
}
