import type { Engine } from "videobook-engine";
import { registerJobHandler } from "../queue.js";
import { withLocalLease } from "./_lease.js";
import { probeVideo, runFfmpeg } from "../ffmpeg.js";
import { ingestWorkspaceOutputs } from "./_persist-output.js";

const LOCK_DURATION_MS = 120_000;

type ExtractAudioPayload = {
  type: "extract_audio";
  inputPath: string;
  outputPath: string;
  audioAssetId: string;
  audioAssetDir: string;
  sourceVideoId: string;
  bookId: string;
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

export function registerExtractAudioJob(fs: Engine): void {
  registerJobHandler("extract_audio", async (payload, ctx) => {
    const {
      inputPath, outputPath,
      audioAssetId, audioAssetDir, sourceVideoId, bookId, destination, range,
    } = payload as ExtractAudioPayload;
    const destinationMode = destination !== undefined;

    return withLocalLease(fs, bookId, audioAssetId, ctx, "extract", async () => {
      const lockResult = await fs.jobs.locks.acquire(audioAssetDir, { durationMs: LOCK_DURATION_MS });
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

        let duration: number | undefined;
        try {
          const probe = await probeVideo(outputPath);
          if (Number.isFinite(probe.duration) && probe.duration > 0) {
            duration = probe.duration;
          }
        } catch { /* non-fatal — list_assets backfill can recover */ }

        const outputFilename = outputPath.split("/").pop()!;
        await ingestWorkspaceOutputs(
          fs,
          bookId,
          audioAssetId,
          [outputFilename],
          "extract_audio",
          {
            source_asset: sourceVideoId,
            filename: outputFilename,
            ...(range ? { range } : {}),
            ...(duration !== undefined ? { duration } : {}),
          },
        );

        if (destinationMode) {
          void destination;
        } else {
          const origin = {
            origin: "extract_audio",
            source_asset: sourceVideoId,
            ...(duration !== undefined ? { duration } : {}),
          };
          await fs.metadata.artifacts.write(audioAssetId, "original", origin);
        }

        return { success: true };
      } finally {
        await fs.jobs.locks.release(audioAssetDir);
      }
    });
  });
}
