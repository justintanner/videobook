export const AUDIO_TRIM_EPSILON_SECONDS = 0.05;

function expectedAudioTrimDuration(
  sourceDuration: number,
  mode: "keep" | "cut",
  trimStart?: number,
  trimEnd?: number,
  cutStart?: number,
  cutEnd?: number,
): number {
  if (mode === "keep") {
    const start = trimStart ?? 0;
    const end = trimEnd ?? sourceDuration;
    if (start >= sourceDuration - AUDIO_TRIM_EPSILON_SECONDS) {
      throw new Error(`trim_start ${start} must be before audio duration ${sourceDuration.toFixed(3)}`);
    }
    if (end > sourceDuration + AUDIO_TRIM_EPSILON_SECONDS) {
      throw new Error(`trim_end ${end} exceeds audio duration ${sourceDuration.toFixed(3)}`);
    }
    return Math.min(end, sourceDuration) - start;
  }

  const start = cutStart ?? 0;
  const end = cutEnd ?? sourceDuration;
  if (start >= sourceDuration - AUDIO_TRIM_EPSILON_SECONDS) {
    throw new Error(`cut_start ${start} must be before audio duration ${sourceDuration.toFixed(3)}`);
  }
  if (end > sourceDuration + AUDIO_TRIM_EPSILON_SECONDS) {
    throw new Error(`cut_end ${end} exceeds audio duration ${sourceDuration.toFixed(3)}`);
  }
  return sourceDuration - (Math.min(end, sourceDuration) - start);
}

export function validateAudioTrimRange(
  sourceDuration: number,
  mode: "keep" | "cut",
  trimStart?: number,
  trimEnd?: number,
  cutStart?: number,
  cutEnd?: number,
): number {
  if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) throw new Error("Audio file has no usable duration");
  const duration = expectedAudioTrimDuration(sourceDuration, mode, trimStart, trimEnd, cutStart, cutEnd);
  if (duration <= AUDIO_TRIM_EPSILON_SECONDS) throw new Error("Trim would produce an empty audio file");
  return duration;
}
