export function sampleEvenly<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const step = (items.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => items[Math.round(i * step)]);
}

function calculateFrameCount(duration: number): number {
  const interval = duration <= 10 ? 2.0 : 5.0;
  const count = Math.floor(duration / interval);
  return Math.max(3, Math.min(30, count));
}

export function formatTimestamp(t: number): string {
  return t.toFixed(2);
}

export function generateTimestamps(duration: number): number[] {
  if (duration <= 0) return [];
  const frameCount = calculateFrameCount(duration);
  const endTime = Math.max(0, duration - 0.1);
  return frameCount === 1
    ? [0.0]
    : Array.from({ length: frameCount }, (_, i) => (endTime / (frameCount - 1)) * i);
}
