import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { FFPROBE, probeVideo, runFfmpeg, type ProbeResult } from "../ffmpeg.js";
import { writeBuiltinSfxFiles, type BuiltinSfxCue } from "../sound-effects/mix.js";
import { buildSegmentRenderArgs } from "./graph.js";
import { checkSegmentPlan, planOutputFrames, type SegmentPlan } from "./plan.js";

const execFileAsync = promisify(execFile);
const FRAME_COUNT_TIMEOUT_MS = 600_000;
const VARIABLE_RATE_TOLERANCE = 0.01;
const AUDIO_SYNC_EPSILON_SECONDS = 0.002;
const SFX_SCRATCH_PREFIX = "videobook-auto-edit-sfx-";

export interface SegmentRenderResult {
  probe: ProbeResult;
  frames: number;
}

export function isVariableFrameRate(probe: ProbeResult): boolean {
  return probe.avgFps !== null
    && Math.abs(probe.avgFps - probe.fps) > probe.fps * VARIABLE_RATE_TOLERANCE;
}

async function countVideoFrames(path: string, signal?: AbortSignal): Promise<number> {
  const { stdout } = await execFileAsync(
    FFPROBE,
    [
      "-v", "error",
      "-select_streams", "v:0",
      "-count_frames",
      "-show_entries", "stream=nb_read_frames",
      "-of", "csv=p=0",
      path,
    ],
    { signal, timeout: FRAME_COUNT_TIMEOUT_MS, killSignal: "SIGKILL" },
  );
  const count = Number.parseInt(stdout.trim(), 10);
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new Error(`Could not count the video frames of ${basename(path)}`);
  }
  return count;
}

export async function validateSegmentOutput(
  plan: SegmentPlan,
  outputPath: string,
  signal?: AbortSignal,
  options?: { expectAudio?: boolean },
): Promise<SegmentRenderResult> {
  const probe = await probeVideo(outputPath, { signal });
  if (probe.videoCodec === null) {
    throw new Error("Auto-edit output has no video stream");
  }
  if (probe.width !== plan.source.width || probe.height !== plan.source.height) {
    throw new Error(
      `Auto-edit output is ${probe.width}x${probe.height}; the plan expects ${plan.source.width}x${plan.source.height}`,
    );
  }
  const expectedFrames = planOutputFrames(plan);
  const frames = await countVideoFrames(outputPath, signal);
  if (frames !== expectedFrames) {
    throw new Error(`Auto-edit output has ${frames} frames; the plan expects ${expectedFrames}`);
  }
  const expectAudio = options?.expectAudio ?? plan.source.hasAudio;
  if (expectAudio) {
    if (!probe.hasAudio || probe.audioDuration === null) {
      throw new Error("Auto-edit output has no sound stream");
    }
    const maxDrift = 1 / plan.source.fps + AUDIO_SYNC_EPSILON_SECONDS;
    if (Math.abs(probe.audioDuration - probe.videoDuration) > maxDrift) {
      throw new Error(
        `Auto-edit output sound lasts ${probe.audioDuration.toFixed(3)} s; the picture lasts ${probe.videoDuration.toFixed(3)} s`,
      );
    }
  } else if (probe.hasAudio) {
    throw new Error("Auto-edit output gained an unexpected sound stream");
  }
  return { probe, frames };
}

export async function renderSegmentPlan(
  plan: SegmentPlan,
  sourcePath: string,
  outputPath: string,
  signal?: AbortSignal,
  options?: { cues?: readonly BuiltinSfxCue[] },
): Promise<SegmentRenderResult> {
  const issues = checkSegmentPlan(plan);
  if (issues.length > 0) {
    throw new Error(issues[0]!.message);
  }
  signal?.throwIfAborted();
  const cues = options?.cues ?? [];
  let sfxScratch: string | null = null;
  try {
    const sourceProbe = await probeVideo(sourcePath, { signal });
    signal?.throwIfAborted();
    let cuePaths: string[] | undefined;
    if (cues.length > 0) {
      sfxScratch = await mkdtemp(join(tmpdir(), SFX_SCRATCH_PREFIX));
      cuePaths = await writeBuiltinSfxFiles(sfxScratch, cues);
    }
    const args = buildSegmentRenderArgs(plan, {
      inputPath: sourcePath,
      outputPath,
      variableFrameRate: isVariableFrameRate(sourceProbe),
      cues,
      cuePaths,
    });
    await runFfmpeg(args, { signal });
    signal?.throwIfAborted();
    return await validateSegmentOutput(plan, outputPath, signal, {
      expectAudio: plan.source.hasAudio || cues.length > 0,
    });
  } catch (error) {
    await rm(outputPath, { force: true });
    throw error;
  } finally {
    if (sfxScratch) await rm(sfxScratch, { recursive: true, force: true });
  }
}
