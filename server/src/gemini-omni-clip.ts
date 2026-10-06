export const GEMINI_OMNI_VIDEO_TOOL = "generate_kie_gemini_omni_video";

export const GEMINI_OMNI_CLIP_WINDOW_ERROR =
  "video_clip_ends must be greater than video_clip_start and less than 10 seconds after it";

function clipSeconds(value: unknown): number | undefined | null {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

export function geminiOmniClipInputError(input: {
  hasVideo: boolean;
  start: unknown;
  ends: unknown;
  startLabel?: string;
  endsLabel?: string;
}): string | null {
  if (!input.hasVideo) return null;
  const start = clipSeconds(input.start);
  const ends = clipSeconds(input.ends);
  const problems: string[] = [];
  if (start === undefined) {
    problems.push(`${input.startLabel ?? "Video clip start"}: Required`);
  }
  if (ends === undefined) {
    problems.push(`${input.endsLabel ?? "Video clip ends"}: Required`);
  }
  if (problems.length > 0) return problems.join("; ");
  if (start === null || ends === null || start === undefined || ends === undefined) {
    return null;
  }
  if (!(ends > start) || ends - start >= 10) return GEMINI_OMNI_CLIP_WINDOW_ERROR;
  return null;
}
