export function isInsertVideoModel(model: string): boolean {
  return model === "fal:minimax/h3-max/insert-video" || model === "minimax/h3-max/insert-video";
}

export function insertVideoTimingError(options: Record<string, unknown>, sourceDuration?: number | null): string | null {
  const start = typeof options.start_time === "string" && options.start_time.trim() ? Number(options.start_time) : options.start_time;
  const resume = typeof options.resume_time === "string" && options.resume_time.trim() ? Number(options.resume_time) : options.resume_time;
  if (typeof start !== "number" || typeof resume !== "number" || !Number.isFinite(start) || !Number.isFinite(resume)) return null;
  if (sourceDuration !== undefined && sourceDuration !== null && sourceDuration > 0) {
    const seconds = Number(sourceDuration.toFixed(3));
    if (start >= sourceDuration) return `Replace from must be before the source video ends at ${seconds}s (currently ${start}s).`;
    if (resume > sourceDuration) return `Resume original must be within the ${seconds}s source video (currently ${resume}s).`;
  }
  return resume <= start ? "Resume original must be after Replace from. Both times refer to the original video." : null;
}
