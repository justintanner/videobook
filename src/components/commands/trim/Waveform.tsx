import type { RefObject } from 'react';
import { cn } from '@/lib/utils';
import type { FrameBadge, SnapMarker, TrimMode, TrimRange } from './types';
import { formatDurationMS } from './utils';
import { getModeClasses } from './mode-classes';

const WAVEFORM_HEIGHT = 96;

interface WaveformProps {
  waveformRef: RefObject<HTMLDivElement | null>;
  duration: number;
  waveform: number[];
  trimRange: TrimRange | null;
  trimMode: TrimMode;
  overCap: boolean;
  capLineSec: number | null;
  markers: SnapMarker[];
  frameBadges: FrameBadge[];
  playheadPercent: number;
  onMouseDown: (e: React.MouseEvent) => void;
  onStartHandleMouseDown: (e: React.MouseEvent) => void;
  onEndHandleMouseDown: (e: React.MouseEvent) => void;
}

export function Waveform({
  waveformRef,
  duration,
  waveform,
  trimRange,
  trimMode,
  overCap,
  capLineSec,
  markers,
  frameBadges,
  playheadPercent,
  onMouseDown,
  onStartHandleMouseDown,
  onEndHandleMouseDown,
}: WaveformProps) {
  const modeClasses = getModeClasses(trimMode, overCap);
  const splitMode = trimMode === 'split';

  return (
    <div className="relative overflow-visible" style={{ height: WAVEFORM_HEIGHT }}>
      <div
        ref={waveformRef}
        data-waveform
        className="relative bg-black border border-zinc-700/50 rounded-md overflow-hidden flex items-end select-none cursor-col-resize"
        style={{ height: WAVEFORM_HEIGHT }}
        onMouseDown={onMouseDown}
      >
        {waveform.length > 0 && <WaveformBars data={waveform} />}

        {/* Trim selection overlay */}
        {trimRange && (
          <SelectionOverlay
            trimRange={trimRange}
            trimMode={trimMode}
            overCap={overCap}
            duration={duration}
          />
        )}

        {/* Cap line — drawn whether selected or not so the user sees the limit. */}
        {capLineSec !== null && duration > 0 && (
          <CapLine capLineSec={capLineSec} duration={duration} />
        )}

        {/* Start/end handles */}
        {trimRange && (
          <>
            <div
              className="absolute top-0 bottom-0 z-20 flex items-stretch cursor-ew-resize"
              style={{ left: `${trimRange.startPct}%`, transform: 'translateX(-50%)', width: 12 }}
              onMouseDown={onStartHandleMouseDown}
            >
              <div className={cn('w-0.5 mx-auto', modeClasses.line)} />
            </div>
            <div
              className="absolute top-0 bottom-0 z-20 flex items-stretch cursor-ew-resize"
              style={{ left: `${trimRange.endPct}%`, transform: 'translateX(-50%)', width: 12 }}
              onMouseDown={onEndHandleMouseDown}
            >
              <div className={cn('w-0.5 mx-auto', modeClasses.line)} />
            </div>
            {duration > 0 && (
              <>
                <span
                  className={cn('absolute top-0.5 text-[9px] font-mono pointer-events-none z-30 -translate-x-1/2', modeClasses.text)}
                  style={{ left: `${trimRange.startPct}%` }}
                >
                  {splitMode ? 'A→' : formatDurationMS((trimRange.startPct / 100) * duration)}
                </span>
                <span
                  className={cn('absolute top-0.5 text-[9px] font-mono pointer-events-none z-30 -translate-x-1/2', modeClasses.text)}
                  style={{ left: `${trimRange.endPct}%` }}
                >
                  {splitMode ? '←B' : formatDurationMS((trimRange.endPct / 100) * duration)}
                </span>
              </>
            )}
          </>
        )}

        {/* 250ms grid notches */}
        {duration > 0 && <GridNotches duration={duration} />}
      </div>

      {/* Scene markers */}
      {duration > 0 && markers
        .filter((m) => m.timeSec > 0 && m.timeSec < duration)
        .map((m, i) => (
          <SceneMarker key={`scene-${i}`} marker={m} duration={duration} />
        ))}

      {/* Frame badges */}
      {frameBadges.filter((b) => b.percent > 1 && b.percent < 99).map((badge, i) => (
        <FrameBadgeMark key={`frame-${i}`} badge={badge} />
      ))}

      {/* Playhead */}
      <div
        className="absolute top-0 pointer-events-none z-30"
        style={{
          left: `${playheadPercent}%`,
          width: 3,
          height: WAVEFORM_HEIGHT,
          marginLeft: -1,
          backgroundColor: 'rgb(34, 211, 238)',
          filter: 'drop-shadow(0 0 6px rgba(34, 211, 238, 0.7))',
        }}
      />
    </div>
  );
}

