import type { Engine } from "videobook-engine";
import { registerJobHandler, queue } from "../queue.js";
import { cropRegion, probeImage } from "../image.js";
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

type CropImagePayload = {
  type: "crop_image";
  inputFilename: string;
  ratio: Ratio;
  rect: CropRect;
  assetId: string;
  assetDir: string;
  bookId: string;
};

export function registerCropImageJob(fs: Engine): void {
  registerJobHandler("crop_image", async (payload, ctx) => {
    const {
      inputFilename, ratio, rect,
      assetId, assetDir, bookId,
    } = payload as unknown as CropImagePayload;

    const result = await withLockedLocalLease(
      fs,
      assetId,
      assetDir,
      ctx,
      "crop",
      { durationMs: LOCK_DURATION_MS, data: { state: "cropping", ratio } },
      async () => {
        const readResult = await fs.files.read(assetId, inputFilename);
        if (!readResult.ok) {
          throw new Error(`Failed to read ${inputFilename}: ${readResult.error.message}`);
        }
        const buffer = Buffer.isBuffer(readResult.value)
          ? readResult.value
          : Buffer.from(readResult.value);

        const src = await probeImage(buffer);
        if (!src.width || !src.height) {
          throw new Error(`Could not probe source dimensions for ${inputFilename}`);
        }

        const cropW = Math.max(1, Math.round(rect.w * src.width));
        const cropH = Math.max(1, Math.round(rect.h * src.height));
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

        const cropped = await cropRegion(buffer, rect, outW, outH);
        const out = await probeImage(cropped);
        if (out.width !== outW || out.height !== outH) {
          throw new Error(
            `Crop output dimensions ${out.width}x${out.height} do not match canonical ${outW}x${outH}`,
          );
        }

        const finalFilename = "original.jpg";
        const writeResult = await fs.files.write(assetId, finalFilename, cropped);
        if (!writeResult.ok) {
          throw new Error(`Failed to write cropped image: ${writeResult.error.message}`);
        }

        // Drop the previous original when it was a different filename (e.g. original.png).
        if (inputFilename !== finalFilename) {
          await fs.files.delete(assetId, inputFilename);
        }

        return { extension: ".jpg" as const };
      },
      { durationMs: LOCK_DURATION_MS, waitForActiveMs: 30_000 },
    );

    await queue.enqueueAndWait(`process-image-${assetId}-${Date.now()}`, {
      type: "process_image",
      assetId,
      bookId,
      extension: result.extension,
      provenance: { origin: "crop", ratio, cropped_at: new Date().toISOString() },
    } as unknown as Record<string, unknown>);

    return { success: true };
  });
}
