import type { Engine } from "videobook-engine";
import { rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { registerJobHandler, queue } from "../queue.js";
import { runFfmpeg, probeVideo, H264_MEDIUM, AUDIO_OPTS } from "../ffmpeg.js";
import { withLockedLocalLease } from "./_lease.js";
import { replaceArtifactFileFromPath } from "./_persist-output.js";
import { cropGeometry, type CropRect, type CropRatio } from "../crop-geometry.js";
import { SOUND_SIDECARS } from "../stale-sidecars.js";

const LOCK_DURATION_MS = 300_000;
type CropVideoPayload = {
  type: "crop_video";
  inputPath: string;
  outputPath: string;
  ratio: CropRatio;
  rect: CropRect;
  assetId: string;
  assetDir: string;
  bookId: string;
};

export function registerCropVideoJob(engine: Engine): void {
  registerJobHandler("crop_video", async (payload, ctx) => {
    const {
      inputPath, outputPath, ratio, rect,
      assetId, assetDir, bookId,
    } = payload as unknown as CropVideoPayload;

    const result = await withLockedLocalLease(
      engine,
      assetId,
      assetDir,
      ctx,
      "crop",
      { durationMs: LOCK_DURATION_MS, data: { state: "cropping", ratio } },
      async () => {
        const src = await probeVideo(inputPath);
        if (!src.width || !src.height) {
          throw new Error(`Could not probe source dimensions for ${inputPath}`);
        }

        const { cropX, cropY, cropW, cropH, outW, outH } = cropGeometry(rect, src.width, src.height, ratio, 2);

        const vf =
          `crop=${cropW}:${cropH}:${cropX}:${cropY},` +
          `scale=${outW}:${outH}:flags=lanczos,setsar=1`;

        const args = [
          "-y", "-i", inputPath,
          "-vf", vf,
          ...H264_MEDIUM,
          ...(src.hasAudio ? AUDIO_OPTS : ["-an"]),
          "-movflags", "+faststart",
          outputPath,
        ];

        try {
          await runFfmpeg(args);
        } catch (err) {
          await rm(outputPath, { force: true });
          throw err;
        }

        try {
          const out = await probeVideo(outputPath);
          if (out.width !== outW || out.height !== outH) {
            throw new Error(
              `Crop output dimensions ${out.width}x${out.height} do not match canonical ${outW}x${outH}`,
            );
          }
          if (!(out.duration > 0)) {
            throw new Error(`Crop output has zero duration`);
          }
        } catch (err) {
          await rm(outputPath, { force: true });
          throw err;
        }

        const inputFilename = basename(inputPath);
        await replaceArtifactFileFromPath(
          engine,
          assetId,
          inputFilename,
          outputPath,
        );

        for (const stale of SOUND_SIDECARS) {
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
      provenance: { origin: "crop", ratio, cropped_at: new Date().toISOString() },
      force: true,
    } as unknown as Record<string, unknown>);

    return { success: true };
  });
}
