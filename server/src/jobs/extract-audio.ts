import type { VideocityFs } from "vc-engine";
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
  /**
   * When set, ffmpeg clips this time window out of the source via -ss/-t.
   * Output-side seek (-ss after -i) is the accurate path; the small precision
   * cost vs input-side seek is fine for sub-15s scene mp3s.
   */
  range?: { start_s: number; duration_s: number };
};

export function registerExtractAudioJob(fs: VideocityFs): void {
  registerJobHandler("extract_audio", async (payload, ctx) => {
    const {
      inputPath, outputPath,
      audioAssetId, audioAssetDir, sourceVideoId, projectSlug, destination, range,
    } = payload as ExtractAudioPayload;
    const destinationMode = destination !== undefined;

    return withLocalLease(fs, projectSlug, audioAssetId, ctx, "extract", async () => {
      const lockResult = await fs.acquireLock(audioAssetDir, { durationMs: LOCK_DURATION_MS });
      if (!lockResult.ok) throw new Error(`Asset is locked: ${lockResult.error.message}`);

      try {
        const ffmpegArgs = [
          "-y",
          "-i", inputPath,
          "-vn",
          "-acodec", "libmp3lame",
          "-q:a", "2",
          ...(range ? ["-ss", String(range.start_s), "-t", String(range.duration_s)] : []),
          outputPath,
        ];
        await runFfmpeg(ffmpegArgs);

        if (destinationMode) {
          await fs.commitOperation(
            "extract_audio",
            audioAssetId,
            {
              source_asset: sourceVideoId,
              filename: destination.filename,
              ...(range ? { range } : {}),
            },
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
