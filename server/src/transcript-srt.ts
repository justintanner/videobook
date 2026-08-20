import { chunkSegments } from "./remotion/subtitles/chunker.js";
import { parseSegments } from "./remotion/subtitles/segments.js";
import type { Orientation, SubtitleStyle } from "./remotion/subtitles/types.js";
import { srtContent, type SrtCue } from "./srt.js";

export type TranscriptSrtOptions = {
  orientation?: Orientation;
  style?: SubtitleStyle;
};

function asElevenLabsJson(raw: unknown): Parameters<typeof parseSegments>[0] {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("ElevenLabs transcript is not valid JSON");
  }
  return raw as Parameters<typeof parseSegments>[0];
}

function monotonicCues(
  chunks: Array<{ start: number; end: number; text: string }>,
): SrtCue[] {
  const cues: SrtCue[] = [];
  let lastEnd = 0;
  for (const chunk of chunks) {
    const text = chunk.text.trim();
    if (!text) continue;
    const start = Math.max(chunk.start, lastEnd);
    const end = Math.max(chunk.end, start);
    const safeEnd = end === start ? start + 0.001 : end;
    cues.push({ startSeconds: start, endSeconds: safeEnd, text });
    lastEnd = safeEnd;
  }
  return cues;
}

export function transcriptToSrt(
  raw: unknown,
  options: TranscriptSrtOptions = {},
): string {
  const segments = parseSegments(asElevenLabsJson(raw));
  const chunks = chunkSegments(
    segments,
    options.orientation ?? "landscape",
    options.style ?? "impact",
  );
  const cues = monotonicCues(chunks);
  if (cues.length === 0) {
    throw new Error("No word-timed cues in the ElevenLabs transcript");
  }
  return srtContent(cues);
}
