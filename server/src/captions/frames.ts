import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFfmpeg } from "../ffmpeg.js";
import { detectOccupiedRegions } from "../vision-regions.js";

const FRAMES_PER_REQUEST = 10;

const SYSTEM_PROMPT = `You are a precise video-layout analyst. Each attached image is a frame from a video that will get large caption typography.

For every frame, identify all occupied regions the captions must not cover:
- every visible human face, including partial faces and faces on posters or screens
- every existing visible text block, subtitle, caption, title, logo, watermark, or graphic

Return one entry for every cue_id. Coordinates use a normalized image scale from 0 to 1000: x and y are the top-left corner, followed by width and height. Use tight boxes around the visible occupied content. Do not return boxes for bodies, clothing, scenery, instruments, microphones, or ordinary objects. Return an empty occupied_regions array only when none of the listed content is visible. Never omit, rename, or duplicate a cue_id.`;

export interface FrameRegion {
  kind: "face" | "text" | "graphic";
  confidence: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FrameRequest {
  id: string;
  time: number;
}

export interface SampledFrame extends FrameRequest {
  buffer: Buffer;
}

function clampFrameTime(time: number, duration: number): number {
  return Math.max(0, Math.min(Math.max(0, duration - 0.05), time));
}

export async function extractFrames(
  videoPath: string,
  requests: readonly FrameRequest[],
  duration: number,
  signal?: AbortSignal,
): Promise<SampledFrame[]> {
  const dir = await mkdtemp(join(tmpdir(), "videobook-caption-frames-"));
  try {
    const frames: SampledFrame[] = [];
    for (const request of requests) {
      signal?.throwIfAborted();
      const time = clampFrameTime(request.time, duration);
      const framePath = join(dir, `${request.id}.jpg`);
      await runFfmpeg([
        "-y", "-ss", time.toFixed(3), "-i", videoPath,
        "-frames:v", "1", "-vf", "scale=768:768:force_original_aspect_ratio=decrease", "-q:v", "3",
        framePath,
      ], { signal });
      frames.push({ id: request.id, time, buffer: await readFile(framePath) });
    }
    return frames;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function batches<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

export async function detectFrameRegions(
  frames: readonly SampledFrame[],
  apiKey: string,
  signal: AbortSignal,
): Promise<Map<string, FrameRegion[]>> {
  const regions = new Map<string, FrameRegion[]>();
  for (const batch of batches(frames, FRAMES_PER_REQUEST)) {
    const found = await detectOccupiedRegions(
      batch.map((frame) => ({ id: frame.id, label: `timestamp=${frame.time.toFixed(3)}s`, buffer: frame.buffer })),
      {
        apiKey,
        signal,
        instructions: SYSTEM_PROMPT,
        schemaName: "caption_regions",
        errorLabel: "Caption placement",
      },
    );
    for (const [id, boxes] of found) regions.set(id, boxes);
  }
  return regions;
}
