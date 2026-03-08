import type { ClipfirstFs } from "clipfirst-fs";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { registerJobHandler } from "../queue.js";
import { probeVideo, runFfmpeg } from "../ffmpeg.js";

function calculateFrameCount(duration: number): number {
  const interval = duration <= 10 ? 2.0 : 5.0;
  const count = Math.floor(duration / interval);
  return Math.max(3, Math.min(30, count));
}

function formatTimestamp(t: number): string {
  return t.toFixed(2);
}

type ProcessVideoPayload = {
  type: "process_video";
  videoPath: string;
  assetId: string;
  assetDir: string;
  projectSlug?: string;
};

export function registerProcessVideoJob(fs: ClipfirstFs): void {
  registerJobHandler("process_video", async (payload) => {
    const {
      videoPath, assetId, assetDir, projectSlug,
    } = payload as ProcessVideoPayload;

    const probe = await probeVideo(videoPath);
    const { width, height, duration } = probe;

    await fs.writeMetadata(assetId, "original", { width, height, duration }, projectSlug);

    if (duration <= 0) return { success: true, width, height, duration, frame_count: 0 };

    const frameCount = calculateFrameCount(duration);
    const endTime = Math.max(0, duration - 0.1);
    const timestamps = frameCount === 1
      ? [0.0]
      : Array.from({ length: frameCount }, (_, i) => (endTime / (frameCount - 1)) * i);

    const framesDir = join(assetDir, "original_frames");
    await mkdir(framesDir, { recursive: true });

    for (const ts of timestamps) {
      const framePath = join(framesDir, `${formatTimestamp(ts)}.jpg`);
      try {
        await runFfmpeg([
          "-y",
          "-i", videoPath,
          "-ss", String(ts),
          "-frames:v", "1",
          "-q:v", "2",
          "-strict", "unofficial",
          framePath,
        ]);
      } catch {
        // frame extraction failure is non-fatal
      }
    }

    await fs.commitOperation("process_video", assetId, {
      width, height, duration, frame_count: frameCount,
    }, projectSlug);

    return { success: true, width, height, duration, frame_count: frameCount };
  });
}
