import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FFMPEG, FFPROBE, probeVideo } from "./ffmpeg.js";
import { testBudget } from "./test-budget.js";
import {
  buildZoomVideoFilter,
  createZoomPlan,
  zoomScaleAt,
  zoomWindowAt,
  type ZoomInput,
  type ZoomPlan,
  type ZoomWindow,
} from "./zoom.js";

const execFileAsync = promisify(execFile);
const WIDTH = 324;
const HEIGHT = 576;
const FPS = 30;
const SECONDS = 4;
const FRAMES = FPS * SECONDS;
const BAR_LEFT = 150;
const BAR_WIDTH = 40;
const ROW_BAND = 64;
const EDGE_REACH = 16;
const LOSSLESS = ["-c:v", "libx264", "-preset", "ultrafast", "-qp", "0", "-pix_fmt", "yuv420p", "-an"];
const FULL_FRAME: ZoomWindow = { scale: 1, x: 0, y: 0, width: 1, height: 1 };

function plan(zooms: ZoomInput[], sourceDuration = SECONDS, sourceFps = FPS): ZoomPlan {
  return createZoomPlan({ sourceDuration, sourceFps, zooms });
}

describe("createZoomPlan", () => {
  it("applies the defaults", () => {
    expect(plan([{ start_seconds: 1, end_seconds: 3 }])).toEqual({
      sourceDuration: 4,
      sourceFps: 30,
      frameCount: 120,
      zooms: [{
        index: 0,
        startSeconds: 1,
        endSeconds: 3,
        scale: 1.3,
        focusX: 0.5,
        focusY: 0.5,
        rampInSeconds: 0.3,
        rampOutSeconds: 0.3,
      }],
    });
  });

  it("accepts the limits of scale, focus and ramps", () => {
    const [low, high] = plan([
      { start_seconds: 0, end_seconds: 10, scale: 1.05, focus_x: 0, focus_y: 1, ramp_in_seconds: 0, ramp_out_seconds: 5 },
      { start_seconds: 10, end_seconds: 20, scale: 3, focus_x: 1, focus_y: 0, ramp_in_seconds: 5, ramp_out_seconds: 0 },
    ], 20).zooms;
    expect(low).toMatchObject({ scale: 1.05, focusX: 0, focusY: 1, rampInSeconds: 0, rampOutSeconds: 5 });
    expect(high).toMatchObject({ scale: 3, focusX: 1, focusY: 0, rampInSeconds: 5, rampOutSeconds: 0 });
  });

  it.each([
    { name: "a scale below 1.05", zoom: { start_seconds: 1, scale: 1.04 }, message: "Zoom 1 scale must be from 1.05 to 3; got 1.04" },
    { name: "a scale above 3", zoom: { start_seconds: 1, scale: 3.5 }, message: "Zoom 1 scale must be from 1.05 to 3; got 3.5" },
    { name: "a focus left of the picture", zoom: { start_seconds: 1, focus_x: -0.1 }, message: "Zoom 1 focus_x must be from 0 (left edge) to 1 (right edge); got -0.1" },
    { name: "a focus below the picture", zoom: { start_seconds: 1, focus_y: 1.2 }, message: "Zoom 1 focus_y must be from 0 (top edge) to 1 (bottom edge); got 1.2" },
    { name: "a negative way in", zoom: { start_seconds: 1, ramp_in_seconds: -0.1 }, message: "Zoom 1 ramp_in_seconds must be from 0 (a hard cut) to 5; got -0.1" },
    { name: "a way back over 5 s", zoom: { start_seconds: 1, end_seconds: 2, ramp_out_seconds: 5.5 }, message: "Zoom 1 ramp_out_seconds must be from 0 (a hard cut) to 5; got 5.5" },
    { name: "a way back over 5 s on a zoom with no end", zoom: { start_seconds: 1, ramp_out_seconds: 6 }, message: "Zoom 1 ramp_out_seconds must be from 0 (a hard cut) to 5; got 6" },
    { name: "a negative start", zoom: { start_seconds: -0.5 }, message: "Zoom 1 start_seconds must be 0 or more; got -0.5" },
    { name: "a start on the clip's end", zoom: { start_seconds: 3.99 }, message: "Zoom 1 starts at 3.99 s, but the clip's last frame is at 3.967 s. Start at least one frame before the end." },
    { name: "an end at the start", zoom: { start_seconds: 2, end_seconds: 2 }, message: "Zoom 1 ends at 2 s, which is not after its start at 2 s." },
    { name: "an end before the start", zoom: { start_seconds: 2, end_seconds: 1 }, message: "Zoom 1 ends at 1 s, which is not after its start at 2 s." },
    { name: "a zoom one frame long", zoom: { start_seconds: 1, end_seconds: 1.04 }, message: "Zoom 1 lasts 1 frame after snapping to the clip's 30 fps; a zoom needs at least 2 frames (0.067 s)." },
    { name: "a zoom that starts on the last frame", zoom: { start_seconds: 3.96 }, message: "Zoom 1 lasts 1 frame" },
    { name: "a start that is not a number", zoom: { start_seconds: Number.NaN }, message: "Zoom 1 start_seconds must be a number" },
    { name: "an end that is not a number", zoom: { start_seconds: 1, end_seconds: Number.POSITIVE_INFINITY }, message: "Zoom 1 end_seconds must be a number" },
    { name: "a scale that is not a number", zoom: { start_seconds: 1, scale: Number.NaN }, message: "Zoom 1 scale must be a number" },
  ])("rejects $name", ({ zoom, message }) => {
    expect(() => plan([zoom])).toThrow(message);
  });

  it("takes one to eight zooms", () => {
    const zooms = Array.from({ length: 9 }, (_, index) => ({ start_seconds: index * 0.4, end_seconds: index * 0.4 + 0.3 }));
    expect(plan(zooms.slice(0, 8)).zooms).toHaveLength(8);
    expect(() => plan(zooms)).toThrow("Give from 1 to 8 zooms; got 9");
    expect(() => plan([])).toThrow("Give from 1 to 8 zooms; got 0");
  });

  it.each([
    { name: "a zero duration", duration: 0, fps: 30, message: "The clip's duration must be greater than zero" },
    { name: "a duration that is not a number", duration: Number.NaN, fps: 30, message: "The clip's duration must be a number" },
    { name: "a zero frame rate", duration: 4, fps: 0, message: "The clip's frame rate must be greater than zero" },
    { name: "a single frame", duration: 0.04, fps: 30, message: "The clip is too short to zoom: a zoom needs at least 2 frames" },
  ])("rejects a clip with $name", ({ duration, fps, message }) => {
    expect(() => plan([{ start_seconds: 0 }], duration, fps)).toThrow(message);
  });

  it("clamps an end past the clip to the clip's end and keeps the way back", () => {
    expect(plan([{ start_seconds: 2, end_seconds: 9 }]).zooms[0]).toMatchObject({ endSeconds: 4, rampOutSeconds: 0.3 });
  });

  it("gives a zoom with no end no way back", () => {
    expect(plan([{ start_seconds: 2, ramp_out_seconds: 1 }]).zooms[0]).toMatchObject({
      endSeconds: null,
      rampInSeconds: 0.3,
      rampOutSeconds: 0,
    });
  });

  it("shrinks both ramps in proportion when together they are longer than the zoom", () => {
    const [zoom] = plan([{ start_seconds: 1, end_seconds: 1.4, ramp_in_seconds: 0.3, ramp_out_seconds: 0.5 }]).zooms;
    expect(zoom.rampInSeconds).toBeCloseTo(0.15, 12);
    expect(zoom.rampOutSeconds).toBeCloseTo(0.25, 12);
    expect(plan([{ start_seconds: 1, ramp_in_seconds: 5 }]).zooms[0].rampInSeconds).toBeCloseTo(3, 12);
  });

  it("snaps times to the nearest frame boundary", () => {
    expect(plan([{ start_seconds: 1.01, end_seconds: 2.99 }]).zooms[0]).toMatchObject({ startSeconds: 1, endSeconds: 3 });
    expect(plan([{ start_seconds: 1.02, end_seconds: 2.98 }]).zooms[0]).toMatchObject({ startSeconds: 31 / 30, endSeconds: 89 / 30 });
    expect(plan([{ start_seconds: 0.3, end_seconds: 1.01 }], 4, 24).zooms[0]).toMatchObject({ startSeconds: 7 / 24, endSeconds: 1 });
  });

  it("sorts zooms by start and keeps each one's place in the request", () => {
    const zooms = plan([
      { start_seconds: 2.5, end_seconds: 3 },
      { start_seconds: 0.5, end_seconds: 1 },
      { start_seconds: 1, end_seconds: 2 },
    ]).zooms;
    expect(zooms.map((zoom) => [zoom.index, zoom.startSeconds])).toEqual([[1, 0.5], [2, 1], [0, 2.5]]);
  });

  it("rejects overlapping zooms and names both", () => {
    expect(() => plan([{ start_seconds: 2.5, end_seconds: 4 }, { start_seconds: 1, end_seconds: 3 }]))
      .toThrow("Zoom 2 (1 s to 3 s) and zoom 1 (2.5 s to 4 s) overlap. End each zoom before the next one starts.");
    expect(() => plan([{ start_seconds: 1 }, { start_seconds: 3, end_seconds: 3.5 }]))
      .toThrow("Zoom 1 (1 s to the end of the clip) and zoom 2 (3 s to 3.5 s) overlap.");
  });

  it("lets zooms that overlap by less than a frame touch once snapped", () => {
    const zooms = plan([{ start_seconds: 1, end_seconds: 2.04 }, { start_seconds: 2.03, end_seconds: 3 }]).zooms;
    expect(zooms.map((zoom) => [zoom.startSeconds, zoom.endSeconds])).toEqual([[1, 61 / 30], [61 / 30, 3]]);
  });
});

