import type { Engine } from "videobook-engine";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { AUDIO_OPTS, FFPROBE, H264_MEDIUM, probeVideo, runFfmpeg, type ProbeResult } from "../ffmpeg.js";
import { queue, registerJobHandler } from "../queue.js";
import { builtinSound, type BuiltinSoundId } from "../sound-effects/catalog.js";
import { buildBuiltinSfxFilter, writeBuiltinSfxFiles, type BuiltinSfxCue } from "../sound-effects/mix.js";
import { PICTURE_SIDECARS, SOUND_SIDECARS } from "../stale-sidecars.js";
import { buildZoomVideoFilter, createZoomPlan, type ResolvedZoom, type ZoomInput, type ZoomPlan } from "../zoom.js";
import { withLockedLocalLease } from "./_lease.js";
import { replaceArtifactFileFromPath } from "./_persist-output.js";

const execFileAsync = promisify(execFile);

const LOCK_DURATION_MS = 1_800_000;
const FRAME_COUNT_TIMEOUT_MS = 600_000;
const SCRATCH_PREFIX = "videobook-zoom-render-";
const SOUND_GAIN = 0.7;
const LATE_CUE_SECONDS = 0.05;
const VARIABLE_RATE_TOLERANCE = 0.01;
const VARIABLE_RATE_FRAMES = 2;

export type ZoomRequest = ZoomInput & {
  sound?: BuiltinSoundId;
  return_sound?: BuiltinSoundId;
};

type ZoomRecord = {
  start_seconds: number;
  end_seconds: number | null;
  scale: number;
  focus_x: number;
  focus_y: number;
  ramp_in_seconds: number;
  ramp_out_seconds: number;
  sound?: BuiltinSoundId;
  return_sound?: BuiltinSoundId;
};

type ZoomSoundRecord = {
  sound: BuiltinSoundId;
  start_seconds: number;
};

export type ZoomVideoResult = {
  zooms: ZoomRecord[];
  sounds: ZoomSoundRecord[];
};

type ZoomAudioMode = "copy" | "aac" | "mix" | "none";

type ZoomVideoPayload = {
  type: "zoom_video";
  inputPath: string;
  zooms: ZoomRequest[];
  assetId: string;
  assetDir: string;
  bookId: string;
};

type ZoomRender = {
  inputPath: string;
  outputPath: string;
  scratchDir: string;
  source: ProbeResult;
  plan: ZoomPlan;
  cues: readonly BuiltinSfxCue[];
  signal?: AbortSignal;
};

type ZoomOutputCheck = {
  source: ProbeResult;
  inputPath: string;
  outputPath: string;
  plan: ZoomPlan;
  audio: ZoomAudioMode;
  signal?: AbortSignal;
};

function rounded(seconds: number): number {
  return Number(seconds.toFixed(6));
}

function videoDurationOf(source: ProbeResult): number {
  return source.videoDuration > 0 ? source.videoDuration : source.duration;
}

export function hasVariableFrameRate(source: ProbeResult): boolean {
  return source.avgFps !== null && Math.abs(source.avgFps - source.fps) > source.fps * VARIABLE_RATE_TOLERANCE;
}

export function zoomPlanFor(source: ProbeResult, zooms: readonly ZoomInput[]): ZoomPlan {
  return createZoomPlan({ sourceDuration: videoDurationOf(source), sourceFps: source.fps, zooms: [...zooms] });
}

export function checkZoomSounds(zooms: readonly ZoomRequest[]): void {
  zooms.forEach((zoom, index) => {
    if (zoom.return_sound !== undefined && zoom.end_seconds === undefined) {
      throw new Error(`Zoom ${index + 1} has a return_sound but no end_seconds, so it never returns. Give it an end_seconds, or leave return_sound out.`);
    }
  });
}

function zoomCues(zoom: ResolvedZoom, request: ZoomRequest): BuiltinSfxCue[] {
  const wayIn = request.sound === undefined ? [] : [{
    sound: request.sound,
    startSeconds: Math.max(0, zoom.startSeconds + zoom.rampInSeconds - builtinSound(request.sound).accentSeconds),
    gain: SOUND_GAIN,
  }];
  const wayBack = request.return_sound === undefined || zoom.endSeconds === null ? [] : [{
    sound: request.return_sound,
    startSeconds: zoom.endSeconds - zoom.rampOutSeconds,
    gain: SOUND_GAIN,
  }];
  return [...wayIn, ...wayBack];
}

