import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FFMPEG, FFPROBE, probeVideo, type ProbeResult } from "../ffmpeg.js";
import { builtinSound } from "../sound-effects/catalog.js";
import { testBudget } from "../test-budget.js";
import { zoomWindowAt, type ZoomPlan, type ZoomWindow } from "../zoom.js";
import {
  checkZoomSounds,
  hasVariableFrameRate,
  renderZoomedVideo,
  validateZoomOutput,
  zoomPlanFor,
  zoomSoundCues,
  type ZoomRequest,
} from "./zoom-video.js";

const execFileAsync = promisify(execFile);
const WIDTH = 324;
const HEIGHT = 576;
const FPS = 30;
const SECONDS = 4;
const SAMPLE_RATE = 48_000;
const FULL_FRAME: ZoomWindow = { scale: 1, x: 0, y: 0, width: 1, height: 1 };
const SOURCE_VIDEO = ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "12", "-pix_fmt", "yuv420p"];

function source(probe: Partial<ProbeResult>): ProbeResult {
  return {
    width: WIDTH, height: HEIGHT, duration: SECONDS, videoDuration: SECONDS, audioDuration: null,
    fps: FPS, avgFps: FPS, hasAudio: false, videoCodec: "h264", audioCodec: null, videoStream: null, audioStream: null,
    ...probe,
  };
}

async function ffmpeg(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(FFMPEG, ["-hide_banner", "-v", "error", "-y", ...args], { maxBuffer: 16 * 1024 * 1024, timeout: testBudget(60_000) });
  return stdout;
}

async function ffmpegBytes(args: string[]): Promise<Buffer> {
  const { stdout } = await execFileAsync(FFMPEG, ["-hide_banner", "-v", "error", ...args], {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
    timeout: testBudget(60_000),
  });
  return stdout;
}

async function audioPacketsHash(path: string): Promise<string> {
  return (await ffmpeg(["-i", path, "-map", "0:a", "-c", "copy", "-f", "md5", "pipe:1"])).trim();
}

