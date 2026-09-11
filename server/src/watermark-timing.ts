export function effectiveWatermarkTiming(
  label: string,
  duration: number,
  startSeconds?: number,
  endSeconds?: number,
): { startSeconds?: number; endSeconds?: number } {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("Video has no usable duration");
  const effectiveStart = startSeconds ?? 0;
  if (effectiveStart < 0 || effectiveStart >= duration) {
    throw new Error(`${label} start must be before the ${duration.toFixed(2)}s clip end`);
  }
  const effectiveEnd = endSeconds === undefined ? undefined : Math.min(endSeconds, duration);
  if (effectiveEnd !== undefined && effectiveEnd <= effectiveStart) {
    throw new Error(`${label} end must be after its start`);
  }
  return {
    ...(startSeconds !== undefined ? { startSeconds } : {}),
    ...(effectiveEnd !== undefined ? { endSeconds: effectiveEnd } : {}),
  };
}