export function zoomSoundCues(plan: ZoomPlan, zooms: readonly ZoomRequest[]): BuiltinSfxCue[] {
  return plan.zooms
    .flatMap((zoom) => zoomCues(zoom, zooms[zoom.index]!))
    .filter((cue) => cue.startSeconds < plan.sourceDuration - LATE_CUE_SECONDS);
}

function zoomRecord(zoom: ResolvedZoom, request: ZoomRequest): ZoomRecord {
  return {
    start_seconds: rounded(zoom.startSeconds),
    end_seconds: zoom.endSeconds === null ? null : rounded(zoom.endSeconds),
    scale: zoom.scale,
    focus_x: zoom.focusX,
    focus_y: zoom.focusY,
    ramp_in_seconds: rounded(zoom.rampInSeconds),
    ramp_out_seconds: rounded(zoom.rampOutSeconds),
    ...(request.sound === undefined ? {} : { sound: request.sound }),
    ...(request.return_sound === undefined ? {} : { return_sound: request.return_sound }),
  };
}

function zoomResult(plan: ZoomPlan, zooms: readonly ZoomRequest[], cues: readonly BuiltinSfxCue[]): ZoomVideoResult {
  return {
    zooms: plan.zooms.map((zoom) => zoomRecord(zoom, zooms[zoom.index]!)),
    sounds: cues.map((cue) => ({ sound: cue.sound, start_seconds: rounded(cue.startSeconds) })),
  };
}

function pictureGraph(render: ZoomRender): string {
  const filter = buildZoomVideoFilter(render.plan, { variableFrameRate: hasVariableFrameRate(render.source) });
  return `[0:v:0]${filter}[vout]`;
}

function encodeArgs(render: ZoomRender): string[] {
  return [...H264_MEDIUM, "-r", String(render.plan.sourceFps), "-movflags", "+faststart", "-f", "mp4", render.outputPath];
}

function pictureArgs(render: ZoomRender, audio: Exclude<ZoomAudioMode, "mix">): string[] {
  const sound = audio === "none" ? ["-an"] : ["-map", "0:a:0", ...(audio === "copy" ? ["-c:a", "copy"] : AUDIO_OPTS)];
  return ["-y", "-i", render.inputPath, "-filter_complex", pictureGraph(render), "-map", "[vout]", ...sound, ...encodeArgs(render)];
}

async function mixArgs(render: ZoomRender): Promise<string[]> {
  const soundPaths = await writeBuiltinSfxFiles(render.scratchDir, render.cues);
  const sound = buildBuiltinSfxFilter(render.cues, render.source.hasAudio, render.plan.sourceDuration);
  return [
    "-y",
    "-i", render.inputPath,
    ...soundPaths.flatMap((path) => ["-i", path]),
    "-filter_complex", `${pictureGraph(render)};${sound}`,
    "-map", "[vout]",
    "-map", "[outa]",
    ...AUDIO_OPTS,
    ...encodeArgs(render),
  ];
}

export async function renderZoomedVideo(render: ZoomRender): Promise<ZoomAudioMode> {
  const options = { signal: render.signal };
  if (render.cues.length > 0) {
    await runFfmpeg(await mixArgs(render), options);
    return "mix";
  }
  if (!render.source.hasAudio) {
    await runFfmpeg(pictureArgs(render, "none"), options);
    return "none";
  }
  if (render.source.audioCodec !== "aac") {
    await runFfmpeg(pictureArgs(render, "aac"), options);
    return "aac";
  }
  try {
    await runFfmpeg(pictureArgs(render, "copy"), options);
    return "copy";
  } catch {
    await runFfmpeg(pictureArgs(render, "aac"), options);
    return "aac";
  }
}

async function videoFrameCount(path: string, signal?: AbortSignal): Promise<number> {
  const { stdout } = await execFileAsync(FFPROBE, [
    "-v", "error",
    "-select_streams", "v:0",
    "-count_frames",
    "-show_entries", "stream=nb_read_frames",
    "-of", "csv=p=0",
    path,
  ], { signal, timeout: FRAME_COUNT_TIMEOUT_MS, killSignal: "SIGKILL" });
  const count = Number.parseInt(stdout.trim(), 10);
  if (!Number.isSafeInteger(count) || count <= 0) throw new Error(`Could not count the video frames of ${basename(path)}`);
  return count;
}

function displaySize(probe: ProbeResult): { width: number; height: number } {
  const quarterTurn = Math.abs(probe.videoStream?.video?.rotationDegrees ?? 0) % 180 === 90;
  return quarterTurn ? { width: probe.height, height: probe.width } : { width: probe.width, height: probe.height };
}

