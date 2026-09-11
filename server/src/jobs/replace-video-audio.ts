import type { Engine } from "videobook-engine";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { registerJobHandler, queue } from "../queue.js";
import { AUDIO_OPTS, probeVideo, runFfmpeg } from "../ffmpeg.js";
import { withLockedLocalLease } from "./_lease.js";
import { replaceArtifactFileFromPath } from "./_persist-output.js";

const LOCK_DURATION_MS = 300_000;

const STALE_ANALYSIS_FILES = [
  ".original.analysis.json",
  ".analysis.gpt4otrans.json",
  "elevenlabs.json",
];

type ReplaceVideoAudioPayload = {
  type: "replace_video_audio";
  inputPath: string;
  audioPath: string;
  outputPath: string;
  assetId: string;
  assetDir: string;
  audioAssetId: string;
  bookId: string;
  // Merged into the final process_video provenance. Lets a chained caller
  // (e.g. completeProviderVideo) preserve its own source/model/prompt fields
  // — without this they'd be overwritten by the replace-audio metadata write.
  extraProvenance?: Record<string, unknown>;
};

export function registerReplaceVideoAudioJob(engine: Engine): void {
  registerJobHandler("replace_video_audio", async (payload, ctx) => {
    const {
      inputPath, audioPath,
      assetId, assetDir, audioAssetId, bookId,
      extraProvenance,
    } = payload as ReplaceVideoAudioPayload;

    const result = await withLockedLocalLease(
      engine,
      assetId,
      assetDir,
      ctx,
      "replace_audio",
      { durationMs: LOCK_DURATION_MS, data: { state: "replacing-audio" } },
      async () => {
      const inputFilename = basename(inputPath);
      const source = await probeVideo(inputPath, { signal: ctx.signal });
      if (!source.videoStream || source.videoDuration <= 0) throw new Error("Video source has no playable video stream");
      const workspace = await mkdtemp(join(tmpdir(), "videobook-replace-audio-"));
      const outputPath = join(workspace, "output.mp4");
      try {
        await runFfmpeg([
          "-y", "-i", inputPath, "-i", audioPath,
          "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy",
          "-af", `apad,atrim=duration=${source.videoDuration},asetpts=PTS-STARTPTS`,
          ...AUDIO_OPTS, "-movflags", "+faststart", outputPath,
        ], { signal: ctx.signal });
        const output = await probeVideo(outputPath, { signal: ctx.signal });
        const tolerance = Math.max(1 / (source.fps || 30), 0.05);
        if (!output.hasAudio || Math.abs(output.videoDuration - source.videoDuration) > tolerance
          || Math.abs((output.audioDuration ?? output.duration) - source.videoDuration) > tolerance) {
          throw new Error("Replacement audio output does not preserve the video duration");
        }
        await replaceArtifactFileFromPath(engine, assetId, inputFilename, outputPath);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }

      for (const stale of STALE_ANALYSIS_FILES) {
        await engine.files.delete(assetId, stale);
      }

      const videoPath = join(assetDir, inputFilename);
      return { videoPath };
      },
      { durationMs: LOCK_DURATION_MS, waitForActiveMs: 30_000 },
    );

    await queue.enqueue(`process-video-${assetId}-${Date.now()}`, {
      type: "process_video",
      videoPath: result.videoPath,
      assetId,
      assetDir,
      bookId,
      provenance: {
        ...(extraProvenance ?? {}),
        origin: "replace_audio",
        source_audio: audioAssetId,
        replaced_at: new Date().toISOString(),
      },
      force: true,
    } as unknown as Record<string, unknown>);

    return { success: true };
  });
}