async function samples(path: string): Promise<Float32Array> {
  const bytes = await ffmpegBytes(["-i", path, "-map", "0:a", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "f32le", "pipe:1"]);
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

function loudestWindowStart(pcm: Float32Array): number {
  const window = SAMPLE_RATE / 100;
  let energy = 0;
  let peak = 0;
  let start = 0;
  for (let index = 0; index < pcm.length; index += 1) {
    energy += pcm[index]! ** 2;
    if (index >= window) energy -= pcm[index - window]! ** 2;
    if (index >= window - 1 && energy > peak) {
      peak = energy;
      start = index - window + 1;
    }
  }
  return start / SAMPLE_RATE;
}

function onsetSeconds(pcm: Float32Array, threshold: number): number {
  return pcm.findIndex((sample) => Math.abs(sample) > threshold) / SAMPLE_RATE;
}

function cropBack(window: ZoomWindow): string {
  const [width, height, x, y] = [window.width * WIDTH, window.height * HEIGHT, window.x * WIDTH, window.y * HEIGHT];
  return `crop=${Math.round(width)}:${Math.round(height)}:${Math.round(x)}:${Math.round(y)},scale=${WIDTH}:${HEIGHT}:flags=bicubic`;
}

async function frameSsim(rendered: string, frame: number, original: string, window: ZoomWindow = FULL_FRAME): Promise<number> {
  const pick = `select='eq(n,${frame})',format=gray,setpts=PTS-STARTPTS`;
  const reference = window === FULL_FRAME ? pick : `${pick},${cropBack(window)}`;
  const stats = await ffmpeg([
    "-i", rendered,
    "-i", original,
    "-filter_complex", `[0:v]${pick}[rendered];[1:v]${reference}[reference];[rendered][reference]ssim=stats_file=-`,
    "-f", "null", "-",
  ]);
  const score = /All:([\d.]+)/u.exec(stats);
  if (!score) throw new Error(`ssim printed no score: ${stats}`);
  return Number(score[1]);
}

async function videoShape(path: string): Promise<Record<string, unknown>> {
  const { stdout } = await execFileAsync(FFPROBE, [
    "-v", "error",
    "-select_streams", "v:0",
    "-count_frames",
    "-show_entries", "stream=width,height,r_frame_rate,nb_read_frames",
    "-of", "json",
    path,
  ]);
  return (JSON.parse(stdout) as { streams: Record<string, unknown>[] }).streams[0]!;
}

async function truncateToHeader(from: string, to: string): Promise<void> {
  const bytes = await readFile(from);
  let offset = 0;
  while (offset < bytes.length) {
    const size = bytes.readUInt32BE(offset);
    if (bytes.toString("latin1", offset + 4, offset + 8) === "mdat") break;
    offset += size;
  }
  await writeFile(to, bytes.subarray(0, offset + 72));
}

describe("zoom plan sounds", () => {
  const plan = (zooms: ZoomRequest[]): ZoomPlan => zoomPlanFor(source({}), zooms);

  it("lands the way-in sound's accent at full scale and starts the return sound as the way back begins", () => {
    const zooms: ZoomRequest[] = [{ start_seconds: 1, end_seconds: 2.5, scale: 1.5, sound: "zoom_in", return_sound: "zoom_out" }];
    const cues = zoomSoundCues(plan(zooms), zooms);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({ sound: "zoom_in", gain: 0.7 });
    expect(cues[0]!.startSeconds + builtinSound("zoom_in").accentSeconds).toBeCloseTo(1.3, 9);
    expect(cues[1]).toMatchObject({ sound: "zoom_out", gain: 0.7 });
    expect(cues[1]!.startSeconds).toBeCloseTo(2.2, 9);
  });

  it("starts an early cue at 0, keeps request order after sorting, and drops cues at the end", () => {
    const zooms: ZoomRequest[] = [
      { start_seconds: 3, end_seconds: 4, ramp_out_seconds: 0, return_sound: "pop" },
      { start_seconds: 0, end_seconds: 1, ramp_in_seconds: 0.1, sound: "zoom_in" },
    ];
    const cues = zoomSoundCues(plan(zooms), zooms);
    expect(cues).toEqual([{ sound: "zoom_in", startSeconds: 0, gain: 0.7 }]);
  });

  it("plays no return sound for a zoom that stays to the end", () => {
    const zooms: ZoomRequest[] = [{ start_seconds: 1, sound: "whoosh", return_sound: "zoom_out" }];
    expect(zoomSoundCues(plan(zooms), zooms).map((cue) => cue.sound)).toEqual(["whoosh"]);
  });

  it("rejects a return sound on a zoom with no end and says what to change", () => {
    expect(() => checkZoomSounds([{ start_seconds: 0, end_seconds: 1 }, { start_seconds: 2, return_sound: "zoom_out" }]))
      .toThrow(/Zoom 2 has a return_sound but no end_seconds.*Give it an end_seconds, or leave return_sound out/u);
    expect(() => checkZoomSounds([{ start_seconds: 0, end_seconds: 1, return_sound: "zoom_out" }])).not.toThrow();
  });

  it("treats a source as variable frame rate when its average rate is more than 1% off", () => {
    expect(hasVariableFrameRate(source({ avgFps: 29.9 }))).toBe(false);
    expect(hasVariableFrameRate(source({ avgFps: 24 }))).toBe(true);
    expect(hasVariableFrameRate(source({ avgFps: null }))).toBe(false);
  });
});

describe("zoom video rendering", () => {
  let dir = "";
  let pattern = "";
  let silent = "";
  let pcm = "";

  async function render(input: string, zooms: ZoomRequest[], name: string): Promise<{ output: string; plan: ZoomPlan; mode: string }> {
    const probe = await probeVideo(input);
    const plan = zoomPlanFor(probe, zooms);
    const cues = zoomSoundCues(plan, zooms);
    const output = join(dir, `${name}.mp4`);
    const mode = await renderZoomedVideo({ inputPath: input, outputPath: output, scratchDir: dir, source: probe, plan, cues });
    await validateZoomOutput({ source: probe, inputPath: input, outputPath: output, plan, audio: mode });
    return { output, plan, mode };
  }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "videobook-zoom-job-"));
    pattern = join(dir, "pattern.mp4");
    silent = join(dir, "silent.mp4");
    pcm = join(dir, "pcm.mov");
    await ffmpeg([
      "-f", "lavfi", "-i", `testsrc2=size=${WIDTH}x${HEIGHT}:rate=${FPS}:duration=${SECONDS}`,
      "-f", "lavfi", "-i", `anoisesrc=color=pink:amplitude=0.05:seed=1:duration=${SECONDS}:sample_rate=${SAMPLE_RATE}`,
      ...SOURCE_VIDEO, "-c:a", "aac", "-shortest", pattern,
    ]);
    await ffmpeg(["-i", pattern, "-map", "0:v", "-c", "copy", silent]);
    await ffmpeg(["-i", pattern, "-c:v", "copy", "-c:a", "pcm_s16le", pcm]);
  }, testBudget(60_000));

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("zooms in place, keeping the shape, the picture outside the zoom and the sound's packets", async () => {
    const { output, plan, mode } = await render(pattern, [{ start_seconds: 1, end_seconds: 2.5, scale: 1.5 }], "one-zoom");
    expect(mode).toBe("copy");
    expect(await videoShape(output)).toEqual(await videoShape(pattern));
    expect(await audioPacketsHash(output)).toBe(await audioPacketsHash(pattern));
    const hold = 52;
    const [before, held, after, unzoomed] = await Promise.all([
      frameSsim(output, 15, pattern),
      frameSsim(output, hold, pattern, zoomWindowAt(plan, hold / FPS)),
      frameSsim(output, 90, pattern),
      frameSsim(output, hold, pattern),
    ]);
    expect(before).toBeGreaterThanOrEqual(0.97);
    expect(held).toBeGreaterThanOrEqual(0.96);
    expect(after).toBeGreaterThanOrEqual(0.97);
    expect(unzoomed).toBeLessThan(0.8);
  }, testBudget(60_000));

  it("lands two zooms toward their own focus points in one render", async () => {
    const { output, plan } = await render(pattern, [
      { start_seconds: 2.5, end_seconds: 3.5, scale: 1.5, focus_x: 1, focus_y: 0, ramp_in_seconds: 0, ramp_out_seconds: 0 },
      { start_seconds: 0.5, end_seconds: 1.5, scale: 2, focus_x: 0.5, focus_y: 0.25, ramp_in_seconds: 0, ramp_out_seconds: 0 },
    ], "two-zooms");
    const [first, between, second] = await Promise.all([
      frameSsim(output, 30, pattern, zoomWindowAt(plan, 30 / FPS)),
      frameSsim(output, 60, pattern),
      frameSsim(output, 90, pattern, zoomWindowAt(plan, 90 / FPS)),
    ]);
    expect(zoomWindowAt(plan, 1).scale).toBe(2);
    expect(zoomWindowAt(plan, 3).scale).toBe(1.5);
    expect(first).toBeGreaterThanOrEqual(0.96);
    expect(between).toBeGreaterThanOrEqual(0.97);
    expect(second).toBeGreaterThanOrEqual(0.96);
  }, testBudget(60_000));

  it("re-encodes a sound that is not AAC and keeps a silent source silent", async () => {
    const [converted, quiet] = await Promise.all([
      render(pcm, [{ start_seconds: 1, end_seconds: 2 }], "pcm"),
      render(silent, [{ start_seconds: 1, end_seconds: 2 }], "quiet"),
    ]);
    expect(converted.mode).toBe("aac");
    expect((await probeVideo(converted.output)).audioCodec).toBe("aac");
    expect(quiet.mode).toBe("none");
    expect((await probeVideo(quiet.output)).hasAudio).toBe(false);
  }, testBudget(60_000));

  it("mixes the zoom-in sound so its accent lands as the zoom reaches full scale", async () => {
    const { output, plan, mode } = await render(pattern, [{ start_seconds: 1, end_seconds: 2.5, scale: 1.5, sound: "zoom_in" }], "zoom-in-sound");
    expect(mode).toBe("mix");
    const fullScale = plan.zooms[0]!.startSeconds + plan.zooms[0]!.rampInSeconds;
    expect(Math.abs(loudestWindowStart(await samples(output)) - fullScale)).toBeLessThanOrEqual(0.03);
    const [before, after] = await Promise.all([probeVideo(pattern), probeVideo(output)]);
    expect(Math.abs(after.duration - before.duration)).toBeLessThanOrEqual(1 / FPS);
  }, testBudget(60_000));

  it("starts the return sound as the way back begins, over a silent bed for a silent source", async () => {
    const { output, plan, mode } = await render(silent, [{ start_seconds: 1, end_seconds: 2.5, return_sound: "zoom_out" }], "return-sound");
    expect(mode).toBe("mix");
    const wayBack = plan.zooms[0]!.endSeconds! - plan.zooms[0]!.rampOutSeconds;
    const onset = onsetSeconds(await samples(output), 0.0001);
    expect(onset).toBeGreaterThanOrEqual(wayBack - 0.005);
    expect(onset).toBeLessThanOrEqual(wayBack + 0.015);
    const probe = await probeVideo(output);
    expect(probe.audioDuration!).toBeLessThanOrEqual(probe.videoDuration + 0.001);
    expect(probe.audioDuration!).toBeGreaterThan(probe.videoDuration - 0.05);
  }, testBudget(60_000));

  it("keeps a rotated source upright at its display size", async () => {
    const rotated = join(dir, "rotated.mp4");
    await ffmpeg(["-display_rotation:v:0", "90", "-i", silent, "-c", "copy", rotated]);
    expect(Math.abs((await probeVideo(rotated)).videoStream?.video?.rotationDegrees ?? 0)).toBe(90);
    const { output } = await render(rotated, [{ start_seconds: 1, end_seconds: 2 }], "rotated-zoom");
    const probe = await probeVideo(output);
    expect([probe.width, probe.height]).toEqual([HEIGHT, WIDTH]);
  }, testBudget(60_000));

  it("rejects an output that does not match the source", async () => {
    const short = join(dir, "short.mp4");
    await ffmpeg(["-i", silent, "-frames:v", "60", "-c", "copy", short]);
    const { output, plan } = await render(silent, [{ start_seconds: 1, end_seconds: 2 }], "mismatch");
    const shortProbe = await probeVideo(short);
    await expect(validateZoomOutput({ source: shortProbe, inputPath: short, outputPath: output, plan, audio: "none" }))
      .rejects.toThrow("Zoom output has 120 frames; the source has 60");
    await expect(validateZoomOutput({ source: { ...shortProbe, width: 320 }, inputPath: silent, outputPath: output, plan, audio: "none" }))
      .rejects.toThrow("Zoom output is 324x576; the source is 320x576");
    await expect(validateZoomOutput({ source: shortProbe, inputPath: silent, outputPath: output, plan, audio: "copy" }))
      .rejects.toThrow("Zoom output has no sound stream");
  }, testBudget(60_000));

  it("fails on a damaged source", async () => {
    const damaged = join(dir, "damaged.mp4");
    const faststart = join(dir, "faststart.mp4");
    await ffmpeg(["-i", pattern, "-c", "copy", "-movflags", "+faststart", faststart]);
    await truncateToHeader(faststart, damaged);
    const probe = await probeVideo(damaged);
    const zooms: ZoomRequest[] = [{ start_seconds: 1, end_seconds: 2 }];
    const plan = zoomPlanFor(probe, zooms);
    await expect(renderZoomedVideo({ inputPath: damaged, outputPath: join(dir, "damaged-zoom.mp4"), scratchDir: dir, source: probe, plan, cues: [] }))
      .rejects.toThrow(/ffmpeg failed/u);
  }, testBudget(60_000));
});