async function checkFrames(check: ZoomOutputCheck, output: ProbeResult): Promise<void> {
  if (hasVariableFrameRate(check.source)) {
    const drift = Math.abs(output.videoDuration - check.plan.sourceDuration);
    if (drift > VARIABLE_RATE_FRAMES / check.plan.sourceFps) {
      throw new Error(`Zoom output lasts ${output.videoDuration.toFixed(3)} s; the source lasts ${check.plan.sourceDuration.toFixed(3)} s`);
    }
    return;
  }
  const [sourceFrames, frames] = await Promise.all([
    videoFrameCount(check.inputPath, check.signal),
    videoFrameCount(check.outputPath, check.signal),
  ]);
  if (frames !== sourceFrames) {
    throw new Error(`Zoom output has ${frames} frames; the source has ${sourceFrames}`);
  }
}

export async function validateZoomOutput(check: ZoomOutputCheck): Promise<void> {
  const output = await probeVideo(check.outputPath, { signal: check.signal });
  if (output.videoCodec === null) throw new Error("Zoom output has no video stream");
  const source = displaySize(check.source);
  if (output.width !== source.width || output.height !== source.height) {
    throw new Error(`Zoom output is ${output.width}x${output.height}; the source is ${source.width}x${source.height}`);
  }
  await checkFrames(check, output);
  const wantsSound = check.audio !== "none";
  if (output.hasAudio !== wantsSound) {
    throw new Error(wantsSound ? "Zoom output has no sound stream" : "Zoom output gained a sound stream");
  }
}

async function deleteIfPresent(engine: Engine, assetId: string, filename: string): Promise<void> {
  const result = await engine.files.delete(assetId, filename);
  if (!result.ok && result.error.code !== "NOT_FOUND") {
    throw new Error(`Failed to delete ${filename}: ${result.error.message}`);
  }
}

async function replaceInPlace(
  engine: Engine,
  assetId: string,
  inputPath: string,
  outputPath: string,
  staleSidecars: readonly string[],
): Promise<void> {
  const restoreCommit = engine.history.artifact(assetId)[0]?.hash;
  try {
    await replaceArtifactFileFromPath(engine, assetId, basename(inputPath), outputPath);
    for (const filename of staleSidecars) await deleteIfPresent(engine, assetId, filename);
  } catch (error) {
    if (restoreCommit) await engine.history.restoreArtifact(assetId, restoreCommit);
    throw error;
  }
}

async function zoomInPlace(engine: Engine, job: ZoomVideoPayload, signal: AbortSignal): Promise<ZoomVideoResult> {
  const source = await probeVideo(job.inputPath, { signal });
  const plan = zoomPlanFor(source, job.zooms);
  const cues = zoomSoundCues(plan, job.zooms);
  const scratchDir = await mkdtemp(join(tmpdir(), SCRATCH_PREFIX));
  try {
    const outputPath = join(scratchDir, "zoomed.mp4");
    const audio = await renderZoomedVideo({ inputPath: job.inputPath, outputPath, scratchDir, source, plan, cues, signal });
    await validateZoomOutput({ source, inputPath: job.inputPath, outputPath, plan, audio, signal });
    await replaceInPlace(engine, job.assetId, job.inputPath, outputPath, cues.length > 0 ? SOUND_SIDECARS : PICTURE_SIDECARS);
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
  return zoomResult(plan, job.zooms, cues);
}

function reprocessOptions(result: ZoomVideoResult): Record<string, boolean> {
  if (result.sounds.length > 0) return { force: true };
  return { force: true, skipDownstreamJobs: true, preserveAudioArtifacts: true, reviveVisualAnalysis: true };
}

export function registerZoomVideoJob(engine: Engine): void {
  registerJobHandler("zoom_video", async (payload, ctx) => {
    const job = payload as unknown as ZoomVideoPayload;
    const result = await withLockedLocalLease(
      engine,
      job.assetId,
      job.assetDir,
      ctx,
      "crop",
      { durationMs: LOCK_DURATION_MS, data: { state: "zooming" } },
      () => zoomInPlace(engine, job, ctx.signal),
      { durationMs: LOCK_DURATION_MS, waitForActiveMs: 30_000 },
    );
    await queue.enqueue(`process-video-${job.assetId}-${Date.now()}`, {
      type: "process_video",
      videoPath: join(job.assetDir, basename(job.inputPath)),
      assetId: job.assetId,
      assetDir: job.assetDir,
      bookId: job.bookId,
      provenance: { origin: "zoom", zooms: result.zooms, zoomed_at: new Date().toISOString() },
      ...reprocessOptions(result),
    });
    return result;
  });
}
