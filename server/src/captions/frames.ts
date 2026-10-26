import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFfmpeg } from "../ffmpeg.js";

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
