import type { ClipfirstFs } from "clipfirst-fs";
import { join } from "node:path";
import { mkdir, readFile as fsReadFile, rm } from "node:fs/promises";
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
      await rm(join(assetDir, "original.jpg"), { force: true }).catch(() => {});
      // Renders are derived from the old source video — drop them so the UI
      // falls back to original.mp4 and prompts a re-render.
      for (const orient of ["landscape", "portrait", "square"] as const) {
        await rm(join(assetDir, `${orient}.mp4`), { force: true }).catch(() => {});
        await rm(join(assetDir, `${orient}.jpg`), { force: true }).catch(() => {});
        await rm(join(assetDir, `${orient}_frames`), { recursive: true, force: true }).catch(() => {});
        await rm(join(assetDir, `.${orient}.render.json`), { force: true }).catch(() => {});
      }
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

    // Extract original.mp3 from the video (kept in sync with original.mp4 so
    // standalone audio reads — timeline, transcription — match the source).
    if (probe.hasAudio) {
      const mp3TempPath = join(assetDir, "original.mp3.tmp");
      await runFfmpeg(["-y", "-i", videoPath, "-vn", "-acodec", "libmp3lame", "-q:a", "2", mp3TempPath]);
      try {
        const mp3Buf = await fsReadFile(mp3TempPath);
        const mp3Result = await fs.writeFile(assetId, "original.mp3", mp3Buf, projectSlug);
        if (!mp3Result.ok) {
          throw new Error(`writeFile original.mp3 failed for ${assetId}: ${mp3Result.error.message}`);
        }
      } finally {
        await rm(mp3TempPath, { force: true });
      }
    }

    // Extract waveform and persist via the typed primitive (committed to git
    // alongside metadata.sqlite + the per-asset canonical export).
    const waveform = await extractWaveform(videoPath);
    if (waveform.length > 0) {
      const wavResult = await fs.writeAudioWaveform(assetId, waveform, projectSlug);
      if (!wavResult.ok) {
        throw new Error(`writeAudioWaveform failed for ${assetId}: ${wavResult.error.message}`);
      }
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
