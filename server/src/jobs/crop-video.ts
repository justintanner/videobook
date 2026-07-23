import type { VideocityFs } from "videobook-engine";
import { rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { registerJobHandler, queue } from "../queue.js";
import { runFfmpeg, probeVideo, H264_MEDIUM, AUDIO_OPTS } from "../ffmpeg.js";
import { withLockedLocalLease } from "./_lease.js";

const LOCK_DURATION_MS = 300_000;
const ASPECT_TOLERANCE = 0.02;

type Ratio = "16:9" | "9:16" | "1:1";

const CANONICAL_DIMS: Record<Ratio, [number, number]> = {
  "16:9": [1920, 1080],
  "9:16": [1080, 1920],
  "1:1": [1080, 1080],
};

interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface PixelBox {
  cropX: number;
  cropY: number;
  cropW: number;
  cropH: number;
}

function toEvenPixelBox(rect: CropRect, srcW: number, srcH: number): PixelBox {
  const cropW = Math.max(2, Math.round((rect.w * srcW) / 2) * 2);
  const cropH = Math.max(2, Math.round((rect.h * srcH) / 2) * 2);
  // Round origin down to even, then clamp so origin + size stays inside the frame.
  let cropX = Math.max(0, Math.floor((rect.x * srcW) / 2) * 2);
  let cropY = Math.max(0, Math.floor((rect.y * srcH) / 2) * 2);
  if (cropX + cropW > srcW) cropX = Math.max(0, srcW - cropW);
  if (cropY + cropH > srcH) cropY = Math.max(0, srcH - cropH);
  return { cropX, cropY, cropW, cropH };
}

type CropVideoPayload = {
  type: "crop_video";
  inputPath: string;
  outputPath: string;
  ratio: Ratio;
  rect: CropRect;
  assetId: string;
  assetDir: string;
  projectSlug: string;
};

export function registerCropVideoJob(fs: VideocityFs): void {
  registerJobHandler("crop_video", async (payload, ctx) => {
    const {
      inputPath, outputPath, ratio, rect,
      assetId, assetDir, projectSlug,
    } = payload as unknown as CropVideoPayload;

    const result = await withLockedLocalLease(
      fs,
      projectSlug,
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

        const { cropX, cropY, cropW, cropH } = toEvenPixelBox(rect, src.width, src.height);
        const [outW, outH] = CANONICAL_DIMS[ratio];

        const cropAspect = cropW / cropH;
        const targetAspect = outW / outH;
        const aspectErr = Math.abs(cropAspect - targetAspect) / targetAspect;
        if (aspectErr > ASPECT_TOLERANCE) {
          throw new Error(
            `Crop rectangle aspect ${cropAspect.toFixed(4)} (${cropW}x${cropH}) ` +
            `does not match target ratio ${ratio} (${targetAspect.toFixed(4)}); ` +
            `error ${(aspectErr * 100).toFixed(1)}% > ${(ASPECT_TOLERANCE * 100).toFixed(0)}%`,
          );
        }

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
        const outputFilename = basename(outputPath);
        await fs.deleteFile(assetId, inputFilename, projectSlug);
        await fs.renameFile(assetId, outputFilename, inputFilename, projectSlug);

        for (const stale of [
          ".original.analysis.json",
          ".analysis.gpt4otrans.json",
          "elevenlabs.json",
          ".kie-task.json",
        ]) {
          await fs.deleteFile(assetId, stale, projectSlug);
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
      projectSlug,
      provenance: { origin: "crop", ratio, cropped_at: new Date().toISOString() },
      force: true,
    } as unknown as Record<string, unknown>);

    return { success: true };
  });
}
