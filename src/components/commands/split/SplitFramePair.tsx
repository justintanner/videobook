import { cn } from '@/lib/utils';
import { formatPrecise, formatDurationMS } from './utils';

interface SplitFramePairProps {
  leftUrl: string | null;
  rightUrl: string | null;
  leftSec: number | null;
  rightSec: number | null;
  chunkADur: number;
  chunkBDur: number;
  seeking: boolean;
}

export function SplitFramePair({
  leftUrl,
  rightUrl,
  leftSec,
  rightSec,
  chunkADur,
  chunkBDur,
  seeking,
}: SplitFramePairProps) {
  return (
    <div className="flex-1 min-h-0 grid grid-cols-2 gap-px bg-zinc-800">
      <FramePane
        label="A · ends"
        timeSec={leftSec}
        durationSec={chunkADur}
        url={leftUrl}
        seeking={seeking}
        accent="emerald"
      />
      <FramePane
        label="B · starts"
        timeSec={rightSec}
        durationSec={chunkBDur}
        url={rightUrl}
        seeking={seeking}
        accent="violet"
      />
    </div>
  );
}

interface FramePaneProps {
  label: string;
  timeSec: number | null;
  durationSec: number;
  url: string | null;
  seeking: boolean;
  accent: 'emerald' | 'violet';
}

function FramePane({ label, timeSec, durationSec, url, seeking, accent }: FramePaneProps) {
  const accentText = accent === 'emerald' ? 'text-emerald-400/80' : 'text-violet-400/80';
  const accentBorder = accent === 'emerald' ? 'border-emerald-500/30' : 'border-violet-500/30';

  return (
    <div className="relative flex flex-col bg-black min-w-0">
      <div className={cn('shrink-0 flex items-center justify-between px-4 py-2 border-b bg-zinc-950/90', accentBorder)}>
        <span className={cn('font-mono text-[10px] tracking-[0.2em] uppercase', accentText)}>
          {label}
        </span>
        <div className="flex items-center gap-3 font-mono text-[11px] text-zinc-400">
          {timeSec !== null && <span>{formatPrecise(timeSec)}</span>}
          <span className="text-zinc-600">·</span>
          <span className="text-zinc-300">{formatDurationMS(durationSec)}</span>
        </div>
      </div>
      <div className="flex-1 min-h-0 relative flex items-center justify-center overflow-hidden">
        {url ? (
          <img
            src={url}
            alt={label}
            className={cn(
              'max-w-full max-h-full object-contain transition-opacity duration-150',
              seeking ? 'opacity-70' : 'opacity-100',
            )}
            draggable={false}
          />
        ) : (
          <span className="font-mono text-xs text-zinc-600 uppercase tracking-widest">
            {seeking ? 'extracting…' : 'set split line'}
          </span>
        )}
        {seeking && url && (
          <div className="absolute inset-0 pointer-events-none bg-gradient-to-r from-transparent via-white/5 to-transparent animate-pulse" />
        )}
      </div>
    </div>
  );
}