function WaveformBars({ data }: { data: number[] }) {
  const maxVal = Math.max(...data, 1);
  return (
    <div className="flex items-end w-full h-full gap-[0.5px] px-px">
      {data.map((val, i) => (
        <div
          key={i}
          className="flex-1 min-w-0 bg-cyan-500/50 rounded-t-[0.5px]"
          style={{ height: `${Math.max((val / maxVal) * 100, 2)}%` }}
        />
      ))}
    </div>
  );
}

interface SelectionOverlayProps {
  trimRange: TrimRange;
  trimMode: TrimMode;
  overCap: boolean;
  duration: number;
}

function SelectionOverlay({ trimRange, trimMode, overCap, duration }: SelectionOverlayProps) {
  const modeClasses = getModeClasses(trimMode, overCap);
  const widthPct = trimRange.endPct - trimRange.startPct;

  if (trimMode === 'split') {
    return (
      <>
        {/* Left half tint = chunk A */}
        <div
          className="absolute top-0 bottom-0 left-0 bg-emerald-500/8 pointer-events-none z-10"
          style={{ width: `${trimRange.endPct}%` }}
        />
        {/* Right half tint = chunk B */}
        <div
          className="absolute top-0 bottom-0 right-0 bg-cyan-500/8 pointer-events-none z-10"
          style={{ width: `${100 - trimRange.startPct}%` }}
        />
        {/* Overlap zone (violet) */}
        {widthPct > 0.05 && (
          <div
            className={cn('absolute top-0 bottom-0 pointer-events-none z-10', modeClasses.tint)}
            style={{ left: `${trimRange.startPct}%`, width: `${widthPct}%` }}
          />
        )}
        {/* A / B / overlap labels */}
        <span
          className="absolute top-7 z-30 -translate-x-1/2 rounded border border-emerald-400/50 bg-zinc-950/90 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-emerald-300 pointer-events-none"
          style={{ left: `${trimRange.startPct / 2}%` }}
        >
          A · {formatDurationMS((trimRange.endPct / 100) * duration)}
        </span>
        <span
          className="absolute top-7 z-30 -translate-x-1/2 rounded border border-cyan-400/50 bg-zinc-950/90 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-cyan-300 pointer-events-none"
          style={{ left: `${(100 + trimRange.endPct) / 2}%` }}
        >
          B · {formatDurationMS(duration - (trimRange.startPct / 100) * duration)}
        </span>
        {widthPct > 0.05 && (
          <span
            className={cn('absolute top-14 z-30 -translate-x-1/2 rounded border bg-zinc-950/90 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest pointer-events-none', modeClasses.text, modeClasses.border)}
            style={{ left: `${(trimRange.startPct + trimRange.endPct) / 2}%` }}
          >
            overlap {formatDurationMS((widthPct / 100) * duration)}
          </span>
        )}
      </>
    );
  }

  return (
    <>
      {trimMode === 'keep' && (
        <>
          <div
            className="absolute top-0 bottom-0 left-0 bg-black/55 pointer-events-none z-10"
            style={{ width: `${trimRange.startPct}%` }}
          />
          <div
            className="absolute top-0 bottom-0 right-0 bg-black/55 pointer-events-none z-10"
            style={{ width: `${100 - trimRange.endPct}%` }}
          />
        </>
      )}
      <div
        className={cn('absolute top-0 bottom-0 pointer-events-none z-10', modeClasses.tint)}
        style={{ left: `${trimRange.startPct}%`, width: `${widthPct}%` }}
      />
      <div
        className={cn(
          'absolute top-7 z-30 -translate-x-1/2 rounded border bg-zinc-950/90 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest pointer-events-none',
          modeClasses.text,
          modeClasses.border,
        )}
        style={{ left: `${(trimRange.startPct + trimRange.endPct) / 2}%` }}
      >
        {trimMode === 'keep' ? 'Keep' : 'Remove'}
      </div>
    </>
  );
}

