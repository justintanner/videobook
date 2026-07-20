import { cn } from '@/lib/utils';
import type { MediaItem } from '@/components/sidebar/types';
import { getCardVisualState } from '@/components/sidebar/stateColors';

interface DownloadingReadoutProps {
  asset: MediaItem;
  className?: string;
}

function CloudDownloadIcon({ color }: { color: string }) {
  return (
 <svg viewBox="0 0 32 32" fill="none" className="size-12 ">
      <path
        d="M9 20a5 5 0 0 1-1-9.9A7 7 0 0 1 22 11h.5a4.5 4.5 0 0 1 .5 8.97"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill={`${color}10`}
      />
      <path
        d="M16 16v10m0 0l-4-4m4 4l4-4"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function DownloadingReadout({ asset, className }: DownloadingReadoutProps) {
  const primaryColor = getCardVisualState(asset).color;

  return (
    <div
      className={cn(
 'size-full bg-black font-mono text-xs flex flex-col items-center justify-center relative overflow-hidden select-none',
        className
      )}
    >
      {/* Slow horizontal scan line */}
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

      {/* Content */}
      <div className="relative z-10 flex flex-col items-center gap-3">
        <div className="animate-[readout-breathe_3s_ease-in-out_infinite]">
          <CloudDownloadIcon color={primaryColor} />
        </div>

        <span
          className="text-[10px] font-bold tracking-[0.2em] uppercase"
          style={{ color: primaryColor, opacity: 0.9 }}
        >
          DOWNLOADING
        </span>

        <span className="text-[11px] opacity-40" style={{ color: primaryColor }}>
          {asset.slug}
        </span>

        {asset.origin && (
          <span
            className="text-[10px] opacity-40 max-w-[80%] min-w-0 truncate"
            style={{ color: primaryColor }}
            title={asset.origin}
          >
            {asset.origin}
          </span>
        )}
      </div>
    </div>
  );
}
