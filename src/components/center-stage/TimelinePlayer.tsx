import { useEffect, useRef } from 'react';
import { Player, type PlayerRef } from '@remotion/player';
import { TimelineComposition } from '@/remotion/TimelineComposition';
import type { TimelineSlotData } from '@/remotion/TimelineComposition';
import { Monitor, Smartphone, Square, Film } from 'lucide-react';

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
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function OrientationIcon({ w, h }: { w: number; h: number }) {
  const cls = "w-3 h-3 text-primary/60";
  if (h > w) return <Smartphone className={cls} />;
  if (w === h) return <Square className={cls} />;
  return <Monitor className={cls} />;
}

function TimelinePlayerHeader({ previewData }: { previewData: TimelinePreviewData }) {
  const { compositionWidth: w, compositionHeight: h, slots, totalDurationInFrames, fps } = previewData;
  const totalSeconds = fps > 0 ? totalDurationInFrames / fps : 0;

  return (
    <div className="shrink-0 px-3 py-2 bg-black/80 backdrop-blur-sm border-b border-primary/20 flex items-center justify-between relative">
      {/* Left: orientation badge chip */}
      <div className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-primary/10 border border-primary/20">
        <OrientationIcon w={w} h={h} />
        <span className="text-[11px] font-mono font-bold text-primary/70 tabular-nums">{w}&times;{h}</span>
      </div>

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

export function TimelinePlayer({ previewData, initialSlotIndex, onFrameUpdate }: TimelinePlayerProps) {
  const playerRef = useRef<PlayerRef>(null);

  // Seek to the requested slot on mount or when initialSlotIndex changes
  useEffect(() => {
    if (!playerRef.current || !previewData.ready) return;
    const offset = initialSlotIndex != null ? previewData.slotOffsets[initialSlotIndex] ?? 0 : 0;
    playerRef.current.seekTo(offset);
  }, [initialSlotIndex, previewData.ready, previewData.slotOffsets]);

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

  if (!previewData.ready) {
    return (
      <div className="flex-1 flex flex-col overflow-hidden">
        <TimelinePlayerHeader previewData={previewData} />
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
      <TimelinePlayerHeader previewData={previewData} />
      <div className="flex-1 flex items-center justify-center overflow-hidden">
        <Player
          ref={playerRef}
          component={TimelineComposition}
          inputProps={{ slots: previewData.slots }}
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
