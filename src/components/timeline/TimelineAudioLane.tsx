import { useCallback, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import type { MediaItem } from '@/components/sidebar/types';
import type { TimelineAudioClip as TimelineAudioClipModel } from '@/hooks/useTimeline';
import { TimelineAudioClip, type TimelineAudioClipDragData } from './TimelineAudioClip';

const FPS = 30;
const SNAP_THRESHOLD_PX = 30;

export interface SlotBoundary {
  leftPct: number;
  frame: number;
}

interface DropPreview {
  startFrame: number;
  leftPct: number;
  snapped: boolean;
}

interface TimelineAudioLaneProps {
  audioClips: TimelineAudioClipModel[];
  mediaItems: MediaItem[];
  slotBoundaries: SlotBoundary[];
  totalDurationInFrames: number;
  onAdd: (assetId: string, startFrame: number, durationFrames?: number) => void;
  onMove: (audioId: string, startFrame: number) => void;
  onRemove: (audioId: string) => void;
  onUpdate: (audioId: string, fields: { volume?: number; fadeIn?: number; fadeOut?: number }) => void;
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

function resolveDrop(
  xPct: number,
  laneWidthPx: number,
  totalDurationInFrames: number,
  boundaries: SlotBoundary[],
  bypass: boolean,
): { startFrame: number; leftPct: number; snapped: boolean } {
  const clampPct = Math.max(0, Math.min(100, xPct));
  if (bypass || laneWidthPx <= 0 || boundaries.length === 0) {
    const startFrame = Math.max(
      0,
      Math.round((clampPct / 100) * totalDurationInFrames),
    );
    return { startFrame, leftPct: clampPct, snapped: false };
  }
  const thresholdPct = (SNAP_THRESHOLD_PX / laneWidthPx) * 100;
  let best = boundaries[0];
  let bestDist = Math.abs(clampPct - best.leftPct);
  for (const b of boundaries) {
    const d = Math.abs(clampPct - b.leftPct);
    if (d < bestDist) { best = b; bestDist = d; }
  }
  if (bestDist <= thresholdPct) {
    return { startFrame: Math.max(0, Math.round(best.frame)), leftPct: best.leftPct, snapped: true };
  }
  const startFrame = Math.max(
    0,
    Math.round((clampPct / 100) * totalDurationInFrames),
  );
  return { startFrame, leftPct: clampPct, snapped: false };
}

export function TimelineAudioLane({
  audioClips,
  mediaItems,
  slotBoundaries,
  totalDurationInFrames,
  onAdd,
  onMove,
  onRemove,
  onUpdate,
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
      const bypass = e.altKey || e.shiftKey;

      let pointerOffsetPx = 0;
      try {
        const raw = e.dataTransfer.getData('application/json');
        if (raw) {
          const parsed = JSON.parse(raw);
          if (isMoveDrag(parsed)) {
            // pointerOffsetFrames was recorded as frames-from-clip-left at drag start
            pointerOffsetPx = (parsed.pointerOffsetFrames / Math.max(1, totalDurationInFrames)) * rect.width;
          }
        }
      } catch {
        // ignore — Firefox blocks getData on dragOver; fall through to no offset
      }

      const cursorPct = ((x - pointerOffsetPx) / rect.width) * 100;
      const { startFrame, leftPct, snapped } = resolveDrop(
        cursorPct,
        rect.width,
        totalDurationInFrames,
        slotBoundaries,
        bypass,
      );
      return { startFrame, leftPct, snapped };
    },
    [slotBoundaries, totalDurationInFrames],
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      // Match the source's effectAllowed: chip drags use 'move', sidebar uses
      // 'copy'. Mismatched dropEffect makes the browser reject the drop.
      e.dataTransfer.dropEffect = e.dataTransfer.effectAllowed === 'move' ? 'move' : 'copy';
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
      const x = e.clientX - rect.left;
      const bypass = e.altKey || e.shiftKey;

      if (isMoveDrag(parsed)) {
        const offsetPx = (parsed.pointerOffsetFrames / Math.max(1, totalDurationInFrames)) * rect.width;
        const cursorPct = ((x - offsetPx) / rect.width) * 100;
        const { startFrame } = resolveDrop(cursorPct, rect.width, totalDurationInFrames, slotBoundaries, bypass);
        onMove(parsed.audioId, startFrame);
        return;
      }

      const dragged = parsed as IncomingAssetDrag;
      if (!dragged.id || dragged.type !== 'audio') return;
      const item = mediaItems.find((m) => m.id === dragged.id);
      const seconds = item?.duration ?? 0;
      const durationFrames = seconds > 0 ? Math.max(1, Math.round(seconds * FPS)) : undefined;
      const cursorPct = (x / rect.width) * 100;
      const { startFrame } = resolveDrop(cursorPct, rect.width, totalDurationInFrames, slotBoundaries, bypass);
      onAdd(dragged.id, startFrame, durationFrames);
    },
    [mediaItems, onAdd, onMove, slotBoundaries, totalDurationInFrames],
  );

  const indicatorLeftPct = preview?.leftPct ?? null;

  return (
    <div className="relative h-12 border-t border-border/30 bg-card/10 mx-1">
      <div
        ref={laneRef}
        className={cn(
          'absolute inset-0 rounded',
          preview ? 'bg-violet-500/5 ring-1 ring-violet-500/30' : 'hover:bg-white/[0.02]',
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
              volume={clip.volume ?? 100}
              fadeIn={clip.fadeIn ?? 0}
              fadeOut={clip.fadeOut ?? 0}
              onRemove={() => onRemove(clip.id)}
              onUpdate={(fields) => onUpdate(clip.id, fields)}
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
 'size-full ',
                preview?.snapped
                  ? 'bg-violet-500 shadow-[0_0_10px_var(--clip-domain-video),0_0_18px_var(--clip-domain-video)]'
                  : 'bg-violet-500/60',
              )}
            />
          </div>
        )}
      </div>
    </div>
  );
}
