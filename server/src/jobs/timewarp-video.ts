import type { Engine } from "videobook-engine";
import { rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { probeVideo, runFfmpeg, H264_MEDIUM, AUDIO_OPTS } from "../ffmpeg.js";
import { registerJobHandler, queue } from "../queue.js";
import {
  buildTimewarpVideoFilter,
  createTimewarpPlan,
  type TimewarpPlan,
} from "../timewarp.js";
import { withLockedLocalLease } from "./_lease.js";
import { replaceArtifactFileFromPath } from "./_persist-output.js";

const LOCK_DURATION_MS = 900_000;

const STALE_VISUAL_DERIVATIVES = [
  ".original.analysis.json",
  ".detect-scenes.json",
  ".suggest-cuts.json",
  ".suggest-sfx.json",
  ".analyze-jokes.json",
];

export type TimewarpAudioMode = "copy" | "aac" | "none";

type TimewarpVideoPayload = {
  type: "timewarp_video";
  inputPath: string;
  outputPath: string;
  startSeconds: number;
  endSeconds: number;
  stretchFactor: number;
  assetId: string;
  assetDir: string;
  bookId: string;
};

function outputArgs(
  inputPath: string,
  outputPath: string,
  plan: TimewarpPlan,
  hasAudio: boolean,
  audioMode: Exclude<TimewarpAudioMode, "none">,
): string[] {
  return [
    "-y",
    "-i", inputPath,
    "-filter_complex", buildTimewarpVideoFilter(plan),
    "-map", "[vout]",
    ...(hasAudio ? ["-map", "0:a:0"] : ["-an"]),
    ...H264_MEDIUM,
    "-pix_fmt", "yuv420p",
    ...(hasAudio ? (audioMode === "copy" ? ["-c:a", "copy"] : AUDIO_OPTS) : []),
    "-t", plan.sourceDuration.toFixed(9),
    "-movflags", "+faststart",
    "-f", "mp4",
    outputPath,
  ];
}

export async function renderTimewarpedVideo(
  inputPath: string,
  outputPath: string,
  plan: TimewarpPlan,
  hasAudio: boolean,
  signal?: AbortSignal,
): Promise<TimewarpAudioMode> {
  if (!hasAudio) {
    await runFfmpeg(outputArgs(inputPath, outputPath, plan, false, "copy"), { signal });
    return "none";
  }

  try {
    await runFfmpeg(outputArgs(inputPath, outputPath, plan, true, "copy"), { signal });
    return "copy";
  } catch {
    await runFfmpeg(outputArgs(inputPath, outputPath, plan, true, "aac"), { signal });
    return "aac";
  }
}

export async function validateTimewarpOutput(
  inputPath: string,
  outputPath: string,
  plan: TimewarpPlan,
): Promise<void> {
  const [input, output] = await Promise.all([
    probeVideo(inputPath),
    probeVideo(outputPath),
  ]);
  if (output.videoCodec === null || output.width <= 0 || output.height <= 0) {
    throw new Error("Timewarp output has no usable video stream");
  }
  if (output.width !== input.width || output.height !== input.height) {
    throw new Error(
      `Timewarp output dimensions ${output.width}x${output.height} do not match source ${input.width}x${input.height}`,
    );
  }
  if (output.hasAudio !== input.hasAudio) {
    throw new Error("Timewarp output audio stream layout does not match the source");
  }
  const tolerance = Math.max(0.08, 2 / plan.sourceFps);
  if (!Number.isFinite(output.duration)
    || Math.abs(output.duration - plan.sourceDuration) > tolerance) {
    throw new Error(
      `Timewarp output duration ${output.duration.toFixed(3)}s does not match source ${plan.sourceDuration.toFixed(3)}s`,
    );
  }
}

async function deleteIfPresent(
  fs: Engine,
  assetId: string,
  filename: string,
): Promise<void> {
  const result = await fs.files.delete(assetId, filename);
  if (!result.ok && result.error.code !== "NOT_FOUND") {
    throw new Error(`Failed to delete ${filename}: ${result.error.message}`);
  }
}

async function discardTemp(
  outputPath: string,
): Promise<void> {
  await rm(outputPath, { force: true });
}

export function registerTimewarpVideoJob(fs: Engine): void {
  registerJobHandler("timewarp_video", async (payload, ctx) => {
    const {
      inputPath,
      outputPath,
      startSeconds,
      endSeconds,
      stretchFactor,
      assetId,
      assetDir,
      bookId,
    } = payload as TimewarpVideoPayload;

    const result = await withLockedLocalLease(
      fs,
      assetId,
      assetDir,
      ctx,
      "change_speed",
      { durationMs: LOCK_DURATION_MS, data: { state: "timewarping" } },
      async () => {
        const source = await probeVideo(inputPath, { signal: ctx.signal });
        const plan = createTimewarpPlan({
          sourceDuration: source.duration,
          sourceFps: source.fps,
          startSeconds,
          endSeconds,
          stretchFactor,
        });
        let audioMode: TimewarpAudioMode;
        try {
          audioMode = await renderTimewarpedVideo(
            inputPath,
            outputPath,
            plan,
            source.hasAudio,
            ctx.signal,
          );
          await validateTimewarpOutput(inputPath, outputPath, plan);
        } catch (error) {
          await discardTemp(outputPath);
          throw error;
        }

        const history = fs.history.artifact(assetId);
        const restoreCommit = history[0]?.hash;
        try {
          const inputFilename = basename(inputPath);
          await replaceArtifactFileFromPath(
            fs,
            assetId,
            inputFilename,
            outputPath,
          );
          for (const filename of STALE_VISUAL_DERIVATIVES) {
            await deleteIfPresent(fs, assetId, filename);
          }
        } catch (error) {
          if (restoreCommit) await fs.history.restoreArtifact(assetId, restoreCommit);
          throw error;
        }

        return {
          videoPath: join(assetDir, basename(inputPath)),
          plan,
          audioMode,
        };
      },
      { durationMs: LOCK_DURATION_MS, waitForActiveMs: 30_000 },
    );

    await queue.enqueue(`process-video-${assetId}-${Date.now()}`, {
      type: "process_video",
      videoPath: result.videoPath,
      assetId,
      assetDir,
      bookId,
      provenance: {
        origin: "timewarp",
        start_seconds: result.plan.startSeconds,
        end_seconds: result.plan.endSeconds,
        stretch_factor: result.plan.stretchFactor,
        outside_stretch_factor: result.plan.outsideStretchFactor,
        source_duration: result.plan.sourceDuration,
        selected_output_duration: result.plan.selectedOutputDuration,
        audio_preserved: true,
        audio_mode: result.audioMode,
        timewarped_at: new Date().toISOString(),
      },
      force: true,
      skipDownstreamJobs: true,
      preserveAudioArtifacts: true,
      reviveVisualAnalysis: true,
    } as unknown as Record<string, unknown>);

    return {
      success: true,
      source_duration: result.plan.sourceDuration,
      selected_output_duration: result.plan.selectedOutputDuration,
      outside_stretch_factor: result.plan.outsideStretchFactor,
      audio_mode: result.audioMode,
    };
  });
}
