import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFfmpeg } from "../ffmpeg.js";
import { detectOccupiedRegions } from "../vision-regions.js";
import type { AlivePhrase, AliveRegion } from "../remotion/subtitles/alive-types.js";

const FRAMES_PER_REQUEST = 10;

const SYSTEM_PROMPT = `You are a precise video-layout analyst. Each attached image is a frame from the middle of a sung or spoken phrase that will get large stacked caption typography.

For every frame, identify all occupied regions the captions must not cover:
- every visible human face, including partial faces and faces on posters or screens
- every existing visible text block, subtitle, caption, title, logo, watermark, or graphic

Return one entry for every cue_id. Coordinates use a normalized image scale from 0 to 1000: x and y are the top-left corner, followed by width and height. Use tight boxes around the visible occupied content. Do not return boxes for bodies, clothing, scenery, instruments, microphones, or ordinary objects. Return an empty occupied_regions array only when none of the listed content is visible. Never omit, rename, or duplicate a cue_id.`;

export interface PhraseFrame {
  id: string;
  frameTime: number;
  buffer: Buffer;
}

function clampFrameTime(time: number, duration: number): number {
  return Math.max(0, Math.min(Math.max(0, duration - 0.05), time));
}

export async function extractPhraseFrames(
  videoPath: string,
  phrases: AlivePhrase[],
  duration: number,
  signal?: AbortSignal,
): Promise<PhraseFrame[]> {
  const dir = await mkdtemp(join(tmpdir(), "videobook-alive-frames-"));
  try {
    const frames: PhraseFrame[] = [];
    for (const phrase of phrases) {
      signal?.throwIfAborted();
      const frameTime = clampFrameTime(phrase.frameTime, duration);
      const framePath = join(dir, `${phrase.id}.jpg`);
      await runFfmpeg([
        "-y", "-ss", frameTime.toFixed(3), "-i", videoPath,
        "-frames:v", "1", "-vf", "scale=768:768:force_original_aspect_ratio=decrease", "-q:v", "3",
        framePath,
      ], { signal });
      frames.push({ id: phrase.id, frameTime, buffer: await readFile(framePath) });
    }
    return frames;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function batches<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

/** Face/text/graphic boxes per phrase frame, normalized to the source frame. */
export async function detectPhraseRegions(
  frames: PhraseFrame[],
  apiKey: string,
  signal: AbortSignal,
): Promise<Map<string, AliveRegion[]>> {
  const regions = new Map<string, AliveRegion[]>();
  for (const batch of batches(frames, FRAMES_PER_REQUEST)) {
    const found = await detectOccupiedRegions(
      batch.map((frame) => ({ id: frame.id, label: `timestamp=${frame.frameTime.toFixed(3)}s`, buffer: frame.buffer })),
      {
        apiKey,
        signal,
        instructions: SYSTEM_PROMPT,
        schemaName: "alive_caption_regions",
        errorLabel: "Alive caption placement",
      },
    );
    for (const [id, boxes] of found) regions.set(id, boxes);
  }
  return regions;
}