describe("zoomScaleAt and zoomWindowAt", () => {
  const eased = plan([{ start_seconds: 1, end_seconds: 3, scale: 1.5, ramp_in_seconds: 0.5, ramp_out_seconds: 0.5 }]);

  it("is 1 outside every zoom and the zoom's scale in the hold", () => {
    expect([0, 0.99, 1, 3, 3.5, 4].map((seconds) => zoomScaleAt(eased, seconds))).toEqual([1, 1, 1, 1, 1, 1]);
    expect([1.5, 2, 2.5].map((seconds) => zoomScaleAt(eased, seconds))).toEqual([1.5, 1.5, 1.5]);
    expect(zoomScaleAt(plan([{ start_seconds: 1, ramp_in_seconds: 0.5 }]), 4)).toBe(1.3);
  });

  it("rises and falls without a jump on eased ramps", () => {
    const samples = Array.from({ length: 4001 }, (_, step) => zoomScaleAt(eased, step / 1000));
    const changes = samples.slice(1).map((value, step) => value - samples[step]);
    expect(Math.max(...changes.map(Math.abs))).toBeLessThan(0.002);
    expect(changes.slice(1000, 1500).every((change) => change >= 0)).toBe(true);
    expect(changes.slice(2500, 3000).every((change) => change <= 0)).toBe(true);
    expect(zoomScaleAt(eased, 1.25)).toBeCloseTo(1.25, 12);
    expect(zoomScaleAt(eased, 1.1)).toBeCloseTo(1 + 0.5 * 0.104, 12);
  });

  it("cuts on whole frames when a ramp is 0", () => {
    const cut = plan([{ start_seconds: 1, end_seconds: 3, scale: 1.5, ramp_in_seconds: 0, ramp_out_seconds: 0 }]);
    expect([29, 30, 89, 90].map((frame) => zoomScaleAt(cut, frame / FPS))).toEqual([1, 1.5, 1.5, 1]);
    const film = plan([{ start_seconds: 0.3, end_seconds: 1, ramp_in_seconds: 0, ramp_out_seconds: 0 }], 4, 24);
    expect([6, 7, 23, 24].map((frame) => zoomScaleAt(film, frame / 24))).toEqual([1, 1.3, 1.3, 1]);
  });

  it("keeps the focus point in place and the window inside the picture", () => {
    const focused = plan([{ start_seconds: 1, end_seconds: 3, scale: 1.5, focus_x: 0.5, focus_y: 0.25, ramp_in_seconds: 0, ramp_out_seconds: 0 }]);
    const window = zoomWindowAt(focused, 2);
    expect(window.scale).toBe(1.5);
    expect(window.width).toBeCloseTo(2 / 3, 12);
    expect(window.height).toBeCloseTo(2 / 3, 12);
    expect(window.x).toBeCloseTo(1 / 6, 12);
    expect(window.y).toBeCloseTo(1 / 12, 12);
    expect((0.5 - window.x) / window.width).toBeCloseTo(0.5, 12);
    expect((0.25 - window.y) / window.height).toBeCloseTo(0.25, 12);
    expect(zoomWindowAt(focused, 0.5)).toEqual(FULL_FRAME);
    const corner = zoomWindowAt(plan([{ start_seconds: 0, scale: 3, focus_x: 1, focus_y: 1, ramp_in_seconds: 0 }]), 1);
    expect(corner.x + corner.width).toBeCloseTo(1, 12);
    expect(corner.y + corner.height).toBeCloseTo(1, 12);
  });

  it("uses the focus of the zoom in force", () => {
    const two = plan([
      { start_seconds: 0.5, end_seconds: 1.5, focus_x: 0, focus_y: 0 },
      { start_seconds: 2, end_seconds: 3, focus_x: 1, focus_y: 1 },
    ]);
    expect(zoomWindowAt(two, 1)).toMatchObject({ scale: 1.3, x: 0, y: 0 });
    const second = zoomWindowAt(two, 2.5);
    expect(second.scale).toBe(1.3);
    expect(second.x + second.width).toBeCloseTo(1, 12);
    expect(second.y + second.height).toBeCloseTo(1, 12);
    expect(zoomWindowAt(two, 1.75)).toEqual(FULL_FRAME);
  });
});

