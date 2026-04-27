import { useCallback, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import type { MediaItem } from '@/components/sidebar/types';
import type { TimelineAudioClip as TimelineAudioClipModel } from '@/hooks/useTimeline';
import { TimelineAudioClip, type TimelineAudioClipDragData } from './TimelineAudioClip';

const FPS = 30;
const SNAP_THRESHOLD_PX = 30;

interface DropPreview {
  startFrame: number;
  snapped: boolean;
}

interface TimelineAudioLaneProps {
  audioClips: TimelineAudioClipModel[];
  mediaItems: MediaItem[];
  slotOffsets: number[];
  totalDurationInFrames: number;
  onAdd: (assetId: string, startFrame: number, durationFrames?: number) => void;
  onMove: (audioId: string, startFrame: number) => void;
  onRemove: (audioId: string) => void;
}

interface IncomingAssetDrag {
  id?: string;
  type?: string;
}

function isMoveDrag(data: unknown): data is TimelineAudioClipDragData {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { kind?: unknown }).kind === 'timeline-audio-move'
  );
}

function snapFrame(
  frame: number,
  snapPoints: number[],
  pxPerFrame: number,
  bypass: boolean,
): { startFrame: number; snapped: boolean } {
  if (bypass || pxPerFrame <= 0) {
    return { startFrame: Math.max(0, Math.round(frame)), snapped: false };
  }
  const thresholdFrames = SNAP_THRESHOLD_PX / pxPerFrame;
  let best = snapPoints[0];
  let bestDist = Math.abs(frame - best);
  for (const point of snapPoints) {
    const dist = Math.abs(frame - point);
    if (dist < bestDist) {
      best = point;
      bestDist = dist;
    }
  }
  if (bestDist <= thresholdFrames) {
    return { startFrame: Math.max(0, Math.round(best)), snapped: true };
  }
  return { startFrame: Math.max(0, Math.round(frame)), snapped: false };
}

export function TimelineAudioLane({
  audioClips,
  mediaItems,
  slotOffsets,
  totalDurationInFrames,
  onAdd,
  onMove,
  onRemove,
}: TimelineAudioLaneProps) {
  const laneRef = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<DropPreview | null>(null);

  const computePreview = useCallback(
    (e: React.DragEvent): DropPreview | null => {
      const lane = laneRef.current;
      if (!lane) return null;
      const rect = lane.getBoundingClientRect();
      if (rect.width <= 0) return null;
      const x = e.clientX - rect.left;
      const pxPerFrame = rect.width / Math.max(1, totalDurationInFrames);
      const rawFrame = (x / rect.width) * totalDurationInFrames;
      const bypass = e.altKey || e.shiftKey;

      let pointerOffsetFrames = 0;
      try {
        const raw = e.dataTransfer.getData('application/json');
        if (raw) {
          const parsed = JSON.parse(raw);
          if (isMoveDrag(parsed)) {
            pointerOffsetFrames = parsed.pointerOffsetFrames;
          }
        }
      } catch {
        // ignore — Firefox blocks getData on dragOver; fall through to no offset
      }

      const snapPoints = [0, ...slotOffsets, totalDurationInFrames];
      const { startFrame, snapped } = snapFrame(
        rawFrame - pointerOffsetFrames,
        snapPoints,
        pxPerFrame,
        bypass,
      );
      return { startFrame, snapped };
    },
    [slotOffsets, totalDurationInFrames],
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      const next = computePreview(e);
      if (next) setPreview(next);
    },
    [computePreview],
  );

  const handleDragLeave = useCallback(() => {
    setPreview(null);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setPreview(null);
      let parsed: unknown;
      try {
        parsed = JSON.parse(e.dataTransfer.getData('application/json'));
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== 'object') return;

      const lane = laneRef.current;
      if (!lane) return;
      const rect = lane.getBoundingClientRect();
      if (rect.width <= 0) return;
      const pxPerFrame = rect.width / Math.max(1, totalDurationInFrames);
      const x = e.clientX - rect.left;
      const rawFrame = (x / rect.width) * totalDurationInFrames;
      const bypass = e.altKey || e.shiftKey;
      const snapPoints = [0, ...slotOffsets, totalDurationInFrames];

      if (isMoveDrag(parsed)) {
        const { startFrame } = snapFrame(
          rawFrame - parsed.pointerOffsetFrames,
          snapPoints,
          pxPerFrame,
          bypass,
        );
        onMove(parsed.audioId, startFrame);
        return;
      }

      const dragged = parsed as IncomingAssetDrag;
      if (!dragged.id || dragged.type !== 'audio') return;
      const item = mediaItems.find((m) => m.id === dragged.id);
      const seconds = item?.duration ?? item?.durationSeconds ?? 0;
      const durationFrames = seconds > 0 ? Math.max(1, Math.round(seconds * FPS)) : undefined;
      const { startFrame } = snapFrame(rawFrame, snapPoints, pxPerFrame, bypass);
      onAdd(dragged.id, startFrame, durationFrames);
    },
    [mediaItems, onAdd, onMove, slotOffsets, totalDurationInFrames],
  );

  const indicatorLeftPct =
    preview != null
      ? (preview.startFrame / Math.max(1, totalDurationInFrames)) * 100
      : null;

  return (
    <div className="relative h-12 border-t border-border/30 bg-card/10 mx-1">
      <div
        ref={laneRef}
        className={cn(
          'absolute inset-0 rounded',
          preview ? 'bg-primary/5 ring-1 ring-primary/30' : 'hover:bg-white/[0.02]',
        )}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className="absolute left-1.5 top-0.5 z-0">
          <span className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground/30 select-none">
            audio
          </span>
        </div>
        {audioClips.map((clip) => {
          const item = mediaItems.find((m) => m.id === clip.slug);
          return (
            <TimelineAudioClip
              key={clip.id}
              audioId={clip.id}
              slug={clip.slug}
              startFrame={clip.startFrame}
              durationFrames={clip.durationFrames}
              totalDurationInFrames={totalDurationInFrames}
              waveform={item?.waveform ?? null}
              onRemove={() => onRemove(clip.id)}
            />
          );
        })}
        {indicatorLeftPct != null && (
          <div
            className="absolute top-0 bottom-0 w-px pointer-events-none z-30"
            style={{ left: `${indicatorLeftPct}%` }}
          >
            <div
              className={cn(
                'w-full h-full',
                preview?.snapped
                  ? 'bg-primary shadow-[0_0_10px_var(--color-primary),0_0_18px_var(--color-primary)]'
                  : 'bg-primary/60',
              )}
            />
          </div>
        )}
      </div>
    </div>
  );
}
