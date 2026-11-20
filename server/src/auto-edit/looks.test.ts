import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FFMPEG } from "../ffmpeg.js";
import { testBudget } from "../test-budget.js";
import { lookFilter, SEGMENT_LOOKS } from "./looks.js";
import type { SegmentPlan, SegmentSource } from "./plan.js";
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

async function yuv444Frame(path: string, frameIndex: number): Promise<Buffer> {
  return rawBytes([
    "-i", path,
    "-vf", `select='eq(n,${frameIndex})'`,
    "-vframes", "1",
    "-f", "rawvideo",
    "-pix_fmt", "yuv444p",
    "pipe:1",
  ]);
}

function patchYuv(buf: Buffer, cx: number, cy: number, radius = 10): { y: number; u: number; v: number } {
  const plane = WIDTH * HEIGHT;
  let ySum = 0;
  let uSum = 0;
  let vSum = 0;
  let count = 0;
  for (let y = cy - radius; y <= cy + radius; y += 1) {
    for (let x = cx - radius; x <= cx + radius; x += 1) {
      const idx = y * WIDTH + x;
      ySum += buf[idx]!;
      uSum += buf[plane + idx]!;
      vSum += buf[2 * plane + idx]!;
      count += 1;
    }
  }
  return { y: ySum / count, u: uSum / count, v: vSum / count };
}

function hueAngleDiffDegrees(a: { u: number; v: number }, b: { u: number; v: number }): number {
  const angleA = Math.atan2(a.v - 128, a.u - 128);
  const angleB = Math.atan2(b.v - 128, b.u - 128);
  let diff = Math.abs(angleA - angleB) * (180 / Math.PI);
  if (diff > 180) diff = 360 - diff;
  return diff;
}

async function frameSsim(rendered: string, renderedFrame: number, source: string, sourceFrame: number): Promise<number> {
  const stats = await runCmd([
    "-i", rendered,
    "-i", source,
    "-filter_complex",
    `[0:v]select='eq(n,${renderedFrame})',format=gray,setpts=PTS-STARTPTS[a];[1:v]select='eq(n,${sourceFrame})',format=gray,setpts=PTS-STARTPTS[b];[a][b]ssim=stats_file=-`,
    "-f", "null", "-",
  ]);
  const match = /All:([\d.]+)/u.exec(stats);
  if (!match) throw new Error(`ssim produced no score: ${stats}`);
  return Number(match[1]);
}

function makeSource(frames: number): SegmentSource {
  return {
    artifactId: "looks-fixture",
    sourceHash: "l".repeat(64),
    fps: FPS,
    frames,
    width: WIDTH,
    height: HEIGHT,
    hasAudio: false,
  };
}

