import { useEffect, useMemo, useRef } from 'react';
import { Player, type PlayerRef } from '@remotion/player';
import { TimelineComposition } from '@/remotion/TimelineComposition';
import type { TimelineSlotData } from '@/remotion/TimelineComposition';
import { Monitor, Smartphone, Square, Film, Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import type { Orientation } from '@/hooks/useTimeline';

export interface TimelinePreviewData {
  slots: TimelineSlotData[];
  totalDurationInFrames: number;
  fps: number;
  compositionWidth: number;
  compositionHeight: number;
  slotOffsets: number[];
  ready: boolean;
}

interface TimelinePlayerProps {
  previewData: TimelinePreviewData;
  initialSlotIndex?: number;
  onFrameUpdate?: (frame: number) => void;
  onOrientationChange?: (orient: Orientation) => void;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function OrientationIcon({ w, h, className: cls }: { w: number; h: number; className?: string }) {
  const c = cls ?? "w-3 h-3 text-primary/60";
  if (h > w) return <Smartphone className={c} />;
  if (w === h) return <Square className={c} />;
  return <Monitor className={c} />;
}

function orientFromDimensions(w: number, h: number): Orientation {
  if (h > w) return 'portrait';
  if (w === h) return 'square';
  return 'landscape';
}

const orientationOptions: { orient: Orientation; label: string; dims: string; w: number; h: number }[] = [
  { orient: 'landscape', label: '/landscape', dims: '1920×1080', w: 1920, h: 1080 },
  { orient: 'portrait', label: '/portrait', dims: '1080×1920', w: 1080, h: 1920 },
  { orient: 'square', label: '/square', dims: '1080×1080', w: 1080, h: 1080 },
];

function TimelinePlayerHeader({ previewData, onOrientationChange }: { previewData: TimelinePreviewData; onOrientationChange?: (orient: Orientation) => void }) {
  const { compositionWidth: w, compositionHeight: h, slots, totalDurationInFrames, fps } = previewData;
  const totalSeconds = fps > 0 ? totalDurationInFrames / fps : 0;
  const activeOrient = orientFromDimensions(w, h);

  const badge = (
    <div className={cn(
      'flex items-center gap-1.5 px-2 py-0.5 rounded bg-primary/10 border border-primary/20',
      onOrientationChange && 'cursor-pointer hover:bg-primary/20 transition-colors',
    )}>
      <OrientationIcon w={w} h={h} />
      <span className="text-[11px] font-mono font-bold text-primary/70 tabular-nums">{w}&times;{h}</span>
      {onOrientationChange && <ChevronDown className="w-3 h-3 text-primary/40" />}
    </div>
  );

  return (
    <div className="shrink-0 px-3 py-2 bg-black/80 backdrop-blur-sm border-b border-primary/20 flex items-center justify-between relative">
      {/* Left: orientation badge — dropdown when handler provided, static otherwise */}
      {onOrientationChange ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button tabIndex={-1}>{badge}</button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {orientationOptions.map((opt) => {
              const isActive = opt.orient === activeOrient;
              return (
                <DropdownMenuItem key={opt.orient} onClick={() => onOrientationChange(opt.orient)} className="py-2.5">
                  <span className="font-mono text-muted-foreground/50 text-sm leading-none select-none mr-1">
                    {isActive ? <Check className="w-3 h-3 inline text-primary" /> : '\u203A'}
                  </span>
                  <span className={cn('font-mono font-bold text-xs tracking-wider leading-none flex-1', !isActive && 'text-muted-foreground/60')}>
                    {opt.label} {opt.dims}
                  </span>
                  <span className={cn('ml-2 flex items-center', !isActive && 'opacity-40')}>
                    <OrientationIcon w={opt.w} h={opt.h} className="h-3 w-3" />
                  </span>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : badge}

      {/* Center label */}
      <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <span className="font-mono text-[11px] font-bold tracking-widest uppercase text-primary/40">
          TIMELINE &middot; {slots.length} SLOT{slots.length !== 1 ? 'S' : ''}
        </span>
      </span>

      {/* Right: duration readout */}
      <div className="flex items-center gap-1.5">
        <Film className="w-3.5 h-3.5 text-primary/30" />
        <span className="text-[11px] font-mono tabular-nums text-muted-foreground/60">{formatTime(totalSeconds)}</span>
      </div>
    </div>
  );
}

export function TimelinePlayer({ previewData, initialSlotIndex, onFrameUpdate, onOrientationChange }: TimelinePlayerProps) {
  const playerRef = useRef<PlayerRef>(null);

  // Keep slotOffsets in a ref so the seek effect doesn't re-fire when
  // the array reference changes (happens every sync cycle).
  const slotOffsetsRef = useRef(previewData.slotOffsets);
  slotOffsetsRef.current = previewData.slotOffsets;

  // Seek to the requested slot on mount or when initialSlotIndex changes
  useEffect(() => {
    if (!playerRef.current || !previewData.ready) return;
    const offset = initialSlotIndex != null ? slotOffsetsRef.current[initialSlotIndex] ?? 0 : 0;
    playerRef.current.seekTo(offset);
  }, [initialSlotIndex, previewData.ready]);

  // Subscribe to frame updates
  useEffect(() => {
    if (!playerRef.current || !onFrameUpdate) return;
    const player = playerRef.current;
    const handler = (e: { detail: { frame: number } }) => {
      onFrameUpdate(e.detail.frame);
    };
    player.addEventListener('frameupdate', handler);
    return () => player.removeEventListener('frameupdate', handler);
  }, [onFrameUpdate]);

  const inputProps = useMemo(() => ({ slots: previewData.slots }), [previewData.slots]);

  if (!previewData.ready) {
    return (
      <div className="flex-1 flex flex-col overflow-hidden">
        <TimelinePlayerHeader previewData={previewData} onOrientationChange={onOrientationChange} />
        <div className="flex-1 flex items-center justify-center">
          <span className="text-sm font-mono text-muted-foreground/50">
            No rendered clips for this orientation
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <TimelinePlayerHeader previewData={previewData} onOrientationChange={onOrientationChange} />
      <div className="flex-1 flex items-center justify-center overflow-hidden">
        <Player
          ref={playerRef}
          component={TimelineComposition}
          inputProps={inputProps}
          durationInFrames={previewData.totalDurationInFrames}
          fps={previewData.fps}
          compositionWidth={previewData.compositionWidth}
          compositionHeight={previewData.compositionHeight}
          style={{
            width: '100%',
            maxHeight: '100%',
          }}
          controls
        />
      </div>
    </div>
  );
}
