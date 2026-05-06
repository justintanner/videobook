import type { ClipfirstFs } from "clipfirst-engine";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { registerJobHandler } from "../queue.js";
import { withLocalLease } from "./_lease.js";

const execFileAsync = promisify(execFile);

const require = createRequire(import.meta.url);
const FFMPEG: string = require("ffmpeg-static");

const LOCK_DURATION_MS = 120_000;

async function runFfmpeg(args: string[]): Promise<void> {
  try {
    await execFileAsync(FFMPEG, args);
  } catch (error) {
    const msg = error instanceof Error ? (error as Error & { stderr?: string }).stderr ?? error.message : String(error);
    throw new Error(`ffmpeg failed: ${msg}`);
  }
}

type ExtractAudioPayload = {
  type: "extract_audio";
  inputPath: string;
  outputPath: string;
  audioAssetId: string;
  audioAssetDir: string;
  sourceVideoId: string;
  projectSlug: string;
  /**
   * When set, the mp3 is being written as a sibling file inside an existing
   * shared asset (e.g. `plan/`). Skip per-asset metadata (it would clobber
   * across siblings) and emit a single commitOperation that references the
   * specific filename instead.
   */
  destination?: { filename: string };
};

export function registerExtractAudioJob(fs: ClipfirstFs): void {
  registerJobHandler("extract_audio", async (payload, ctx) => {
    const {
      inputPath, outputPath,
      audioAssetId, audioAssetDir, sourceVideoId, projectSlug, destination,
    } = payload as ExtractAudioPayload;
    const destinationMode = destination !== undefined;

    return withLocalLease(fs, projectSlug, audioAssetId, ctx, "extract", async () => {
      const lockResult = await fs.acquireLock(audioAssetDir, { durationMs: LOCK_DURATION_MS });
      if (!lockResult.ok) throw new Error(`Asset is locked: ${lockResult.error.message}`);

      try {
        await runFfmpeg([
          "-y",
          "-i", inputPath,
          "-vn",
          "-acodec", "libmp3lame",
          "-q:a", "2",
          outputPath,
        ]);

        if (destinationMode) {
          await fs.commitOperation(
            "extract_audio",
            audioAssetId,
            { source_asset: sourceVideoId, filename: destination.filename },
            projectSlug,
          );
        } else {
          const origin = {
            origin: "extract_audio",
            source_asset: sourceVideoId,
          };
          await fs.writeMetadata(audioAssetId, "original", origin, projectSlug);
        }

        return { success: true };
      } finally {
        await fs.releaseLock(audioAssetDir);
      }
    });
  });
}
