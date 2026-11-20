import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FFMPEG } from "../ffmpeg.js";
import { testBudget } from "../test-budget.js";
import { segmentPictureFilters } from "./graph.js";
import type { SegmentPlan, SegmentSource, SegmentZoomPoint } from "./plan.js";
import { renderSegmentPlan } from "./render.js";

const execFileAsync = promisify(execFile);
const WIDTH = 320;
const HEIGHT = 200;
const FPS = 30;

async function runCmd(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(FFMPEG, ["-hide_banner", "-v", "error", "-y", ...args], {
    maxBuffer: 16 * 1024 * 1024,
    timeout: testBudget(60_000),
  });
  return stdout;
}

async function rawBytes(args: string[]): Promise<Buffer> {
  const { stdout } = await execFileAsync(FFMPEG, ["-hide_banner", "-v", "error", ...args], {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
    timeout: testBudget(60_000),
  });
  return stdout;
}

function cropFilterForPoint(point: SegmentZoomPoint): string {
  const cropW = WIDTH / point.scale;
  const cropH = HEIGHT / point.scale;
  const left = point.x * (WIDTH - cropW);
  const top = point.y * (HEIGHT - cropH);
  return `crop=${Math.round(cropW)}:${Math.round(cropH)}:${Math.round(left)}:${Math.round(top)}:exact=1,scale=${WIDTH}:${HEIGHT}:flags=bicubic`;
}

async function frameSsimAgainstWindow(
  rendered: string,
  renderedFrame: number,
  source: string,
  sourceFrame: number,
  point?: SegmentZoomPoint,
): Promise<number> {
  const srcPick = `select='eq(n,${sourceFrame})',setpts=PTS-STARTPTS,format=gray`;
  const refChain = point && point.scale > 1
    ? `${srcPick},${cropFilterForPoint(point)}`
    : srcPick;
  const stats = await runCmd([
    "-i", rendered,
    "-i", source,
    "-filter_complex",
    `[0:v]select='eq(n,${renderedFrame})',setpts=PTS-STARTPTS,format=gray[a];[1:v]${refChain}[b];[a][b]ssim=stats_file=-`,
    "-f", "null", "-",
  ]);
  const match = /All:([\d.]+)/u.exec(stats);
  if (!match) throw new Error(`ssim produced no score: ${stats}`);
  return Number(match[1]);
}

function makeSource(frames: number): SegmentSource {
  return {
    artifactId: "zoom-fixture",
    sourceHash: "z".repeat(64),
    fps: FPS,
    frames,
    width: WIDTH,
    height: HEIGHT,
    hasAudio: false,
  };
}