describe("segment looks", () => {
  let dir = "";
  let flatClip = "";
  let barClip = "";
  let patternClip = "";

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "auto-edit-looks-"));
    flatClip = join(dir, "flat.mp4");
    barClip = join(dir, "bar.mp4");
    patternClip = join(dir, "pattern.mp4");

    await runCmd([
      "-f", "lavfi", "-i",
      `color=c=black:s=${WIDTH}x${HEIGHT}:r=${FPS}:d=1,drawbox=x=0:y=0:w=106:h=${HEIGHT}:color=white:t=fill,drawbox=x=107:y=0:w=106:h=${HEIGHT}:color=0x808080:t=fill`,
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "10", "-pix_fmt", "yuv420p",
      "-an", flatClip,
    ]);
    await runCmd([
      "-f", "lavfi", "-i",
      `color=c=black:s=${WIDTH}x${HEIGHT}:r=${FPS}:d=1,drawbox=x=120:y=0:w=80:h=${HEIGHT}:color=white:t=fill`,
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "10", "-pix_fmt", "yuv420p",
      "-an", barClip,
    ]);
    await runCmd([
      "-f", "lavfi", "-i", `testsrc2=size=${WIDTH}x${HEIGHT}:rate=${FPS}:duration=2`,
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "10", "-pix_fmt", "yuv420p",
      "-an", patternClip,
    ]);
  }, testBudget(60_000));

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("describes all four looks and builds the expected FFmpeg filter strings", () => {
    expect(SEGMENT_LOOKS.map((look) => look.id)).toEqual(["none", "crash", "invert", "rgb_split"]);
    for (const look of SEGMENT_LOOKS) {
      expect(look.name.length).toBeGreaterThan(0);
      expect(look.description.length).toBeGreaterThan(0);
    }
    expect(lookFilter("none", WIDTH)).toBeNull();
    expect(lookFilter("invert", WIDTH)).toBe("negate");
    expect(lookFilter("rgb_split", WIDTH)).toBe("rgbashift=rh=-4:bh=4");
    expect(lookFilter("rgb_split", 1080)).toBe("rgbashift=rh=-13:bh=13");
    expect(lookFilter("crash", WIDTH)).toContain("pseudocolor=");
    expect(lookFilter("crash", WIDTH)).toContain("hue=");
  });

  it("renders crash with preserved luma, opposite white/black chroma, and > 60 deg hue turn in 0.3 s", async () => {
    const plan: SegmentPlan = {
      version: 1,
      source: makeSource(30),
      segments: [{
        id: "crash",
        role: "crash",
        startFrame: 0,
        endFrame: 20,
        speed: 1,
        motion: "repeat",
        audio: "mute",
        look: "crash",
      }],
    };
    const out = join(dir, "crash.mp4");
    expect((await renderSegmentPlan(plan, flatClip, out)).frames).toBe(20);

    const srcBuf = await yuv444Frame(flatClip, 0);
    const frame0 = await yuv444Frame(out, 0);
    const frame9 = await yuv444Frame(out, 9);

    const regions = [
      { name: "white", x: 53 },
      { name: "grey", x: 160 },
      { name: "black", x: 267 },
    ] as const;

    for (const region of regions) {
      const src = patchYuv(srcBuf, region.x, 100);
      const r0 = patchYuv(frame0, region.x, 100);
      const r9 = patchYuv(frame9, region.x, 100);
      expect(Math.abs(r0.y - src.y), `${region.name} f0 luma`).toBeLessThanOrEqual(12);
      expect(Math.abs(r9.y - src.y), `${region.name} f9 luma`).toBeLessThanOrEqual(12);
    }

    const white0 = patchYuv(frame0, 53, 100);
    const black0 = patchYuv(frame0, 267, 100);
    const whiteChroma = Math.hypot(white0.u - 128, white0.v - 128);
    const blackChroma = Math.hypot(black0.u - 128, black0.v - 128);
    expect(whiteChroma).toBeGreaterThan(15);
    expect(blackChroma).toBeGreaterThan(15);
    const dot = (white0.u - 128) * (black0.u - 128) + (white0.v - 128) * (black0.v - 128);
    expect(dot).toBeLessThan(-200);

    const white9 = patchYuv(frame9, 53, 100);
    expect(hueAngleDiffDegrees(white0, white9)).toBeGreaterThan(60);
  }, testBudget(60_000));

  it("renders invert flipping white to black and black to white", async () => {
    const plan: SegmentPlan = {
      version: 1,
      source: makeSource(30),
      segments: [{
        id: "inv",
        role: "custom",
        startFrame: 0,
        endFrame: 10,
        speed: 1,
        motion: "repeat",
        audio: "mute",
        look: "invert",
      }],
    };
    const out = join(dir, "invert.mp4");
    expect((await renderSegmentPlan(plan, flatClip, out)).frames).toBe(10);

    const frame = await yuv444Frame(out, 5);
    expect(patchYuv(frame, 53, 100).y).toBeLessThan(35);
    expect(patchYuv(frame, 267, 100).y).toBeGreaterThan(220);
  }, testBudget(60_000));

  it("renders rgb_split with red and blue edges round(W * 0.012) pixels outside a white bar", async () => {
    const shift = Math.round(WIDTH * 0.012);
    const plan: SegmentPlan = {
      version: 1,
      source: makeSource(30),
      segments: [{
        id: "split",
        role: "custom",
        startFrame: 0,
        endFrame: 10,
        speed: 1,
        motion: "repeat",
        audio: "mute",
        look: "rgb_split",
      }],
    };
    const out = join(dir, "rgb-split.mp4");
    expect((await renderSegmentPlan(plan, barClip, out)).frames).toBe(10);

    const rgb = await rawBytes([
      "-i", out,
      "-vf", "select='eq(n,5)'",
      "-vframes", "1",
      "-f", "rawvideo",
      "-pix_fmt", "rgb24",
      "pipe:1",
    ]);
    const pixel = (x: number): [number, number, number] => {
      const idx = (100 * WIDTH + x) * 3;
      return [rgb[idx]!, rgb[idx + 1]!, rgb[idx + 2]!];
    };

    const leftFringe = pixel(120 - Math.ceil(shift / 2));
    const rightFringe = pixel(200 + Math.floor(shift / 2));
    const farLeft = pixel(120 - shift - 4);
    const farRight = pixel(200 + shift + 4);

    const leftIsRed = leftFringe[0] > 160 && leftFringe[2] < 60;
    const leftIsBlue = leftFringe[2] > 160 && leftFringe[0] < 60;
    const rightIsRed = rightFringe[0] > 160 && rightFringe[2] < 60;
    const rightIsBlue = rightFringe[2] > 160 && rightFringe[0] < 60;
    expect((leftIsRed && rightIsBlue) || (leftIsBlue && rightIsRed)).toBe(true);
    expect(Math.max(...farLeft)).toBeLessThan(30);
    expect(Math.max(...farRight)).toBeLessThan(30);
  }, testBudget(60_000));

  it("mixes zooms and all looks in neighbouring segments with exact frame count and zero leak", async () => {
    const plan: SegmentPlan = {
      version: 1,
      source: makeSource(60),
      segments: [
        {
          id: "s-crash",
          role: "crash",
          startFrame: 0,
          endFrame: 15,
          speed: 1,
          motion: "repeat",
          audio: "mute",
          zoom: {
            from: { scale: 1, x: 0.5, y: 0.5 },
            to: { scale: 2, x: 0.5, y: 0.5 },
            ease: "smooth",
            rampFraction: 0.55,
          },
          look: "crash",
        },
        {
          id: "s-invert",
          role: "custom",
          startFrame: 15,
          endFrame: 30,
          speed: 1,
          motion: "repeat",
          audio: "mute",
          look: "invert",
        },
        {
          id: "s-split",
          role: "push_in",
          startFrame: 30,
          endFrame: 45,
          speed: 1,
          motion: "repeat",
          audio: "mute",
          zoom: {
            from: { scale: 1, x: 0.4, y: 0.5 },
            to: { scale: 1.8, x: 0.6, y: 0.5 },
            ease: "linear",
          },
          look: "rgb_split",
        },
        {
          id: "s-plain",
          role: "body",
          startFrame: 45,
          endFrame: 60,
          speed: 1,
          motion: "repeat",
          audio: "mute",
          look: "none",
        },
      ],
    };
    const out = join(dir, "mixed.mp4");
    const result = await renderSegmentPlan(plan, patternClip, out);
    expect(result.frames).toBe(60);

    expect(await frameSsim(out, 45, patternClip, 45)).toBeGreaterThanOrEqual(0.98);
    expect(await frameSsim(out, 59, patternClip, 59)).toBeGreaterThanOrEqual(0.98);
    expect(await frameSsim(out, 15, patternClip, 15)).toBeLessThan(0.3);
  }, testBudget(60_000));
});
