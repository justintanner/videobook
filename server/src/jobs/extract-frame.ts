import type { Engine } from "videobook-engine";
import { readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queue, registerJobHandler } from "../queue.js";
import { runFfmpeg } from "../ffmpeg.js";
import { withLockedLocalLease } from "./_lease.js";

const LOCK_DURATION_MS = 60_000;

type ExtractFramePayload = {
  type: "extract_frame";
  inputPath: string;
  timestamp: number;
  imageAssetId: string;
  imageAssetDir: string;
  sourceVideoId: string;
  bookId: string;
  width: number;
  height: number;
  mode: "first" | "last" | "custom";
};

export function registerExtractFrameJob(engine: Engine): void {
  registerJobHandler("extract_frame", async (payload, ctx) => {
    const {
      inputPath, timestamp,
      imageAssetId, imageAssetDir, sourceVideoId,
      bookId, width, height, mode,
    } = payload as ExtractFramePayload;

    // ffmpeg has no API for "write to memory", so we stage the frame in a
    // tempfile outside the asset directory and then route the bytes through
    // the engine file API, which ingests it into CAS and versions the mapping.
    const tempPath = join(
      tmpdir(),
      `videocity-extract-frame-${imageAssetId}-${Date.now()}.jpg`,
    );

    try {
      const origin = await withLockedLocalLease(
        engine,
        imageAssetId,
        imageAssetDir,
        ctx,
        "extract",
        { durationMs: LOCK_DURATION_MS },
        async () => {
        await runFfmpeg([
          "-y",
          "-ss", String(timestamp),
          "-i", inputPath,
          "-frames:v", "1",
          "-q:v", "2",
          tempPath,
        ]);

        const outStat = await stat(tempPath).catch(() => null);
        if (!outStat || outStat.size === 0) {
          throw new Error(
            `ffmpeg produced no output for ${inputPath} at t=${timestamp}s (mode=${mode})`,
          );
        }

        const buffer = await readFile(tempPath);
        const writeResult = await engine.files.write(imageAssetId, "original.jpg", buffer);
        if (!writeResult.ok) {
          throw new Error(
            `failed to write original.jpg for ${imageAssetId}: ${writeResult.error.message}`,
          );
        }

        const origin = {
          origin: `${mode}_frame`,
          source_asset: sourceVideoId,
          timestamp,
          width,
          height,
        };
        await engine.metadata.artifacts.write(imageAssetId, "original", origin);
        return origin;
        },
        { durationMs: LOCK_DURATION_MS, waitForActiveMs: 30_000 },
      );

      const jobId = `process-image-${imageAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "process_image",
        assetId: imageAssetId,
        bookId,
        extension: ".jpg",
        provenance: origin,
      } as unknown as Record<string, unknown>);

      return { success: true };
    } finally {
      await rm(tempPath, { force: true }).catch(() => {});
    }
  });
}
