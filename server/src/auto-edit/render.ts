import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { basename } from "node:path";
import { promisify } from "node:util";
import { FFPROBE, probeVideo, runFfmpeg, type ProbeResult } from "../ffmpeg.js";
import { buildSegmentRenderArgs } from "./graph.js";
import { planOutputFrames, type SegmentPlan } from "./plan.js";

const execFileAsync = promisify(execFile);
const FRAME_COUNT_TIMEOUT_MS = 600_000;
const VARIABLE_RATE_TOLERANCE = 0.01;

export interface SegmentRenderResult {
  probe: ProbeResult;
  frames: number;
}

export function isVariableFrameRate(probe: Pick<ProbeResult, "fps" | "avgFps">): boolean {
  return probe.avgFps !== null && Math.abs(probe.avgFps - probe.fps) > probe.fps * VARIABLE_RATE_TOLERANCE;
}

async function countVideoFrames(path: string, signal?: AbortSignal): Promise<number> {
  const { stdout } = await execFileAsync(FFPROBE, [
    "-v", "error",
    "-select_streams", "v:0",
    "-count_frames",
    "-show_entries", "stream=nb_read_frames",
    "-of", "csv=p=0",
    path,
  ], { signal, timeout: FRAME_COUNT_TIMEOUT_MS, killSignal: "SIGKILL" });
  const count = Number.parseInt(stdout.trim(), 10);
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new Error(`Could not count the video frames of ${basename(path)}`);
  }
  return count;
}

export async function validateSegmentOutput(
  plan: SegmentPlan,
  outputPath: string,
  options: { signal?: AbortSignal; expectAudio?: boolean } = {},
): Promise<SegmentRenderResult> {
  const [probe, frames] = await Promise.all([
    probeVideo(outputPath, { signal: options.signal }),
    countVideoFrames(outputPath, options.signal),
  ]);
  if (probe.videoCodec === null) {
    throw new Error("Auto-edit output has no video stream");
  }
  if (probe.width !== plan.source.width || probe.height !== plan.source.height) {
    throw new Error(
      `Auto-edit output is ${probe.width}x${probe.height}; the plan expects ${plan.source.width}x${plan.source.height}`,
    );
  }
  const expectedFrames = planOutputFrames(plan);
  if (frames !== expectedFrames) {
    throw new Error(`Auto-edit output has ${frames} frames; the plan expects ${expectedFrames}`);
  }
  const wantsAudio = options.expectAudio ?? plan.source.hasAudio;
  if (probe.hasAudio !== wantsAudio) {
    throw new Error(wantsAudio ? "Auto-edit output has no sound stream" : "Auto-edit output gained a sound stream");
  }
  if (wantsAudio) {
    const audioDuration = probe.audioDuration ?? 0;
    const videoDuration = probe.videoDuration > 0 ? probe.videoDuration : probe.duration;
    if (Math.abs(audioDuration - videoDuration) > 1 / plan.source.fps) {
      throw new Error(
        `Auto-edit sound lasts ${audioDuration.toFixed(3)} s; the picture lasts ${videoDuration.toFixed(3)} s`,
      );
    }
  }
  return { probe, frames };
}

export async function renderSegmentPlan(
  plan: SegmentPlan,
  sourcePath: string,
  outputPath: string,
  signal?: AbortSignal,
): Promise<SegmentRenderResult> {
  signal?.throwIfAborted();
  try {
    const sourceProbe = await probeVideo(sourcePath, { signal });
    const args = buildSegmentRenderArgs(plan, {
      inputPath: sourcePath,
      outputPath,
      variableFrameRate: isVariableFrameRate(sourceProbe),
    });
    await runFfmpeg(args, { signal });
    signal?.throwIfAborted();
    return await validateSegmentOutput(plan, outputPath, { signal });
  } catch (error) {
    await rm(outputPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
