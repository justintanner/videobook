export function sampleEvenly<T>(items: T[], maxSamples: number): T[] {
  if (maxSamples <= 0) return [];
  if (items.length <= maxSamples) return items;
  if (maxSamples === 1) return [items[0]!];
  const sampleStep = (items.length - 1) / (maxSamples - 1);
  return Array.from(
    { length: maxSamples },
    (_, index) => items[Math.round(index * sampleStep)]!,
  );
}

function calculateFrameSampleCount(durationSeconds: number): number {
  const sampleIntervalSeconds = durationSeconds <= 10 ? 2 : 5;
  const sampleCount = Math.floor(durationSeconds / sampleIntervalSeconds);
  return Math.max(3, Math.min(30, sampleCount));
}

export function formatTimestamp(t: number): string {
  return t.toFixed(2);
}

export function generateTimestamps(durationSeconds: number): number[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return [];
  const sampleCount = calculateFrameSampleCount(durationSeconds);
  const endMarginSeconds = Math.min(0.1, durationSeconds / sampleCount);
  const lastTimestampSeconds = durationSeconds - endMarginSeconds;
  const sampleStepSeconds = lastTimestampSeconds / (sampleCount - 1);
  return Array.from(
    { length: sampleCount },
    (_, index) => sampleStepSeconds * index,
  );
}