describe("buildZoomVideoFilter", () => {
  const cut = plan([{ start_seconds: 1, end_seconds: 3, scale: 1.5, ramp_in_seconds: 0, ramp_out_seconds: 0 }]);

  it("renders the zoom with one per-frame cubic perspective filter", () => {
    const filter = buildZoomVideoFilter(cut, { variableFrameRate: false });
    expect(filter).toMatch(/^perspective=x0='st\(0,1\+0\.5\*min\(gte\(\(in-1\),30\),lt\(\(in-1\),90\)\)\);\(0\.5\*W-0\.5\)\*\(1-1\/ld\(0\)\)':/u);
    expect(filter.endsWith(":sense=source:interpolation=cubic:eval=frame")).toBe(true);
    expect(filter).not.toContain("setpts");
  });

  it("puts an fps filter in front only for a variable frame rate", () => {
    expect(buildZoomVideoFilter(cut, { variableFrameRate: false })).not.toContain("fps=");
    expect(buildZoomVideoFilter(cut, { variableFrameRate: true })).toMatch(/^fps=30,perspective=/u);
    const ntsc = plan([{ start_seconds: 1 }], 4, 30000 / 1001);
    expect(buildZoomVideoFilter(ntsc, { variableFrameRate: true })).toMatch(/^fps=29\.97002997003,perspective=/u);
  });
});

