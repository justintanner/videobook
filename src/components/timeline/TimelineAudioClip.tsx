import { useCallback } from 'react';
import { cn } from '@/lib/utils';
import { Volume2, X } from 'lucide-react';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from '@/components/ui/context-menu';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
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
  volume: number;
  fadeIn: number;
  fadeOut: number;
  onRemove: () => void;
  onUpdate: (fields: { volume?: number; fadeIn?: number; fadeOut?: number }) => void;
}

function stopAll(e: React.SyntheticEvent) {
  e.stopPropagation();
}

interface SliderRowProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (v: number) => void;
}

function SliderRow({ label, value, min, max, step, unit, onChange }: SliderRowProps) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-[10px] font-mono uppercase tracking-widest text-muted-foreground/70">
        <span>{label}</span>
        <span className="tabular-nums text-cyan-200/90">{value}{unit}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-cyan-400"
      />
    </div>
  );
}

export function TimelineAudioClip({
  audioId,
  slug,
  startFrame,
  durationFrames,
  totalDurationInFrames,
  waveform,
  volume,
  fadeIn,
  fadeOut,
  onRemove,
  onUpdate,
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
          <div
            className="absolute top-0.5 right-0.5 z-20 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
            onPointerDown={stopAll}
            onMouseDown={stopAll}
          >
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  draggable={false}
                  onDragStart={(e) => e.preventDefault()}
                  className="w-4 h-4 flex items-center justify-center rounded bg-black/40 text-cyan-100 hover:bg-black/60 hover:text-white"
                  aria-label="Audio settings"
                >
                  <Volume2 className="w-3 h-3" />
                </button>
              </PopoverTrigger>
              <PopoverContent
                className="w-64 p-3 bg-card/95 border-cyan-500/30 backdrop-blur-md"
                onPointerDown={stopAll}
                onMouseDown={stopAll}
              >
                <div className="flex flex-col gap-3">
                  <SliderRow
                    label="Volume"
                    value={volume}
                    min={0}
                    max={100}
                    step={5}
                    unit="%"
                    onChange={(v) => onUpdate({ volume: v })}
                  />
                  <SliderRow
                    label="Fade in"
                    value={fadeIn}
                    min={0}
                    max={2000}
                    step={50}
                    unit="ms"
                    onChange={(v) => onUpdate({ fadeIn: v })}
                  />
                  <SliderRow
                    label="Fade out"
                    value={fadeOut}
                    min={0}
                    max={2000}
                    step={50}
                    unit="ms"
                    onChange={(v) => onUpdate({ fadeOut: v })}
                  />
                </div>
              </PopoverContent>
            </Popover>
            <button
              type="button"
              draggable={false}
              onDragStart={(e) => e.preventDefault()}
              onClick={(e) => { e.stopPropagation(); onRemove(); }}
              className="w-4 h-4 flex items-center justify-center rounded bg-black/40 text-cyan-100 hover:bg-red-500/80 hover:text-white"
              aria-label="Remove audio"
            >
              <X className="w-3 h-3" />
            </button>
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
