import { cn } from '@/lib/utils';
import { Film, Clapperboard } from 'lucide-react';
import type { MediaItem } from '@/components/sidebar/types';

interface RenderingReadoutProps {
  asset: MediaItem;
  className?: string;
}

function getBadgeText(status: string | undefined): string {
  if (status === 'rendering-landscape') return 'RENDERING LANDSCAPE';
  if (status === 'rendering-portrait') return 'RENDERING PORTRAIT';
  if (status === 'render-queued') return 'QUEUED';
  if (status === 'render-queued-landscape') return 'QUEUED LANDSCAPE';
  if (status === 'render-queued-portrait') return 'QUEUED PORTRAIT';
  return 'RENDERING';
}

export function RenderingReadout({ asset, className }: RenderingReadoutProps) {
  const badgeText = getBadgeText(asset.status);
  const isFinal = asset.type === 'final';
  const primaryColor = isFinal ? '#fbbf24' : 'var(--color-primary)';

  return (
    <div
      className={cn(
        'w-full h-full bg-black font-mono text-xs flex flex-col items-center justify-center relative overflow-hidden',
        isFinal ? 'border border-amber-500/30' : 'border border-primary/30',
        className
      )}
    >
      {/* Scanning line animation */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div
          className="absolute inset-y-0 w-24 opacity-30"
          style={{
            background: `linear-gradient(to right, transparent, ${primaryColor}, transparent)`,
            animation: 'clip-scan-line 3s linear infinite',
          }}
        />
      </div>

      {/* Grid overlay */}
      <div
        className="absolute inset-0 pointer-events-none opacity-20"
        style={{
          backgroundImage: `
            linear-gradient(${primaryColor}40 1px, transparent 1px),
            linear-gradient(90deg, ${primaryColor}40 1px, transparent 1px)
          `,
          backgroundSize: '12px 12px',
        }}
      />

      {/* Center content */}
      <div className="relative z-10 flex flex-col items-center gap-2">
        {isFinal ? (
          <Clapperboard className="w-8 h-8 animate-pulse" style={{ color: primaryColor }} />
        ) : (
          <Film className="w-8 h-8 animate-pulse" style={{ color: primaryColor }} />
        )}

        <div
          className="px-2.5 py-1 rounded border text-[10px] font-bold tracking-wider animate-pulse"
          style={{
            color: primaryColor,
            borderColor: `${primaryColor}60`,
            backgroundColor: `${primaryColor}15`,
            textShadow: `0 0 8px ${primaryColor}`,
          }}
        >
          {badgeText}
        </div>

        <div className="text-xs opacity-60" style={{ color: primaryColor }}>
          {asset.slug}
        </div>
      </div>

      {/* Corner decorations */}
      <div
        className="absolute top-2 left-2 w-5 h-5 border-l-2 border-t-2 opacity-40"
        style={{ borderColor: primaryColor }}
      />
      <div
        className="absolute top-2 right-2 w-5 h-5 border-r-2 border-t-2 opacity-40"
        style={{ borderColor: primaryColor }}
      />
      <div
        className="absolute bottom-2 left-2 w-5 h-5 border-l-2 border-b-2 opacity-40"
        style={{ borderColor: primaryColor }}
      />
      <div
        className="absolute bottom-2 right-2 w-5 h-5 border-r-2 border-b-2 opacity-40"
        style={{ borderColor: primaryColor }}
      />
    </div>
  );
}
