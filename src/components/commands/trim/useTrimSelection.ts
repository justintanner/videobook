import { useCallback, useEffect, useRef } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { TrimRange } from './types';
import { pctFromMouse, snapRangePct } from './utils';

interface UseTrimSelectionArgs {
  open: boolean;
  duration: number;
  snapPoints: number[];
  waveformRef: RefObject<HTMLDivElement | null>;
  trimRange: TrimRange | null;
  setTrimRange: Dispatch<SetStateAction<TrimRange | null>>;
}

interface UseTrimSelectionResult {
  handleWaveformMouseDown: (e: React.MouseEvent) => void;
  startHandleMouseDown: (e: React.MouseEvent) => void;
  endHandleMouseDown: (e: React.MouseEvent) => void;
}

// Snap tolerance (seconds): handles glide freely outside this band, then
// click onto the nearest snap point inside it.
const SNAP_TOLERANCE_SEC = 0.15;

export function useTrimSelection({
  open,
  duration,
  snapPoints,
  waveformRef,
  trimRange,
  setTrimRange,
}: UseTrimSelectionArgs): UseTrimSelectionResult {
  const draggingRef = useRef<false | 'create' | 'start' | 'end'>(false);
  const dragStartPctRef = useRef(0);

  const handleWaveformMouseDown = useCallback((e: React.MouseEvent) => {
    const rect = waveformRef.current?.getBoundingClientRect();
    if (!rect) return;
    const pct = pctFromMouse(e, rect);
    if (trimRange) {
      const hitZone = 2;
      if (Math.abs(pct - trimRange.startPct) <= hitZone) {
        draggingRef.current = 'start';
        return;
      }
      if (Math.abs(pct - trimRange.endPct) <= hitZone) {
        draggingRef.current = 'end';
        return;
      }
    }
    draggingRef.current = 'create';
    dragStartPctRef.current = pct;
    setTrimRange({ startPct: pct, endPct: pct });
  }, [trimRange, waveformRef, setTrimRange]);

  const startHandleMouseDown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    draggingRef.current = 'start';
  }, []);

  const endHandleMouseDown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    draggingRef.current = 'end';
  }, []);

  useEffect(() => {
    if (!open) return;
    const handleMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const rect = waveformRef.current?.getBoundingClientRect();
      if (!rect) return;
      const rawPct = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
      const mode = draggingRef.current;
      const snap = (range: TrimRange): TrimRange =>
        snapPoints.length > 0 && duration > 0
          ? snapRangePct(range, duration, snapPoints, SNAP_TOLERANCE_SEC)
          : range;

      if (mode === 'create') {
        const anchor = dragStartPctRef.current;
        setTrimRange(snap({
          startPct: Math.min(anchor, rawPct),
          endPct: Math.max(anchor, rawPct),
        }));
      } else if (mode === 'start') {
        setTrimRange((prev) => prev
          ? snap({
              startPct: Math.min(rawPct, prev.endPct),
              endPct: Math.max(rawPct, prev.endPct),
            })
          : prev);
      } else if (mode === 'end') {
        setTrimRange((prev) => prev
          ? snap({
              startPct: Math.min(prev.startPct, rawPct),
              endPct: Math.max(prev.startPct, rawPct),
            })
          : prev);
      }
    };
    const handleUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [open, snapPoints, duration, waveformRef, setTrimRange]);

  return {
    handleWaveformMouseDown,
    startHandleMouseDown,
    endHandleMouseDown,
  };
}