interface CapLineProps {
  capLineSec: number;
  duration: number;
}

function CapLine({ capLineSec, duration }: CapLineProps) {
  const pct = (capLineSec / duration) * 100;
  return (
    <div
      className="absolute top-0 bottom-0 pointer-events-none z-[18]"
      style={{ left: `${pct}%`, width: 0 }}
    >
      <div className="absolute inset-y-0 left-0 w-px bg-amber-400/70 shadow-[0_0_4px_rgba(245,158,11,0.6)]" />
      <span className="absolute -top-3 left-1 text-[9px] font-mono text-amber-300 whitespace-nowrap">
        10.0s cap
      </span>
    </div>
  );
}

function GridNotches({ duration }: { duration: number }) {
  const ticks: React.ReactNode[] = [];
  for (let t = 0.25; t < duration; t += 0.25) {
    const isSec = Math.abs(t - Math.round(t)) < 0.01;
    ticks.push(
      <div
        key={t}
        className="absolute pointer-events-none z-[15]"
        style={{
          left: `${(t / duration) * 100}%`,
          top: 0,
          width: 1,
          height: isSec ? 12 : 6,
          backgroundColor: isSec ? 'rgba(161,161,170,0.6)' : 'rgba(161,161,170,0.3)',
        }}
      />,
    );
  }
  return <>{ticks}</>;
}

function SceneMarker({ marker, duration }: { marker: SnapMarker; duration: number }) {
  return (
    <div
      className="absolute z-20 group"
      style={{ left: `${(marker.timeSec / duration) * 100}%`, top: 0, bottom: 0 }}
    >
      <div className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-amber-400/40" />
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center justify-center w-4 h-4 rounded-full bg-amber-500 border border-amber-300 cursor-pointer shadow-[0_0_8px_rgba(245,158,11,0.5)]">
        <span className="text-[13px] font-black text-zinc-900 leading-none">!</span>
      </div>
      <div
        className="absolute left-1/2 -translate-x-1/2 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity z-50 w-48 p-2 rounded bg-zinc-900/95 border border-amber-400/50 shadow-[0_0_12px_rgba(245,158,11,0.3)]"
        style={{ bottom: 'calc(100% + 8px)' }}
      >
        <span className="text-[9px] font-mono text-amber-300 block mb-0.5">{formatDurationMS(marker.timeSec)}</span>
        <span className="text-[10px] text-zinc-300 leading-tight line-clamp-3">{marker.label}</span>
      </div>
    </div>
  );
}

function FrameBadgeMark({ badge }: { badge: FrameBadge }) {
  return (
    <div className="absolute z-20 group" style={{ left: `${badge.percent}%`, top: 0, bottom: 0 }}>
      <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-cyan-500/30" />
      <div
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-6 rounded-sm border border-cyan-400/60 bg-cover bg-center cursor-pointer shadow-[0_0_6px_rgba(34,211,238,0.3)]"
        style={{ backgroundImage: `url(${badge.src})` }}
      />
      <div
        className="absolute left-1/2 -translate-x-1/2 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity z-50 flex flex-col items-center gap-1"
        style={{ bottom: 'calc(100% + 8px)' }}
      >
        <div
          className="w-[140px] h-[94px] rounded border border-cyan-400/60 bg-cover bg-center shadow-[0_0_12px_rgba(34,211,238,0.5)]"
          style={{ backgroundImage: `url(${badge.src})` }}
        />
        <span className="text-[9px] font-mono text-cyan-400/80 whitespace-nowrap">{badge.time}</span>
      </div>
    </div>
  );
}
