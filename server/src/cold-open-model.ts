export interface ColdOpenSuggestion {
  sourceArtifactId: string;
  sourceObjectHash: string;
  durationSeconds: number;
  fps: number;
  startSeconds: number;
  endSeconds: number;
  reason: string;
  model: string;
}

export function coldOpenRangeError(start: number, end: number, duration: number): string | null {
  if (![start, end, duration].every(Number.isFinite) || duration < 0.5) return "Choose a playable video at least 0.5 seconds long.";
  if (start < 0 || end > duration || end - start < 0.5 - 0.000001) return "Choose a highlight at least 0.5 seconds long within the video.";
  return null;
}
