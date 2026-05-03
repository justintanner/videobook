import type { MediaItem } from '@/components/sidebar/types';
import type { FrameBadge, TimeMark, TrimRange } from './types';

export function formatDurationMS(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function pctFromMouse(e: { clientX: number }, rect: DOMRect): number {
  return Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
}

export function clampPct(v: number): number {
  return Math.max(0, Math.min(100, v));
}

// Snap to the nearest point within toleranceSec; otherwise return timeSec
// unchanged. The tolerance gates how "sticky" snap feels — handles glide
// freely until they're close to a snap point.
export function snapToNearest(
  timeSec: number,
  points: number[],
  toleranceSec: number,
): number {
  if (points.length === 0) return timeSec;
  let best = timeSec;
  let bestDist = toleranceSec;
  for (const p of points) {
    const d = Math.abs(timeSec - p);
    if (d <= bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return best;
}

export function snapRangePct(
  range: TrimRange,
  duration: number,
  points: number[],
  toleranceSec: number,
): TrimRange {
  if (points.length === 0 || duration <= 0) return range;
  let s = snapToNearest((range.startPct / 100) * duration, points, toleranceSec);
  let e = snapToNearest((range.endPct / 100) * duration, points, toleranceSec);
  if (s === e && points.length > 1) {
    // Push end forward to the nearest distinct point so the range stays > 0.
    const next = points.find((p) => p > e);
    const prev = [...points].reverse().find((p) => p < s);
    if (next !== undefined) e = next;
    else if (prev !== undefined) s = prev;
  }
  const sp = clampPct((s / duration) * 100);
  const ep = clampPct((e / duration) * 100);
  return { startPct: Math.min(sp, ep), endPct: Math.max(sp, ep) };
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

export function buildFrameBadges(item: MediaItem | null): FrameBadge[] {
  if (!item || !item.duration) return [];

  const frameUrls = item.frameDirs?.original_frames;
  if (frameUrls && frameUrls.length > 0) {
    const count = Math.min(frameUrls.length, 8);
    const step = Math.max(1, Math.floor(frameUrls.length / count));
    return Array.from({ length: count }, (_, i) => {
      const frameIdx = Math.min(i * step, frameUrls.length - 1);
      const percent = ((i + 0.5) / count) * 100;
      const timeSec = (percent / 100) * item.duration!;
      return {
        percent,
        src: frameUrls[frameIdx],
        time: formatDurationMS(timeSec),
      };
    });
  }

  const count = 6;
  const thumb = item.thumbnailSrc ?? '';
  if (!thumb) return [];
  return Array.from({ length: count }, (_, i) => {
    const percent = ((i + 0.5) / count) * 100;
    const timeSec = (percent / 100) * item.duration!;
    return { percent, src: thumb, time: formatDurationMS(timeSec) };
  });
}
