import type { ClipfirstFs } from "clipfirst-fs";
import { join } from "node:path";
import { mkdir, writeFile, readFile as fsReadFile, rm } from "node:fs/promises";
import { registerJobHandler, queue } from "../queue.js";
import { probeVideo, runFfmpeg, extractWaveform, isThumbnailBlank } from "../ffmpeg.js";
import { formatTimestamp, generateTimestamps } from "../frame-utils.js";

type ProcessVideoPayload = {
  type: "process_video";
  videoPath: string;
  assetId: string;
  assetDir: string;
  projectSlug: string;
  provenance: Record<string, unknown>;
  force?: boolean;
  skipDownstreamJobs?: boolean;
};

export function registerProcessVideoJob(fs: ClipfirstFs): void {
  registerJobHandler("process_video", async (payload) => {
    const {
      videoPath, assetId, assetDir, projectSlug, provenance,
      force, skipDownstreamJobs,
    } = payload as ProcessVideoPayload;

    const probe = await probeVideo(videoPath);
    const { width, height, duration } = probe;

    await fs.writeMetadata(assetId, "original", { ...provenance, width, height, duration, hasAudio: probe.hasAudio }, projectSlug);

    if (duration <= 0) return { success: true, width, height, duration, frame_count: 0 };

    if (force) {
      await rm(join(assetDir, "original_frames"), { recursive: true, force: true });
      await rm(join(assetDir, "waveform.json"), { force: true }).catch(() => {});
      await rm(join(assetDir, "original.jpg"), { force: true }).catch(() => {});
    }

    const timestamps = generateTimestamps(duration);
    const frameCount = timestamps.length;

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

    // Extract waveform data
    const waveform = await extractWaveform(videoPath);
    if (waveform.length > 0) {
      await writeFile(join(assetDir, "waveform.json"), JSON.stringify(waveform));
    }

    // Create original.jpg from first frame if not already set (e.g., from OG image)
    const thumbResult = await fs.readFile(assetId, "original.jpg", projectSlug ?? "");
    if (!thumbResult.ok) {
      try {
        const firstFrameBuf = await fsReadFile(join(framesDir, "0.00.jpg"));
        await fs.writeFile(assetId, "original.jpg", firstFrameBuf, projectSlug ?? "");
      } catch { /* frame not available */ }
    }

    // If thumbnail is blank (all black/grey), replace with a mid-video frame
    const thumbPath = join(assetDir, "original.jpg");
    if (await isThumbnailBlank(thumbPath) && timestamps.length > 1) {
      const midTs = timestamps[Math.floor(timestamps.length / 2)];
      try {
        const midFrameBuf = await fsReadFile(join(framesDir, `${formatTimestamp(midTs)}.jpg`));
        await fs.writeFile(assetId, "original.jpg", midFrameBuf, projectSlug ?? "");
      } catch { /* mid-frame not available */ }
    }

    await fs.commitOperation("process_video", assetId, {
      width, height, duration, frame_count: frameCount,
    }, projectSlug);

    // Enqueue transcription and analysis for fresh assets (skip for re-processing)
    if (!skipDownstreamJobs) {
      if (probe.hasAudio) {
        const transcribeJobId = `transcribe-video-audio-${assetId}-${Date.now()}`;
        await queue.enqueue(transcribeJobId, {
          type: "transcribe_video_audio",
          videoPath, assetId, assetDir, projectSlug,
        } as unknown as Record<string, unknown>);
      }

      const analyzeJobId = `analyze-video-${assetId}-${Date.now()}`;
      await queue.enqueue(analyzeJobId, {
        type: "analyze_video",
        assetId, assetDir, projectSlug,
        hasTranscription: false,
      } as unknown as Record<string, unknown>);
    }

    return { success: true, width, height, duration, frame_count: frameCount };
  });
}
