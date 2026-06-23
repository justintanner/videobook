// Presentational chrome shared by the vertical-stack card types. Emerald plan
// domain styling; fixed widths so the GUI↔JSON flip won't reflow the layout.
import { Loader2, AlertTriangle, ImageOff, Code, LayoutGrid } from 'lucide-react';
import { cn } from '@/lib/utils';

export const NODE_W = 240;

// 3D flip between a GUI front and JSON back (reuses the global flip-card CSS).
// Both faces are absolutely positioned, so the container needs an explicit
// height — pass the front's natural height.
export function FlipCard({
  flipped,
  front,
  back,
  height,
}: {
  flipped: boolean;
  front: React.ReactNode;
  back: React.ReactNode;
  height: number;
}) {
  return (
    <div className="flip-card-perspective" style={{ height }}>
      <div className={cn('flip-card-inner relative w-full h-full', flipped && 'flipped')}>
        <div className="flip-card-face absolute inset-0 overflow-hidden">{front}</div>
        <div className="flip-card-back absolute inset-0 overflow-auto">{back}</div>
      </div>
    </div>
  );
}

export function FlipToggle({ flipped, onToggle }: { flipped: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={flipped ? 'Show controls' : 'Show JSON request'}
      className="nodrag shrink-0 p-0.5 rounded text-zinc-500 hover:text-emerald-300 transition-colors"
    >
      {flipped ? <LayoutGrid className="w-3 h-3" /> : <Code className="w-3 h-3" />}
    </button>
  );
}

export type TileLike =
  | { kind: 'idle' }
  | { kind: 'generating'; label?: string }
  | { kind: 'ready'; src: string }
  | { kind: 'error'; message: string };

export function NodeFrame({
  label,
  accent,
  badge,
  children,
  width = NODE_W,
}: {
  label: string;
  accent?: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
  width?: number;
}) {
  return (
    <div
      className={cn(
        'rounded-md border bg-zinc-950/95 shadow-lg shadow-black/40 overflow-hidden',
        accent ?? 'border-zinc-700/70',
      )}
      style={{ width }}
    >
      <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 border-b border-zinc-800/80 bg-black/50">
        <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-emerald-300/80 truncate">
          {label}
        </span>
        {badge}
      </div>
      <div className="p-2">{children}</div>
    </div>
  );
}

// Renders a tile (swap frame / video / source) honouring idle/generating/ready/
// error. `aspectRatio` is a CSS aspect-ratio string (e.g. "16/9").
export function StateThumb({
  tile,
  aspectRatio,
  heightPx,
  idleText = 'not generated',
  alt,
}: {
  tile: TileLike;
  aspectRatio?: string;
  heightPx?: number;
  idleText?: string;
  alt: string;
}) {
  return (
    <div
      className="relative w-full rounded bg-black/60 border border-zinc-800 overflow-hidden flex items-center justify-center"
      style={heightPx != null ? { height: heightPx } : { aspectRatio }}
    >
      {tile.kind === 'ready' && (
        <img src={tile.src} alt={alt} className="w-full h-full object-cover" />
      )}
      {tile.kind === 'generating' && (
        <div className="flex flex-col items-center gap-1 text-emerald-300/70">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="text-[9px] font-mono">{tile.label ?? 'generating…'}</span>
        </div>
      )}
      {tile.kind === 'error' && (
        <div className="flex flex-col items-center gap-1 text-rose-300/80 px-2 text-center">
          <AlertTriangle className="w-4 h-4" />
          <span className="text-[9px] font-mono line-clamp-2">{tile.message}</span>
        </div>
      )}
      {tile.kind === 'idle' && (
        <div className="flex flex-col items-center gap-1 text-zinc-600">
          <ImageOff className="w-4 h-4" />
          <span className="text-[9px] font-mono">{idleText}</span>
        </div>
      )}
    </div>
  );
}