describe("segment zoom keyframes", () => {
  let dir = "";
  let patternClip = "";
  let boxClip = "";
  let brightClip = "";

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "auto-edit-zoom-"));
    patternClip = join(dir, "pattern.mp4");
    boxClip = join(dir, "box.mp4");
    brightClip = join(dir, "bright.mp4");

    await runCmd([
      "-f", "lavfi", "-i", `testsrc2=size=${WIDTH}x${HEIGHT}:rate=${FPS}:duration=2`,
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "10", "-pix_fmt", "yuv420p",
      "-an", patternClip,
    ]);
    await runCmd([
      "-f", "lavfi", "-i",
      `color=c=0x404040:s=${WIDTH}x${HEIGHT}:r=${FPS}:d=1,drawbox=x=120:y=75:w=80:h=50:color=white:t=fill`,
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "10", "-pix_fmt", "yuv420p",
      "-an", boxClip,
    ]);
    await runCmd([
      "-f", "lavfi", "-i",
      `color=c=0x80a0c0:s=${WIDTH}x${HEIGHT}:r=${FPS}:d=1,geq=r='120+80*X/W':g='100+80*Y/H':b='140+60*(X+Y)/(W+H)'`,
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "10", "-pix_fmt", "yuv420p",
      "-an", brightClip,
    ]);
  }, testBudget(60_000));

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("omits perspective when zoom stays at scale 1", () => {
    const plain = segmentPictureFilters(
      { id: "plain", role: "body", startFrame: 0, endFrame: 30, speed: 1, motion: "repeat", audio: "mute" },
      FPS,
      { variableFrameRate: false, width: WIDTH },
    );
    const identityZoom = segmentPictureFilters(
      {
        id: "id",
        role: "body",
        startFrame: 0,
        endFrame: 30,
        speed: 1,
        motion: "repeat",
        audio: "mute",
        zoom: { from: { scale: 1, x: 0.2, y: 0.8 }, to: { scale: 1, x: 0.7, y: 0.3 }, ease: "linear" },
      },
      FPS,
      { variableFrameRate: false, width: WIDTH },
    );
    expect(identityZoom).toEqual(plain);
    expect(identityZoom.some((filter) => filter.includes("perspective"))).toBe(false);
  });

  it("holds a punched-in window at SSIM >= 0.98 on first, middle and last frames", async () => {
    const target: SegmentZoomPoint = { scale: 2, x: 0.5, y: 0.25 };
    const plan: SegmentPlan = {
      version: 1,
      source: makeSource(60),
      segments: [{
        id: "hold",
        role: "replay",
        startFrame: 10,
        endFrame: 40,
        speed: 1,
        motion: "repeat",
        audio: "mute",
        zoom: { from: target, to: target, ease: "hold" },
      }],
    };
    const out = join(dir, "hold.mp4");
    expect((await renderSegmentPlan(plan, patternClip, out)).frames).toBe(30);

    for (const [outFrame, srcFrame] of [[0, 10], [15, 25], [29, 39]] as const) {
      const zoomed = await frameSsimAgainstWindow(out, outFrame, patternClip, srcFrame, target);
      const unzoomed = await frameSsimAgainstWindow(out, outFrame, patternClip, srcFrame);
      expect(zoomed, `hold frame ${outFrame}`).toBeGreaterThanOrEqual(0.98);
      expect(unzoomed, `hold unzoomed ${outFrame}`).toBeLessThan(0.85);
    }
  }, testBudget(60_000));

  it("zooms linearly from 1 to 2, shrinking the visible window on every frame", async () => {
    const plan: SegmentPlan = {
      version: 1,
      source: makeSource(60),
      segments: [{
        id: "lin",
        role: "push_in",
        startFrame: 0,
        endFrame: 30,
        speed: 1,
        motion: "repeat",
        audio: "mute",
        zoom: {
          from: { scale: 1, x: 0.5, y: 0.5 },
          to: { scale: 2, x: 0.5, y: 0.5 },
          ease: "linear",
        },
      }],
    };
    const out = join(dir, "linear-pattern.mp4");
    expect((await renderSegmentPlan(plan, patternClip, out)).frames).toBe(30);
    expect(await frameSsimAgainstWindow(out, 0, patternClip, 0)).toBeGreaterThanOrEqual(0.98);
    expect(await frameSsimAgainstWindow(out, 29, patternClip, 29, { scale: 2, x: 0.5, y: 0.5 })).toBeGreaterThanOrEqual(0.98);

    const boxPlan: SegmentPlan = {
      version: 1,
      source: makeSource(30),
      segments: [{
        id: "lin-box",
        role: "push_in",
        startFrame: 0,
        endFrame: 11,
        speed: 1,
        motion: "repeat",
        audio: "mute",
        zoom: {
          from: { scale: 1, x: 0.5, y: 0.5 },
          to: { scale: 2, x: 0.5, y: 0.5 },
          ease: "linear",
        },
      }],
    };
    const boxOut = join(dir, "linear-box.mp4");
    expect((await renderSegmentPlan(boxPlan, boxClip, boxOut)).frames).toBe(11);
    const luma = await rawBytes(["-i", boxOut, "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"]);
    const frameSize = WIDTH * HEIGHT;
    const midRow = Math.floor(HEIGHT / 2);
    const widths: number[] = [];
    for (let f = 0; f < 11; f += 1) {
      let brightPixels = 0;
      const rowOffset = f * frameSize + midRow * WIDTH;
      for (let x = 0; x < WIDTH; x += 1) {
        if (luma[rowOffset + x]! > 160) brightPixels += 1;
      }
      widths.push(brightPixels);
    }
    expect(widths[0]).toBeGreaterThanOrEqual(78);
    expect(widths[0]).toBeLessThanOrEqual(82);
    expect(widths[10]).toBeGreaterThanOrEqual(158);
    expect(widths[10]).toBeLessThanOrEqual(162);
    for (let i = 1; i < widths.length; i += 1) {
      expect(widths[i]!, `frame ${i} box width`).toBeGreaterThan(widths[i - 1]!);
    }
  }, testBudget(60_000));

  it("tracks a moving focus and honors smooth ease with rampFraction 0.5", async () => {
    const movePlan: SegmentPlan = {
      version: 1,
      source: makeSource(60),
      segments: [{
        id: "move",
        role: "push_in",
        startFrame: 5,
        endFrame: 35,
        speed: 1,
        motion: "repeat",
        audio: "mute",
        zoom: {
          from: { scale: 1, x: 0.3, y: 0.5 },
          to: { scale: 2, x: 0.7, y: 0.5 },
          ease: "linear",
        },
      }],
    };
    const moveOut = join(dir, "moving-focus.mp4");
    expect((await renderSegmentPlan(movePlan, patternClip, moveOut)).frames).toBe(30);
    const atRight = await frameSsimAgainstWindow(moveOut, 29, patternClip, 34, { scale: 2, x: 0.7, y: 0.5 });
    const atLeft = await frameSsimAgainstWindow(moveOut, 29, patternClip, 34, { scale: 2, x: 0.3, y: 0.5 });
    expect(atRight).toBeGreaterThanOrEqual(0.98);
    expect(atLeft).toBeLessThan(0.85);

    const smoothTarget: SegmentZoomPoint = { scale: 2, x: 0.5, y: 0.25 };
    const rampPlan: SegmentPlan = {
      version: 1,
      source: makeSource(60),
      segments: [{
        id: "ramp",
        role: "crash",
        startFrame: 0,
        endFrame: 31,
        speed: 1,
        motion: "repeat",
        audio: "mute",
        zoom: {
          from: { scale: 1, x: 0.5, y: 0.5 },
          to: smoothTarget,
          ease: "smooth",
          rampFraction: 0.5,
        },
      }],
    };
    const rampOut = join(dir, "smooth-ramp.mp4");
    expect((await renderSegmentPlan(rampPlan, patternClip, rampOut)).frames).toBe(31);
    expect(await frameSsimAgainstWindow(rampOut, 0, patternClip, 0)).toBeGreaterThanOrEqual(0.98);
    expect(await frameSsimAgainstWindow(rampOut, 15, patternClip, 15, smoothTarget)).toBeGreaterThanOrEqual(0.98);
    expect(await frameSsimAgainstWindow(rampOut, 30, patternClip, 30, smoothTarget)).toBeGreaterThanOrEqual(0.98);
  }, testBudget(60_000));

  it("never introduces a black border row or column at edge focuses and high scales", async () => {
    const plan: SegmentPlan = {
      version: 1,
      source: makeSource(30),
      segments: [
        {
          id: "top-left",
          role: "custom",
          startFrame: 0,
          endFrame: 5,
          speed: 1,
          motion: "repeat",
          audio: "mute",
          zoom: { from: { scale: 1, x: 0, y: 0 }, to: { scale: 3, x: 0, y: 0 }, ease: "linear" },
        },
        {
          id: "bottom-right",
          role: "custom",
          startFrame: 5,
          endFrame: 10,
          speed: 1,
          motion: "repeat",
          audio: "mute",
          zoom: { from: { scale: 3, x: 1, y: 1 }, to: { scale: 3, x: 1, y: 1 }, ease: "hold" },
        },
        {
          id: "top-right",
          role: "custom",
          startFrame: 10,
          endFrame: 15,
          speed: 1,
          motion: "repeat",
          audio: "mute",
          zoom: { from: { scale: 2, x: 1, y: 0 }, to: { scale: 2.7, x: 0, y: 1 }, ease: "smooth" },
        },
      ],
    };
    const out = join(dir, "no-border.mp4");
    const result = await renderSegmentPlan(plan, brightClip, out);
    expect(result.frames).toBe(15);

    const srcGray = await rawBytes(["-i", brightClip, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"]);
    let srcMin = 255;
    for (const byte of srcGray) if (byte < srcMin) srcMin = byte;
    expect(srcMin).toBeGreaterThan(90);

    const outGray = await rawBytes(["-i", out, "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"]);
    const frameSize = WIDTH * HEIGHT;
    expect(outGray.length).toBe(15 * frameSize);
    for (let f = 0; f < 15; f += 1) {
      const base = f * frameSize;
      for (const row of [0, HEIGHT - 1]) {
        let sum = 0;
        for (let x = 0; x < WIDTH; x += 1) sum += outGray[base + row * WIDTH + x]!;
        expect(sum / WIDTH, `frame ${f} row ${row}`).toBeGreaterThan(srcMin - 20);
      }
      for (const col of [0, WIDTH - 1]) {
        let sum = 0;
        for (let y = 0; y < HEIGHT; y += 1) sum += outGray[base + y * WIDTH + col]!;
        expect(sum / HEIGHT, `frame ${f} col ${col}`).toBeGreaterThan(srcMin - 20);
      }
    }
  }, testBudget(60_000));
});
