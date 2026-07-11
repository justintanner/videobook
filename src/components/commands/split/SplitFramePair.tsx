import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { formatPrecise, formatDurationMS } from './utils'

interface SplitFramePairProps {
  leftUrl: string | null;
  rightUrl: string | null;
  leftSec: number | null;
  rightSec: number | null;
  chunkADur: number;
  chunkBDur: number;
  seeking: boolean;
  leftLabel?: string
  rightLabel?: string
  overlay?: ReactNode
}

export function SplitFramePair({
  leftUrl,
  rightUrl,
  leftSec,
  rightSec,
  chunkADur,
  chunkBDur,
  seeking,
  leftLabel = 'A · last frame',
  rightLabel = 'B · first frame',
  overlay,
}: SplitFramePairProps) {
  return (
    <div className="relative flex-1 min-h-0 grid grid-cols-2 gap-px overflow-hidden rounded-md border border-neutral-700/60 bg-neutral-700">
      <FramePane
        label={leftLabel}
        timeSec={leftSec}
        durationSec={chunkADur}
        url={leftUrl}
        seeking={seeking}
      />
      <FramePane
        label={rightLabel}
        timeSec={rightSec}
        durationSec={chunkBDur}
        url={rightUrl}
        seeking={seeking}
      />
      {overlay && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="pointer-events-auto">{overlay}</div>
        </div>
      )}
    </div>
  )
}

interface FramePaneProps {
  label: string;
  timeSec: number | null;
  durationSec: number;
  url: string | null;
  seeking: boolean;
}

function FramePane({ label, timeSec, durationSec, url, seeking }: FramePaneProps) {
  return (
    <div className="relative flex flex-col bg-black min-w-0">
      <div className="shrink-0 flex items-center justify-between px-4 py-2 border-b border-neutral-700/60 bg-neutral-950/95">
        <span className="font-mono text-[10px] tracking-[0.2em] uppercase text-neutral-300">
          {label}
        </span>
        <div className="flex items-center gap-3 font-mono text-[11px] text-neutral-400">
          {timeSec !== null && <span>{formatPrecise(timeSec)}</span>}
          <span className="text-neutral-600">·</span>
          <span className="text-neutral-300">{formatDurationMS(durationSec)}</span>
        </div>
      </div>
      <div className="flex-1 min-h-0 relative flex items-center justify-center overflow-hidden">
        {url ? (
          <img
            src={url}
            alt={label}
            className={cn(
              'size-full object-contain transition-opacity duration-150',
              seeking ? 'opacity-70' : 'opacity-100',
            )}
            draggable={false}
          />
        ) : (
          <span className="font-mono text-xs text-neutral-600 uppercase tracking-widest">
            {seeking ? 'extracting…' : 'set split line'}
          </span>
        )}
        {seeking && url && (
          <div className="absolute inset-0 pointer-events-none bg-gradient-to-r from-transparent via-white/5 to-transparent animate-pulse" />
        )}
      </div>
    </div>
  )
}
