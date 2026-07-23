import type { VideocityFs } from "videobook-engine";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queue, registerJobHandler } from "../queue.js";
import { withLockedLocalLease } from "./_lease.js";

const execFileAsync = promisify(execFile);

const require = createRequire(import.meta.url);
const FFMPEG: string = require("ffmpeg-static");

const LOCK_DURATION_MS = 60_000;

async function runFfmpeg(args: string[]): Promise<void> {
  try {
    await execFileAsync(FFMPEG, args);
  } catch (error) {
    const msg = error instanceof Error ? (error as Error & { stderr?: string }).stderr ?? error.message : String(error);
    throw new Error(`ffmpeg failed: ${msg}`);
  }
}

type ExtractFramePayload = {
  type: "extract_frame";
  inputPath: string;
  timestamp: number;
  imageAssetId: string;
  imageAssetDir: string;
  sourceVideoId: string;
  projectSlug: string;
  width: number;
  height: number;
  mode: "first" | "last" | "custom";
};

export function registerExtractFrameJob(fs: VideocityFs): void {
  registerJobHandler("extract_frame", async (payload, ctx) => {
    const {
      inputPath, timestamp,
      imageAssetId, imageAssetDir, sourceVideoId,
      projectSlug, width, height, mode,
    } = payload as ExtractFramePayload;

    // ffmpeg has no API for "write to memory", so we stage the frame in a
    // tempfile outside the asset directory and then route the bytes through
    // fs.writeFile, which commits the file to the engine's git history.
    // Writing directly into the asset dir leaves original.jpg untracked —
    // the asset's manifest/UI still works (we read from disk) but git
    // versioning silently breaks for that file.
    const tempPath = join(
      tmpdir(),
      `videocity-extract-frame-${imageAssetId}-${Date.now()}.jpg`,
    );

    try {
      const origin = await withLockedLocalLease(
        fs,
        projectSlug,
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
        const writeResult = await fs.writeFile(imageAssetId, "original.jpg", buffer, projectSlug);
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
        await fs.writeMetadata(imageAssetId, "original", origin, projectSlug);
        return origin;
        },
        { durationMs: LOCK_DURATION_MS, waitForActiveMs: 30_000 },
      );

      const jobId = `process-image-${imageAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "process_image",
        assetId: imageAssetId,
        projectSlug,
        extension: ".jpg",
        provenance: origin,
      } as unknown as Record<string, unknown>);

      return { success: true };
    } finally {
      await rm(tempPath, { force: true }).catch(() => {});
    }
  });
}
