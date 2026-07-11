import type { RefObject } from 'react';
import { cn } from '@/lib/utils';
import { Play, Pause } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { FOCUS_RING_BUTTON } from '@/components/ui/interaction-states';
import { formatPrecise } from './utils';

interface BoundaryPlayerProps {
  videoRef: RefObject<HTMLVideoElement | null>;
  videoSrc: string;
  boundarySec: number | null;
  duration: number;
  playing: boolean;
  currentTime: number;
  onTogglePlay: () => void;
}

export function BoundaryPlayer({
  videoRef,
  videoSrc,
  boundarySec,
  duration,
  playing,
  currentTime,
  onTogglePlay,
}: BoundaryPlayerProps) {
  return (
    <div className="w-[clamp(180px,18vw,280px)] rounded-md border border-neutral-600/80 bg-neutral-950/95 p-2 shadow-2xl backdrop-blur-sm">
      <div className="relative aspect-video overflow-hidden rounded-sm bg-black flex items-center justify-center">
        <video
          ref={videoRef}
          src={videoSrc || undefined}
          preload="auto"
          playsInline
          className="size-full object-contain"
        />
        {boundarySec === null && (
          <EmptyState size="sm" className="absolute inset-0 flex items-center justify-center">
            No boundary selected
          </EmptyState>
        )}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={onTogglePlay}
          disabled={boundarySec === null}
          aria-label={playing ? 'Pause boundary preview' : 'Play boundary preview'}
          className={cn(
            'size-8 flex items-center justify-center rounded border border-neutral-600/60',
            'text-neutral-300 hover:text-neutral-100 hover:border-neutral-500 hover:bg-neutral-700/40',
            'disabled:opacity-40 disabled:cursor-not-allowed',
            FOCUS_RING_BUTTON,
            'focus-visible:ring-neutral-400/60',
          )}
        >
          {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
        </button>
        <ProgressStrip
          duration={duration}
          currentTime={currentTime}
          boundarySec={boundarySec}
          videoRef={videoRef}
        />
        {boundarySec !== null && (
          <span className="shrink-0 font-mono text-[10px] text-neutral-400">
            {formatPrecise(boundarySec)}
          </span>
        )}
      </div>
    </div>
  )
}

const LOOP_WINDOW = 2;

function ProgressStrip({
  duration,
  currentTime,
  boundarySec,
  videoRef,
}: {
  duration: number;
  currentTime: number;
  boundarySec: number | null;
  videoRef: RefObject<HTMLVideoElement | null>;
}) {
  if (boundarySec === null || duration <= 0) {
    return <div className="flex-1 relative h-2 rounded-full bg-neutral-700/50" />;
  }

  const loopStart = Math.max(0, boundarySec - LOOP_WINDOW);
  const loopEnd = Math.min(duration, boundarySec + LOOP_WINDOW);
  const span = Math.max(0.001, loopEnd - loopStart);
  const pct = Math.max(0, Math.min(100, ((currentTime - loopStart) / span) * 100));
  const boundaryPct = ((boundarySec - loopStart) / span) * 100;

  return (
    <div
      className="flex-1 relative h-2 rounded-full bg-neutral-700/50 cursor-pointer"
      onClick={(e) => {
        const video = videoRef.current;
        if (!video) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const p = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        video.currentTime = loopStart + p * span;
      }}
    >
      <div
        className="absolute inset-y-0 left-0 rounded-full bg-neutral-400/60"
        style={{ width: `${pct}%` }}
      />
      <div
        className="absolute top-0 bottom-0 w-0.5 bg-cyan-300 shadow-[0_0_8px_rgba(34,211,238,0.6)] pointer-events-none -translate-x-1/2"
        style={{ left: `${boundaryPct}%` }}
      />
    </div>
  );
}
