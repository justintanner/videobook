import type { ClipfirstFs } from "clipfirst-fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { registerJobHandler } from "../queue.js";

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
  outputPath: string;
  timestamp: number;
  imageAssetId: string;
  imageAssetDir: string;
  sourceVideoId: string;
  projectSlug: string;
  width: number;
  height: number;
  mode: "first" | "last";
};

export function registerExtractFrameJob(fs: ClipfirstFs): void {
  registerJobHandler("extract_frame", async (payload) => {
    const {
      inputPath, outputPath, timestamp,
      imageAssetId, imageAssetDir, sourceVideoId,
      projectSlug, width, height, mode,
    } = payload as ExtractFramePayload;

    const lockResult = await fs.acquireLock(imageAssetDir, { durationMs: LOCK_DURATION_MS });
    if (!lockResult.ok) throw new Error(`Asset is locked: ${lockResult.error.message}`);

    try {
      await runFfmpeg([
        "-y",
        "-ss", String(timestamp),
        "-i", inputPath,
        "-frames:v", "1",
        "-q:v", "2",
        outputPath,
      ]);

      const origin = {
        origin: `${mode}_frame`,
        source_asset: sourceVideoId,
        timestamp,
        width,
        height,
      };
      await fs.writeMetadata(imageAssetId, "original", origin, projectSlug);

      return { success: true };
    } finally {
      await fs.releaseLock(imageAssetDir);
    }
  });
}
