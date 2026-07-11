import type { TimeMark, TimedCue } from './types';

export const DEFAULT_FPS = 30;
export const MIN_CHUNK_SEC = 0.5;

/** Index of the cue covering `timeSec`, or the last cue that ended at/before it. */
export function findActiveCueIndex(cues: TimedCue[], timeSec: number): number {
  for (let i = 0; i < cues.length; i++) {
    if (timeSec >= cues[i].start && timeSec < cues[i].end) return i;
  }
  let lastPast = -1;
  for (let i = 0; i < cues.length; i++) {
    if (cues[i].end <= timeSec) lastPast = i;
  }
  return lastPast;
}

export function formatDurationMS(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function formatPrecise(seconds: number): string {
  if (seconds >= 60) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toFixed(2).padStart(5, '0')}`;
  }
  return `${seconds.toFixed(3)}s`;
}

export function pctFromMouse(e: { clientX: number }, rect: DOMRect): number {
  return Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
}

export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export function frameDuration(fps: number): number {
  return 1 / Math.max(1, fps);
}

export function quantizeToFrame(timeSec: number, fps: number): number {
  const fd = frameDuration(fps);
  return Math.round(timeSec / fd) * fd;
}

export function frameIndex(timeSec: number, fps: number): number {
  return Math.round(timeSec * Math.max(1, fps));
}

export function snapToNearest(
  timeSec: number,
  points: number[],
  toleranceSec: number,
): number {
  if (points.length === 0) return timeSec;
  let best = timeSec;
  let bestDist = toleranceSec;
  for (const p of points) {
    const d = Math.abs(p - timeSec);
    if (d <= bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return best;
}

export function parseTimestamp(s: string): number | undefined {
  const trimmed = s.trim();
  if (!trimmed) return undefined;
  if (trimmed.includes(':')) {
    const parts = trimmed.split(':');
    if (parts.length === 2 && parts.every((p) => /^\d+(\.\d+)?$/.test(p))) {
      return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
    }
    if (parts.length === 3 && parts.every((p) => /^\d+(\.\d+)?$/.test(p))) {
      return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
    }
    return undefined;
  }
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

export function buildTimeMarks(duration: number): TimeMark[] {
  const intervals = [5, 10, 15, 20, 30, 60, 120, 300];
  let interval = intervals.find((i) => duration / i <= 7) ?? Math.ceil(duration / 6);
  if (interval < 1) interval = 1;
  const marks: TimeMark[] = [];
  for (let t = 0; t <= duration; t += interval) {
    marks.push({ timeSec: t, label: formatDurationMS(t) });
  }
  const last = marks[marks.length - 1];
  if (!last || Math.abs(last.timeSec - duration) > 0.5) {
    marks.push({ timeSec: duration, label: formatDurationMS(duration) });
  }
  return marks;
}

/** Clamp split so both resulting chunks stay ≥ MIN_CHUNK_SEC. */
export function clampSplitSec(splitSec: number, duration: number): number {
  if (duration <= MIN_CHUNK_SEC * 2) return duration / 2;
  return clamp(splitSec, MIN_CHUNK_SEC, duration - MIN_CHUNK_SEC);
}
