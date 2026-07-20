import { useEffect, useMemo, useRef } from 'react';
import { Player, type PlayerRef } from '@remotion/player';
import { TimelineComposition } from '@/remotion/TimelineComposition';
import type { TimelineSlotData, TimelineAudioOverlayData } from '@/remotion/TimelineComposition';
import { Film } from 'lucide-react';
import type { Orientation } from '@/hooks/useTimeline';
import type { ViewerSize } from '@/components/center-stage/viewer-types';
import { RatioToggle } from '@/components/center-stage/viewer-shared';

export interface TimelinePreviewData {
  slots: TimelineSlotData[];
  audioClips: TimelineAudioOverlayData[];
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

function orientFromDimensions(w: number, h: number): ViewerSize {
  if (h > w) return 'portrait';
  if (w === h) return 'square';
  return 'landscape';
}

const timelineSizes: ViewerSize[] = ['landscape', 'portrait', 'square'];

function TimelinePlayerHeader({ previewData, onOrientationChange }: { previewData: TimelinePreviewData; onOrientationChange?: (orient: Orientation) => void }) {
  const { compositionWidth: w, compositionHeight: h, slots, totalDurationInFrames, fps } = previewData;
  const totalSeconds = fps > 0 ? totalDurationInFrames / fps : 0;
  const active = orientFromDimensions(w, h);

  return (
    <div className="shrink-0 px-3 py-2.5 bg-black/60 border-b border-zinc-800/60 flex items-center justify-between relative">
      {onOrientationChange ? (
        <RatioToggle
          active={active}
          onSelect={(s) => onOrientationChange(s as Orientation)}
          sizes={timelineSizes}
        />
      ) : (
        <span className="text-[11px] font-mono font-bold text-violet-300/70 tabular-nums">{w}&times;{h}</span>
      )}

      {/* Center label */}
      <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <span className="font-mono text-[11px] font-bold tracking-widest uppercase text-violet-300/40">
          TIMELINE &middot; {slots.length} SLOT{slots.length !== 1 ? 'S' : ''}
        </span>
      </span>

      {/* Right: duration readout */}
      <div className="flex items-center gap-1.5">
 <Film className="size-3.5 text-violet-300/30" />
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
  useEffect(() => {
    slotOffsetsRef.current = previewData.slotOffsets;
  }, [previewData.slotOffsets]);

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

  const inputProps = useMemo(
    () => ({ slots: previewData.slots, audioClips: previewData.audioClips }),
    [previewData.slots, previewData.audioClips],
  );

  if (!previewData.ready) {
    return (
      <div className="flex-1 flex items-center justify-center overflow-hidden">
 <div className="size-full flex flex-col overflow-hidden border border-zinc-600/50">
          <TimelinePlayerHeader previewData={previewData} onOrientationChange={onOrientationChange} />
          <div className="flex-1 flex items-center justify-center bg-black">
            <span className="text-sm font-mono text-muted-foreground/50">
              No rendered clips for this orientation
            </span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex items-center justify-center overflow-hidden">
 <div className="size-full flex flex-col overflow-hidden border border-zinc-600/50">
        <TimelinePlayerHeader previewData={previewData} onOrientationChange={onOrientationChange} />
        <div className="flex-1 flex items-center justify-center overflow-hidden bg-black">
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
    </div>
  );
}
