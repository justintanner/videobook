import { useCallback, useRef, type RefObject } from 'react';
import { cn } from '@/lib/utils';
import { downsamplePeaks } from '@/lib/waveform';
import type { SceneMarker } from './types';
import { buildTimeMarks, pctFromMouse, snapToNearest } from './utils';

const HEIGHT = 88;
const SNAP_TOLERANCE_SEC = 0.12;

interface SplitScrubberProps {
  duration: number;
  waveform: number[];
  splitSec: number | null;
  markers: SceneMarker[];
  onSetSplitPct: (pct: number) => void;
  onSetSplitSec: (sec: number) => void;
}

export function SplitScrubber({
  duration,
  waveform,
  splitSec,
  markers,
  onSetSplitPct,
  onSetSplitSec,
}: SplitScrubberProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const snapPoints = markers.map((m) => m.timeSec);

  const applyPointer = useCallback((clientX: number, snap: boolean) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || duration <= 0) return;
    const pct = pctFromMouse({ clientX }, rect);
    let sec = (pct / 100) * duration;
    if (snap && snapPoints.length > 0) {
      sec = snapToNearest(sec, snapPoints, SNAP_TOLERANCE_SEC);
    }
    onSetSplitSec(sec);
  }, [duration, onSetSplitSec, snapPoints]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    applyPointer(e.clientX, true);

    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      applyPointer(ev.clientX, false);
    };
    const onUp = (ev: MouseEvent) => {
      dragging.current = false;
      applyPointer(ev.clientX, true);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [applyPointer]);

  const splitPct = splitSec !== null && duration > 0
    ? (splitSec / duration) * 100
    : null;

  // Silence unused if parent only uses onSetSplitPct elsewhere
  void onSetSplitPct;

  return (
    <div className="flex flex-col gap-1">
      <div
        ref={trackRef}
        data-split-scrubber
        className="relative bg-black border border-zinc-700/50 rounded-md overflow-hidden flex items-end select-none cursor-col-resize"
        style={{ height: HEIGHT }}
        onMouseDown={onMouseDown}
      >
        {waveform.length > 0 && <WaveformBars data={waveform} trackRef={trackRef} />}

        {/* Dim A | B regions */}
        {splitPct !== null && (
          <>
            <div
              className="absolute inset-y-0 left-0 bg-emerald-500/8 pointer-events-none"
              style={{ width: `${splitPct}%` }}
            />
            <div
              className="absolute inset-y-0 right-0 bg-violet-500/8 pointer-events-none"
              style={{ width: `${100 - splitPct}%` }}
            />
          </>
        )}

        {markers.map((m, i) => {
          if (duration <= 0) return null;
          const pct = (m.timeSec / duration) * 100;
          return (
            <div
              key={`m-${i}`}
              className="absolute top-0 bottom-0 w-px bg-amber-400/50 pointer-events-none z-10"
              style={{ left: `${pct}%` }}
              title={m.label || undefined}
            />
          );
        })}

        {splitPct !== null && (
          <div
            className="absolute top-0 bottom-0 z-20 flex items-stretch pointer-events-none"
            style={{ left: `${splitPct}%`, transform: 'translateX(-50%)', width: 16 }}
          >
            <div className="w-0.5 mx-auto bg-violet-400 shadow-[0_0_12px_rgba(167,139,250,0.7)]" />
 <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 size-2.5 rounded-full bg-violet-300 border border-violet-100" />
          </div>
        )}
      </div>

      {duration > 0 && (
        <div className="relative" style={{ height: 14 }}>
          {buildTimeMarks(duration).map((mark, i) => {
            const pct = (mark.timeSec / duration) * 100;
            return (
              <span
                key={i}
                className="absolute text-[10px] font-mono text-zinc-500 -translate-x-1/2"
                style={{ left: `${pct}%` }}
              >
                {mark.label}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

function WaveformBars({ data, trackRef }: { data: number[]; trackRef: RefObject<HTMLDivElement | null> }) {
  void trackRef;
  const bars = downsamplePeaks(data, 160);
  const max = Math.max(...bars, 0.001);
  return (
    <div className="absolute inset-0 flex items-end gap-px px-0.5 pointer-events-none opacity-70">
      {bars.map((v, i) => (
        <div
          key={i}
          className={cn('flex-1 min-w-0 rounded-sm bg-zinc-500/60')}
          style={{ height: `${Math.max(4, (v / max) * 100)}%` }}
        />
      ))}
    </div>
  );
}