async function ffmpeg(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(FFMPEG, ["-hide_banner", "-v", "error", "-y", ...args], { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

async function ffmpegBytes(args: string[]): Promise<Buffer> {
  const { stdout } = await execFileAsync(FFMPEG, ["-hide_banner", "-v", "error", ...args], {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

async function renderZoom(source: string, output: string, zoomPlan: ZoomPlan, variableFrameRate = false): Promise<string> {
  await ffmpeg(["-i", source, "-vf", buildZoomVideoFilter(zoomPlan, { variableFrameRate }), ...LOSSLESS, output]);
  return output;
}

function cropBack(window: ZoomWindow): string {
  const [width, height, x, y] = [window.width * WIDTH, window.height * HEIGHT, window.x * WIDTH, window.y * HEIGHT];
  for (const pixels of [width, height, x, y]) expect(pixels).toBeCloseTo(Math.round(pixels), 9);
  return `crop=${Math.round(width)}:${Math.round(height)}:${Math.round(x)}:${Math.round(y)},scale=${WIDTH}:${HEIGHT}:flags=bicubic`;
}

async function frameSsim(rendered: string, frame: number, source: string, window: ZoomWindow = FULL_FRAME): Promise<number> {
  const pick = `select='eq(n,${frame})',format=gray,setpts=PTS-STARTPTS`;
  const reference = window === FULL_FRAME ? pick : `${pick},${cropBack(window)}`;
  const stats = await ffmpeg([
    "-i", rendered,
    "-i", source,
    "-filter_complex", `[0:v]${pick}[rendered];[1:v]${reference}[reference];[rendered][reference]ssim=stats_file=-`,
    "-f", "null", "-",
  ]);
  const score = /All:([\d.]+)/u.exec(stats);
  if (!score) throw new Error(`ssim printed no score: ${stats}`);
  return Number(score[1]);
}

async function rowProfiles(path: string): Promise<Float64Array[]> {
  const top = (HEIGHT - ROW_BAND) / 2;
  const bytes = await ffmpegBytes(["-i", path, "-vf", `crop=${WIDTH}:${ROW_BAND}:0:${top},format=gray`, "-f", "rawvideo", "pipe:1"]);
  const frameBytes = WIDTH * ROW_BAND;
  return Array.from({ length: bytes.length / frameBytes }, (_, frame) => {
    const profile = new Float64Array(WIDTH);
    for (let offset = 0; offset < frameBytes; offset++) {
      profile[offset % WIDTH] += bytes[frame * frameBytes + offset] / ROW_BAND;
    }
    return profile;
  });
}

function edgeAt(profile: Float64Array, rising: boolean): number {
  const sign = rising ? 1 : -1;
  const gradient = (pixel: number): number => sign * (profile[pixel + 1] - profile[pixel]);
  const pixels = Array.from({ length: WIDTH - 1 }, (_, pixel) => pixel);
  const peak = pixels.reduce((best, pixel) => (gradient(pixel) > gradient(best) ? pixel : best), 0);
  const reach = pixels.filter((pixel) => Math.abs(pixel - peak) <= EDGE_REACH);
  const weight = reach.reduce((sum, pixel) => sum + gradient(pixel), 0);
  return reach.reduce((sum, pixel) => sum + (pixel + 1) * gradient(pixel), 0) / weight;
}

function barWidth(profile: Float64Array): number {
  return edgeAt(profile, false) - edgeAt(profile, true);
}

async function frameTimes(path: string): Promise<number[]> {
  const { stdout } = await execFileAsync(FFPROBE, [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "frame=pts_time",
    "-of", "csv=p=0",
    path,
  ]);
  return stdout.trim().split("\n").map(Number);
}

async function firstZoomedTime(path: string): Promise<number> {
  const [profiles, times] = await Promise.all([rowProfiles(path), frameTimes(path)]);
  const frame = profiles.findIndex((profile) => barWidth(profile) > BAR_WIDTH * 1.25);
  expect(frame).toBeGreaterThan(0);
  return times[frame];
}

async function videoShape(path: string): Promise<Record<string, unknown>> {
  const { stdout } = await execFileAsync(FFPROBE, [
    "-v", "error",
    "-select_streams", "v:0",
    "-count_frames",
    "-show_entries", "stream=width,height,r_frame_rate,avg_frame_rate,nb_read_frames",
    "-of", "json",
    path,
  ]);
  const [stream] = (JSON.parse(stdout) as { streams: Record<string, unknown>[] }).streams;
  return stream;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

describe("zoom filter on real video", () => {
  let dir = "";
  let testPattern = "";
  let bar = "";
  let hardCut = "";
  const hardCutPlan = plan([{ start_seconds: 1, end_seconds: 3, scale: 1.5, focus_x: 0.5, focus_y: 0.25, ramp_in_seconds: 0, ramp_out_seconds: 0 }]);

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "videobook-zoom-"));
    testPattern = join(dir, "testsrc2.mp4");
    bar = join(dir, "bar.mp4");
    await ffmpeg(["-f", "lavfi", "-i", `testsrc2=size=${WIDTH}x${HEIGHT}:rate=${FPS}:duration=${SECONDS}`, ...LOSSLESS, testPattern]);
    await ffmpeg([
      "-f", "lavfi",
      "-i", `color=c=black:size=${WIDTH}x${HEIGHT}:rate=${FPS}:duration=${SECONDS},drawbox=x=${BAR_LEFT}:y=0:w=${BAR_WIDTH}:h=${HEIGHT}:color=white:t=fill,gblur=sigma=1.5`,
      ...LOSSLESS,
      bar,
    ]);
    hardCut = await renderZoom(testPattern, join(dir, "hard-cut.mp4"), hardCutPlan);
  }, testBudget(60_000));

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("cuts hard on the frames asked for and shows the zoom window", async () => {
    const [before, first, last, after] = await Promise.all([
      frameSsim(hardCut, 29, testPattern),
      frameSsim(hardCut, 30, testPattern, zoomWindowAt(hardCutPlan, 30 / FPS)),
      frameSsim(hardCut, 89, testPattern, zoomWindowAt(hardCutPlan, 89 / FPS)),
      frameSsim(hardCut, 90, testPattern),
    ]);
    expect(before).toBeGreaterThanOrEqual(0.98);
    expect(first).toBeGreaterThanOrEqual(0.97);
    expect(last).toBeGreaterThanOrEqual(0.97);
    expect(after).toBeGreaterThanOrEqual(0.98);
    expect(await frameSsim(hardCut, 30, testPattern)).toBeLessThan(0.9);
  });

  it("shows the window zoomWindowAt reports at scales 2 and 3, to a fraction of a pixel", async () => {
    const close = plan([
      { start_seconds: 0.5, end_seconds: 1.5, scale: 2, focus_x: 0.5, focus_y: 0.75, ramp_in_seconds: 0, ramp_out_seconds: 0 },
      { start_seconds: 2, end_seconds: 3.5, scale: 3, focus_x: 0.5, focus_y: 0.75, ramp_in_seconds: 0, ramp_out_seconds: 0 },
    ]);
    const [rendered, sourceProfiles, profiles] = await Promise.all([
      renderZoom(testPattern, join(dir, "close.mp4"), close),
      rowProfiles(bar),
      renderZoom(bar, join(dir, "close-bar.mp4"), close).then(rowProfiles),
    ]);
    const holds = [{ frame: 20, limit: 0.995 }, { frame: 40, limit: 0.995 }, { frame: 70, limit: 0.98 }, { frame: 95, limit: 0.98 }];
    const scores = await Promise.all(holds.map(({ frame }) => frameSsim(rendered, frame, testPattern, zoomWindowAt(close, frame / FPS))));
    scores.forEach((score, hold) => expect(score).toBeGreaterThanOrEqual(holds[hold].limit));
    const sourceEdges = [edgeAt(sourceProfiles[0], true), edgeAt(sourceProfiles[0], false)];
    for (const { frame } of holds) {
      const window = zoomWindowAt(close, frame / FPS);
      const edges = [edgeAt(profiles[frame], true), edgeAt(profiles[frame], false)];
      edges.forEach((edge, side) => {
        expect(Math.abs(edge - (sourceEdges[side] - window.x * WIDTH) / window.width)).toBeLessThanOrEqual(0.1);
      });
    }
  });

  it("keeps the source's size, frame rate and frame count", async () => {
    const [source, output] = await Promise.all([videoShape(testPattern), videoShape(hardCut)]);
    expect(source).toMatchObject({ width: WIDTH, height: HEIGHT, r_frame_rate: "30/1", avg_frame_rate: "30/1", nb_read_frames: String(FRAMES) });
    expect(output).toEqual(source);
  });

  it("moves a tracked edge smoothly through a slow zoom", async () => {
    const slow = plan([{ start_seconds: 0.5, scale: 1.2, focus_x: 0, focus_y: 0.5, ramp_in_seconds: 3 }]);
    const [sourceProfiles, profiles] = await Promise.all([
      rowProfiles(bar),
      rowProfiles(await renderZoom(bar, join(dir, "slow.mp4"), slow)),
    ]);
    const sourceEdge = edgeAt(sourceProfiles[0], true);
    const edges = profiles.map((profile) => edgeAt(profile, true));
    const deviations = edges.map((edge, frame) => {
      const window = zoomWindowAt(slow, frame / FPS);
      return edge - (sourceEdge - window.x * WIDTH) / window.width;
    });
    const offset = mean(deviations);
    const rms = Math.sqrt(mean(deviations.map((deviation) => (deviation - offset) ** 2)));
    const worstStep = Math.max(...deviations.slice(1).map((deviation, frame) => Math.abs(deviation - deviations[frame])));
    expect(profiles).toHaveLength(FRAMES);
    expect(edges[FRAMES - 1] - edges[0]).toBeCloseTo(sourceEdge * 0.2, 0);
    expect(rms).toBeLessThanOrEqual(0.15);
    expect(worstStep).toBeLessThanOrEqual(0.3);
  });

  it("eases into the zoom along zoomScaleAt", async () => {
    const eased = plan([{ start_seconds: 1, end_seconds: 3, scale: 1.5, ramp_in_seconds: 0.5, ramp_out_seconds: 0.5 }]);
    const [sourceProfiles, profiles] = await Promise.all([
      rowProfiles(bar),
      rowProfiles(await renderZoom(bar, join(dir, "eased.mp4"), eased)),
    ]);
    const sourceWidth = barWidth(sourceProfiles[0]);
    const measured = (frame: number): number => barWidth(profiles[frame]) / sourceWidth;
    for (const frame of [33, 37, 42]) {
      expect(Math.abs(measured(frame) / zoomScaleAt(eased, frame / FPS) - 1)).toBeLessThanOrEqual(0.02);
    }
    for (const frame of [33, 42]) {
      const linear = 1 + 0.5 * ((frame - 30) / 15);
      expect(Math.abs(measured(frame) / linear - 1)).toBeGreaterThan(0.02);
    }
  });

  it("lands two zooms in one plan, each on its own focus point", async () => {
    const two = plan([
      { start_seconds: 0.3, end_seconds: 1.6, scale: 2, focus_x: 0.5, focus_y: 0.25 },
      { start_seconds: 2, end_seconds: 3.6, scale: 1.5, focus_x: 1, focus_y: 0 },
    ]);
    const rendered = await renderZoom(testPattern, join(dir, "two.mp4"), two);
    const firstAtSecondFocus = plan([{ start_seconds: 0.3, end_seconds: 1.6, scale: 2, focus_x: 1, focus_y: 0 }]);
    const [first, second, between, wrongFocus] = await Promise.all([
      frameSsim(rendered, 30, testPattern, zoomWindowAt(two, 30 / FPS)),
      frameSsim(rendered, 84, testPattern, zoomWindowAt(two, 84 / FPS)),
      frameSsim(rendered, 54, testPattern),
      frameSsim(rendered, 30, testPattern, zoomWindowAt(firstAtSecondFocus, 30 / FPS)),
    ]);
    expect(first).toBeGreaterThanOrEqual(0.97);
    expect(second).toBeGreaterThanOrEqual(0.97);
    expect(between).toBeGreaterThanOrEqual(0.98);
    expect(wrongFocus).toBeLessThan(0.9);
  });

  it("lands a hard cut on its time in a clip with irregular frame times", async () => {
    const irregular = join(dir, "irregular.mp4");
    await ffmpeg(["-i", bar, "-vf", "select='not(eq(mod(n,5),2))'", "-fps_mode", "passthrough", ...LOSSLESS, irregular]);
    const probe = await probeVideo(irregular);
    expect(Math.abs((probe.avgFps ?? 0) / probe.fps - 1)).toBeGreaterThan(0.01);
    const cut = createZoomPlan({
      sourceDuration: probe.videoDuration,
      sourceFps: probe.fps,
      zooms: [{ start_seconds: 2, scale: 1.5, ramp_in_seconds: 0 }],
    });
    const retimed = await renderZoom(irregular, join(dir, "irregular-retimed.mp4"), cut, true);
    expect(Math.abs(await firstZoomedTime(retimed) - 2)).toBeLessThanOrEqual(1 / FPS + 1e-6);
    const counted = await renderZoom(irregular, join(dir, "irregular-counted.mp4"), cut, false);
    expect(await firstZoomedTime(counted) - 2).toBeGreaterThan(5 / FPS);
  });
});

describe("browser-safe zoom module", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const specifiers = /^\s*(?:import|export)\s+(type\s+)?[^;]*?\bfrom\s+"([^"]+)"|^\s*import\s+"([^"]+)"/gmu;

  function valueImports(file: string): string[] {
    return [...readFileSync(file, "utf8").matchAll(specifiers)].filter((match) => !match[1]).map((match) => (match[2] ?? match[3])!);
  }

  function reachable(file: string, seen = new Set<string>()): Set<string> {
    if (seen.has(file)) return seen;
    seen.add(file);
    for (const specifier of valueImports(file)) {
      if (specifier.startsWith(".")) reachable(resolve(dirname(file), specifier.replace(/\.js$/u, ".ts")), seen);
    }
    return seen;
  }

  function forbidden(specifier: string): boolean {
    return specifier.startsWith("node:")
      || builtinModules.includes(specifier)
      || specifier === "sharp"
      || specifier === "videobook-engine"
      || specifier.startsWith("videobook-engine/");
  }

  it("zoom.ts reaches no node:, sharp or engine value import", () => {
    const problems = [...reachable(join(here, "zoom.ts"))]
      .flatMap((file) => valueImports(file).filter(forbidden).map((specifier) => `${relative(here, file)} imports ${specifier}`));
    expect(problems).toEqual([]);
  });

  it("notices a forbidden import", () => {
    expect(valueImports(join(here, "ffmpeg.ts")).filter(forbidden)).toEqual(expect.arrayContaining(["node:child_process", "node:fs/promises"]));
  });
});
