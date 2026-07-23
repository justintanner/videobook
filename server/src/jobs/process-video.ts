import type { VideocityFs } from "videobook-engine";
import { extname, join } from "node:path";
import { mkdir, readFile as fsReadFile, rm } from "node:fs/promises";
import { registerJobHandler, queue } from "../queue.js";
import { withLocalLease } from "./_lease.js";
import { enqueueLazyAnalysisIfSlotted } from "../lazy-render.js";
import { probeVideo, runFfmpeg, extractWaveform, isThumbnailBlank, H264_MEDIUM, AUDIO_OPTS } from "../ffmpeg.js";
import { formatTimestamp, generateTimestamps } from "../frame-utils.js";

export type ProcessVideoPayload = {
  type: "process_video";
  videoPath: string;
  assetId: string;
  assetDir: string;
  projectSlug: string;
  provenance: Record<string, unknown>;
  force?: boolean;
  skipDownstreamJobs?: boolean;
  preserveAudioArtifacts?: boolean;
  reviveVisualAnalysis?: boolean;
};

export type ProcessVideoResult = {
  success: true;
  width: number;
  height: number;
  duration: number;
  frame_count: number;
};

// Write a derived binary file, skipping the write when the bytes are unchanged.
//
// The engine commits each write scoped to that file's path. A scoped
// `git commit -- <path>` with no diff exits non-zero ("nothing to commit" on
// stdout, empty stderr) whenever the rest of the tree is dirty — which it is
// on a force re-process, since we just deleted original.jpg + frames. Audio is
// stream-copied during watermarking, so re-extracting original.mp3 yields bytes
// identical to the already-committed file; the scoped commit then finds nothing
// and the engine surfaces a bare "Failed to commit file write:". Skipping the
// no-op write lets idempotent re-processing succeed. Mirrors
// writePlanFileIfChanged in plan-notebook.ts.
async function writeBinaryIfChanged(
  fs: VideocityFs,
  assetId: string,
  filename: string,
  data: Buffer,
  projectSlug: string,
): Promise<void> {
  const existing = await fs.readFile(assetId, filename, projectSlug);
  if (existing.ok && existing.value.equals(data)) return;
  const written = await fs.writeFile(assetId, filename, data, projectSlug);
  if (!written.ok) {
    throw new Error(`writeFile ${filename} failed for ${assetId}: ${written.error.message}`);
  }
}

