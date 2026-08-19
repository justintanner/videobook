import type { Engine } from "videobook-engine";
import { rm } from "node:fs/promises";
import { logger } from "../logger.js";
import { registerJobHandler, queue } from "../queue.js";
import { runFfmpeg, H264_MEDIUM, AUDIO_OPTS } from "../ffmpeg.js";
import { join, basename } from "node:path";
import { withLockedLocalLease } from "./_lease.js";
import { replaceArtifactFileFromPath } from "./_persist-output.js";

const LOCK_DURATION_MS = 300_000;

type PadVideoPayload = {
  type: "pad_video";
  sourcePath: string;
  assetDir: string;
  sourceAssetId: string;
  bookId: string;
  targetSecs: number;
  hasAudio: boolean;
};

export function registerPadVideoJob(engine: Engine): void {
  registerJobHandler("pad_video", async (payload, ctx) => {
    logger.debug("pad_video payload:", payload);
    const { sourcePath, assetDir, sourceAssetId, bookId, targetSecs, hasAudio } = payload as PadVideoPayload;
    
    const result = await withLockedLocalLease(
      engine,
      sourceAssetId,
      assetDir,
      ctx,
      "process",
      { durationMs: LOCK_DURATION_MS, data: { state: "padding-video" } },
      async () => {
        const outName = `padded-${Date.now()}.mp4`;
        const outputPath = join(assetDir, outName);

        try {
          const args = ["-y", "-i", sourcePath];
          
          if (hasAudio) {
            args.push(
              "-filter_complex", "[0:v]tpad=stop=-1:color=black[v];[0:a]apad[a]",
              "-map", "[v]",
              "-map", "[a]",
              "-t", targetSecs.toString(),
              ...H264_MEDIUM,
              ...AUDIO_OPTS,
              outputPath
            );
          } else {
            args.push(
              "-filter_complex", "[0:v]tpad=stop=-1:color=black[v]",
              "-map", "[v]",
              "-t", targetSecs.toString(),
              ...H264_MEDIUM,
              outputPath
            );
          }

          await runFfmpeg(args);

          const splitAtIso = new Date().toISOString();
          const provenance = {
            origin: "pad_video",
            source_asset_id: sourceAssetId,
            target_secs: targetSecs,
            has_audio: hasAudio,
            split_at_iso: splitAtIso,
          };

          const inputFilename = basename(sourcePath);
          await replaceArtifactFileFromPath(
            engine,
            sourceAssetId,
            inputFilename,
            outputPath,
          );

          for (const stale of [
            ".original.analysis.json",
            ".analysis.gpt4otrans.json",
            "elevenlabs.json",
          ]) {
            await engine.files.delete(sourceAssetId, stale);
          }

          await engine.metadata.artifacts.write(sourceAssetId, "original", provenance);

          const videoPath = join(assetDir, inputFilename);
          return { videoPath, provenance };
        } catch (err) {
          await rm(outputPath, { force: true }).catch(() => {});
          throw err;
        }
      },
      { durationMs: LOCK_DURATION_MS, waitForActiveMs: 30_000 }
    );

    await queue.enqueueAndWait(`process-video-${sourceAssetId}-${Date.now()}`, {
      type: "process_video",
      videoPath: result.videoPath,
      assetId: sourceAssetId,
      assetDir: assetDir,
      bookId,
      skipDownstreamJobs: true,
      provenance: result.provenance,
    } as unknown as Record<string, unknown>);

    return { success: true };
  });
}
