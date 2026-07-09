import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  clampSplitSec,
  DEFAULT_FPS,
  frameDuration,
  quantizeToFrame,
} from './utils';

interface UseSplitPointArgs {
  open: boolean;
  duration: number;
  fps?: number;
  initialSec?: number | null;
}

interface UseSplitPointResult {
  splitSec: number | null;
  setSplitSec: (sec: number | null) => void;
  setSplitFromPct: (pct: number) => void;
  nudgeFrames: (delta: number) => void;
  fps: number;
  frameStep: number;
  resetToMid: () => void;
  clear: () => void;
}

export function useSplitPoint({
  open,
  duration,
  fps: fpsIn,
  initialSec,
}: UseSplitPointArgs): UseSplitPointResult {
  const fps = fpsIn && fpsIn > 0 ? fpsIn : DEFAULT_FPS;
  const frameStep = frameDuration(fps);
  const [splitSec, setSplitSecRaw] = useState<number | null>(null);

  // Seed when opening / asset changes.
  const seedKey = `${open}|${duration}|${initialSec ?? ''}`;
  const [prevSeed, setPrevSeed] = useState(seedKey);
  if (prevSeed !== seedKey) {
    setPrevSeed(seedKey);
    if (open && duration > 0) {
      const seed = initialSec != null && Number.isFinite(initialSec)
        ? initialSec
        : duration / 2;
      setSplitSecRaw(clampSplitSec(quantizeToFrame(seed, fps), duration));
    } else if (!open) {
      setSplitSecRaw(null);
    }
  }

  const setSplitSec = useCallback((sec: number | null) => {
    if (sec === null || duration <= 0) {
      setSplitSecRaw(null);
      return;
    }
    setSplitSecRaw(clampSplitSec(quantizeToFrame(sec, fps), duration));
  }, [duration, fps]);

  const setSplitFromPct = useCallback((pct: number) => {
    if (duration <= 0) return;
    const raw = (Math.max(0, Math.min(100, pct)) / 100) * duration;
    setSplitSec(raw);
  }, [duration, setSplitSec]);

  const nudgeFrames = useCallback((delta: number) => {
    if (duration <= 0) return;
    setSplitSecRaw((prev) => {
      const base = prev ?? duration / 2;
      return clampSplitSec(quantizeToFrame(base + delta * frameStep, fps), duration);
    });
  }, [duration, fps, frameStep]);

  const resetToMid = useCallback(() => {
    if (duration <= 0) {
      setSplitSecRaw(null);
      return;
    }
    setSplitSecRaw(clampSplitSec(quantizeToFrame(duration / 2, fps), duration));
  }, [duration, fps]);

  const clear = useCallback(() => setSplitSecRaw(null), []);

  // Keyboard: ←/→ frame step, Shift = 10 frames, ,/. fine
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if ((e.target as HTMLElement | null)?.isContentEditable) return;

      if (e.key === 'ArrowLeft' || e.key === ',') {
        e.preventDefault();
        nudgeFrames(e.shiftKey ? -10 : -1);
      } else if (e.key === 'ArrowRight' || e.key === '.') {
        e.preventDefault();
        nudgeFrames(e.shiftKey ? 10 : 1);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, nudgeFrames]);

  return useMemo(() => ({
    splitSec,
    setSplitSec,
    setSplitFromPct,
    nudgeFrames,
    fps,
    frameStep,
    resetToMid,
    clear,
  }), [splitSec, setSplitSec, setSplitFromPct, nudgeFrames, fps, frameStep, resetToMid, clear]);
}
