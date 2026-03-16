import type { ClipfirstFs } from "clipfirst-fs";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { registerJobHandler } from "../queue.js";
import { queue } from "../queue.js";
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
  provenance: Record<string, unknown>;
};

export function registerProcessVideoJob(fs: ClipfirstFs): void {
  registerJobHandler("process_video", async (payload) => {
    const {
      videoPath, assetId, assetDir, projectSlug, provenance,
    } = payload as ProcessVideoPayload;

    const probe = await probeVideo(videoPath);
    const { width, height, duration } = probe;

    await fs.writeMetadata(assetId, "original", { ...provenance, width, height, duration }, projectSlug);

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

    // Create thumbnail.jpg from first frame if not already set (e.g., from OG image)
    const thumbResult = await fs.readFile(assetId, "thumbnail.jpg", projectSlug ?? "");
    if (!thumbResult.ok) {
      const firstFrame = await fs.readFile(assetId, "original_frames/0.00.jpg", projectSlug ?? "");
      if (firstFrame.ok) {
        await fs.writeFile(assetId, "thumbnail.jpg", firstFrame.value, projectSlug ?? "");
      }
    }

    await fs.commitOperation("process_video", assetId, {
      width, height, duration, frame_count: frameCount,
    }, projectSlug);

    if (probe.hasAudio) {
      const jobId = `transcribe-video-audio-${assetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "transcribe_video_audio",
        videoPath, assetId, assetDir, projectSlug,
      } as unknown as Record<string, unknown>);
    } else {
      const jobId = `analyze-video-${assetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "analyze_video",
        assetId, assetDir, projectSlug, hasTranscription: false,
      } as unknown as Record<string, unknown>);
    }

    return { success: true, width, height, duration, frame_count: frameCount };
  });
}
