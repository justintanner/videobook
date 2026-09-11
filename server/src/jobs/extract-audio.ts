import type { Engine } from "videobook-engine";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerJobHandler } from "../queue.js";
import { withLockedLocalLease } from "./_lease.js";
import { extractWaveform, probeVideo, runFfmpeg } from "../ffmpeg.js";
import { validateMediaOutputPaths, withMediaOutputLock } from "../media-output-path.js";
import { registerMediaStreams } from "./process-video.js";

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

export function registerExtractAudioJob(engine: Engine): void {
  registerJobHandler("extract_audio", async (payload, ctx) => {
    const {
      inputPath,
      audioAssetId, audioAssetDir, sourceVideoId, destination, range,
    } = payload as ExtractAudioPayload;
    const destinationMode = destination !== undefined;

    const extract = async () => {
      const outputFilename = destination
        ? (await validateMediaOutputPaths(engine, audioAssetId, [destination.filename], ".mp3"))[0]
        : "original.mp3";
      const workspace = await mkdtemp(join(tmpdir(), "videobook-extract-audio-"));
      const outputPath = join(workspace, "output.mp3");
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
        await runFfmpeg(ffmpegArgs, { signal: ctx.signal });
        const probe = await probeVideo(outputPath, { signal: ctx.signal });
        const duration = probe.audioDuration ?? probe.duration;
        if (!probe.hasAudio || !Number.isFinite(duration) || duration <= 0) {
          throw new Error("Audio extraction produced no playable audio");
        }
        const written = await engine.files.writeFromPath(audioAssetId, outputFilename, outputPath);
        if (!written.ok) throw new Error(written.error.message);
        const recorded = await engine.history.recordOperation(
          "extract_audio",
          audioAssetId,
          {
            source_asset: sourceVideoId,
            filename: outputFilename,
            ...(range ? { range } : {}),
            duration,
          },
        );
        if (!recorded.ok) throw new Error(recorded.error.message);

        if (!destinationMode) {
          const origin = {
            origin: "extract_audio",
            source_asset: sourceVideoId,
            duration,
          };
          await engine.metadata.artifacts.write(audioAssetId, "original", origin);
          await registerMediaStreams(engine, audioAssetId, outputFilename, probe);
          const peaks = await extractWaveform(outputPath);
          if (peaks.length > 0) {
            const waveform = await engine.metadata.waveforms.write(
              audioAssetId,
              peaks,
            );
            if (!waveform.ok) throw new Error(waveform.error.message);
          }
        }

        return { success: true };
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    };
    if (destinationMode) return withMediaOutputLock(engine, audioAssetDir, ctx.signal, extract);
    return withLockedLocalLease(engine, audioAssetId, audioAssetDir, ctx, "extract", { durationMs: LOCK_DURATION_MS }, extract);
  });
}
