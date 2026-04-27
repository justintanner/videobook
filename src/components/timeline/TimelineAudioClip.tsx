import { useCallback } from 'react';
import { cn } from '@/lib/utils';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from '@/components/ui/context-menu';
import { Waveform } from './Waveform';

export interface TimelineAudioClipDragData {
  kind: 'timeline-audio-move';
  audioId: string;
  pointerOffsetFrames: number;
}

interface TimelineAudioClipProps {
  audioId: string;
  slug: string;
  startFrame: number;
  durationFrames: number;
  totalDurationInFrames: number;
  waveform?: number[] | null;
  onRemove: () => void;
}

export function TimelineAudioClip({
  audioId,
  slug,
  startFrame,
  durationFrames,
  totalDurationInFrames,
  waveform,
  onRemove,
}: TimelineAudioClipProps) {
  const leftPct = (startFrame / Math.max(1, totalDurationInFrames)) * 100;
  const widthPct = Math.max(
    0.5,
    (durationFrames / Math.max(1, totalDurationInFrames)) * 100,
  );

  const handleDragStart = useCallback(
    (e: React.DragEvent) => {
      const target = e.currentTarget as HTMLElement;
      const rect = target.getBoundingClientRect();
      const offsetPx = e.clientX - rect.left;
      const pointerOffsetFrames = Math.round(
        (offsetPx / Math.max(1, rect.width)) * durationFrames,
      );
      const payload: TimelineAudioClipDragData = {
        kind: 'timeline-audio-move',
        audioId,
        pointerOffsetFrames,
      };
      e.dataTransfer.setData('application/json', JSON.stringify(payload));
      e.dataTransfer.effectAllowed = 'move';
    },
    [audioId, durationFrames],
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            'absolute top-1 bottom-1 rounded',
            'bg-cyan-500/15 border border-cyan-400/40',
            'hover:border-cyan-300/70 hover:bg-cyan-500/20',
            'cursor-grab active:cursor-grabbing transition-colors',
            'overflow-hidden group',
          )}
          style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
          draggable
          onDragStart={handleDragStart}
        >
          {waveform && waveform.length > 0 && (
            <Waveform
              data={waveform}
              className="absolute inset-x-0 top-1 bottom-1 text-cyan-300"
            />
          )}
          <div className="absolute top-0.5 left-1.5 z-10">
            <span className="text-[9px] font-mono font-bold text-cyan-100/90 truncate block leading-tight drop-shadow-sm">
              @{slug}
            </span>
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onSelect={onRemove}
          className="!flex flex-col !items-stretch gap-1.5 py-3 px-3 border-l-[3px] bg-white/[0.02] border-l-cyan-500/30 focus:!bg-white/[0.12] focus:!text-inherit focus:!border-l-[3px] focus:border-l-cyan-500/60"
        >
          <span className="text-sm font-semibold leading-none text-foreground">Remove audio</span>
          <span className="font-mono text-muted-foreground text-xs tracking-wider leading-none">@{slug}</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