export async function processVideoFiles(
  fs: VideocityFs,
  payload: ProcessVideoPayload,
  signal?: AbortSignal,
): Promise<ProcessVideoResult> {
    const {
      videoPath, assetId, assetDir, projectSlug, provenance,
      force, skipDownstreamJobs, preserveAudioArtifacts, reviveVisualAnalysis,
    } = payload;

    signal?.throwIfAborted();
    const probe = await probeVideo(videoPath, { signal });
    if (probe.videoCodec === null || probe.width <= 0 || probe.height <= 0) {
      throw new Error(`process_video requires a video stream: ${assetId}`);
    }
    const { width, height, duration } = probe;

    // Generate original.mp4 alongside non-mp4 uploads so downstream consumers
    // (browser <video>, ffmpeg jobs, transcribe) get a canonical container.
    // The source file (original.mkv / .mov / etc.) stays on disk as the
    // archival truth — only the derived mp4 is fresh work.
    let activeVideoPath = videoPath;
    const sourceExt = extname(videoPath).toLowerCase();
    if (sourceExt !== ".mp4") {
      const tempPath = join(assetDir, "original.mp4.tmp");
      // Explicit -map drops subtitle/data/attachment streams that the mp4
      // muxer can't handle (e.g. subrip from MKV rips), which would otherwise
      // fail the whole transcode. Also pin to the first audio track so files
      // with multiple language tracks pick a deterministic stream.
      //
      // Stream-copy when the source codec is already mp4-compatible (h264
      // video, aac audio). For a 10-min h264 mkv this turns a multi-minute
      // re-encode into a few-second remux. Fall back to libx264 / aac for
      // anything else (hevc, vp9, dts, opus, etc).
      const canCopyVideo = probe.videoCodec === "h264";
      const canCopyAudio = probe.audioCodec === "aac";
      const videoArgs = canCopyVideo ? ["-c:v", "copy"] : H264_MEDIUM;
      const audioArgs = !probe.hasAudio
        ? ["-an"]
        : canCopyAudio
          ? ["-c:a", "copy"]
          : AUDIO_OPTS;
      const transcodeArgs = [
        "-y",
        "-i", videoPath,
        "-map", "0:v:0",
        ...(probe.hasAudio ? ["-map", "0:a:0"] : []),
        ...videoArgs,
        ...audioArgs,
        "-movflags", "+faststart",
        "-f", "mp4",
        tempPath,
      ];
      try {
        await runFfmpeg(transcodeArgs, { signal });
        const mp4Buf = await fsReadFile(tempPath);
        await writeBinaryIfChanged(fs, assetId, "original.mp4", mp4Buf, projectSlug);
      } finally {
        await rm(tempPath, { force: true });
      }
      activeVideoPath = join(assetDir, "original.mp4");
    }

    let frameCount = 0;
    {

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
    frameCount = timestamps.length;

    const framesDir = join(assetDir, "original_frames");
    await mkdir(framesDir, { recursive: true });

    for (const ts of timestamps) {
      const framePath = join(framesDir, `${formatTimestamp(ts)}.jpg`);
      try {
        await runFfmpeg([
          "-y",
          "-ss", String(ts),
          "-i", activeVideoPath,
          "-frames:v", "1",
          "-q:v", "2",
          "-strict", "unofficial",
          framePath,
        ], { signal });
      } catch {
        // frame extraction failure is non-fatal
      }
    }

    // Extract original.mp3 from the video (kept in sync with original.mp4 so
    // standalone audio reads — timeline, transcription — match the source).
    const existingMp3 = preserveAudioArtifacts
      ? await fs.readFile(assetId, "original.mp3", projectSlug)
      : null;
    if (probe.hasAudio && (!existingMp3 || !existingMp3.ok)) {
      const mp3TempPath = join(assetDir, "original.mp3.tmp");
      await runFfmpeg(["-y", "-i", activeVideoPath, "-vn", "-acodec", "libmp3lame", "-q:a", "2", "-f", "mp3", mp3TempPath], { signal });
      try {
        const mp3Buf = await fsReadFile(mp3TempPath);
        await writeBinaryIfChanged(fs, assetId, "original.mp3", mp3Buf, projectSlug);
      } finally {
        await rm(mp3TempPath, { force: true });
      }
    }

    const existingWaveform = preserveAudioArtifacts
      ? await fs.readAudioWaveform(assetId, projectSlug)
      : null;
    if (!existingWaveform || !existingWaveform.ok) {
      const waveform = await extractWaveform(activeVideoPath);
      if (waveform.length > 0) {
        const wavResult = await fs.writeAudioWaveform(assetId, waveform, projectSlug);
        if (!wavResult.ok) {
          console.warn(
            `[process_video] writeAudioWaveform soft-failed for ${assetId}: ${wavResult.error.message}`,
          );
        }
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

    }

    // Speech-to-text stays eager: cheap (gpt-4o-mini-transcribe) and useful as
    // a standalone artifact even if the asset never lands in a slot. Vision
    // analysis (Gemini) is gated to slot drop in tools/assign-slot.ts — plus
    // the slot-gated revival below for re-processed (trimmed/re-downloaded)
    // videos, whose analysis sidecar was just invalidated.
    if (process.env.NODE_ENV !== "test") {
      if (!skipDownstreamJobs && probe.hasAudio) {
        const transcribeJobId = `transcribe-video-audio-${assetId}-${Date.now()}`;
        await queue.enqueue(transcribeJobId, {
          type: "transcribe_video_audio",
          videoPath: activeVideoPath, assetId, assetDir, projectSlug,
        } as unknown as Record<string, unknown>);
      } else if (!skipDownstreamJobs || reviveVisualAnalysis) {
        // Silent video: no transcribe job will run, so revive the slot-drop
        // vision analysis here; transcribe_video_audio's tail owns it for
        // videos with audio (after the fresh transcript lands).
        try {
          await enqueueLazyAnalysisIfSlotted(fs, projectSlug, assetId);
        } catch {
          // best-effort — analysis revival must not fail processing
        }
      }
    }

    return { success: true, width, height, duration, frame_count: frameCount };
}

export function registerProcessVideoJob(fs: VideocityFs): void {
  registerJobHandler("process_video", async (payload, ctx) => {
    const processPayload = payload as ProcessVideoPayload;
    return withLocalLease(
      fs,
      processPayload.projectSlug,
      processPayload.assetId,
      ctx,
      "process",
      async () => processVideoFiles(fs, processPayload, ctx.signal),
    );
  });
}
