import { useEffect, useRef } from 'react';
import { Player, type PlayerRef } from '@remotion/player';
import { TimelineComposition } from '@/remotion/TimelineComposition';
import type { TimelineSlotData } from '@/remotion/TimelineComposition';

interface TimelinePreviewData {
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
      <div className="flex-1 flex items-center justify-center">
        <span className="text-sm font-mono text-muted-foreground/50">
          No rendered clips for this orientation
        </span>
      </div>
    );
  }

  return (
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
  );
}
