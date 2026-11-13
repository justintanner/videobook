import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FFMPEG, probeVideo } from "../ffmpeg.js";
import { burnFilter, burnGraphics, burnWatermarkEnable, burnWatermarkInputArgs, burnWatermarkLoopSeconds } from "./burn.js";
import type { ResolvedGraphicsTiming } from "./timing.js";

const execFileAsync = promisify(execFile);
const WIDTH = 360;
const HEIGHT = 640;
const DURATION = 4;
const BACKGROUND = [32, 96, 160] as const;
const RED = [255, 0, 0] as const;
const GREEN = [0, 255, 0] as const;
const YELLOW = [255, 255, 0] as const;
const WHOLE: ResolvedGraphicsTiming = { start: 0, end: DURATION, fadeIn: 0, fadeOut: 0, enter: "fade", exit: "fade" };
const MIDDLE: ResolvedGraphicsTiming = { start: 1, end: 3, fadeIn: 0.5, fadeOut: 0.5, enter: "fade", exit: "fade" };
const TAIL: ResolvedGraphicsTiming = { start: 3, end: DURATION, fadeIn: 0.25, fadeOut: 0, enter: "fade", exit: "fade" };
const RED_POINT = [60, 40] as const;
const GREEN_POINT = [190, 330] as const;
const YELLOW_POINT = [270, 580] as const;

type Rgb = readonly [number, number, number];
type Box = { left: number; top: number; width: number; height: number };

function distance(color: Rgb, target: Rgb): number {
  return Math.abs(color[0] - target[0]) + Math.abs(color[1] - target[1]) + Math.abs(color[2] - target[2]);
}

describe("burn filter helpers", () => {
  it("preserves the fade-only filter graph byte for byte", () => {
    const probe = { width: WIDTH, height: HEIGHT } as Awaited<ReturnType<typeof probeVideo>>;
    expect(burnFilter([
      { path: "badge.png", left: 20, top: 40, start: 1, end: 3, fades: { fadeIn: 0.5, fadeOut: 0.5 } },
    ], probe, { width: WIDTH, height: HEIGHT })).toBe("[1:v]format=rgba,fade=t=in:st=1:d=0.5:alpha=1,fade=t=out:st=2.5:d=0.5:alpha=1[g1];[0:v][g1]overlay=20:40:format=auto:enable='between(t,1,3)'[vout]");
    expect(burnFilter([
      { path: "motion-%06d.png", left: 0, top: 40, start: 1, end: 1.5, fades: { fadeIn: 0, fadeOut: 0 }, sequenceFps: 30, exclusiveEnd: true },
    ], probe, { width: WIDTH, height: HEIGHT })).toBe("[1:v]format=rgba,setpts=PTS-STARTPTS+1/TB[g1];[0:v][g1]overlay=0:40:format=auto:enable='gte(t,1)*lt(t,1.5)'[vout]");
  });

  it("supports open-ended and whole-clip timing", () => {
    expect(burnWatermarkEnable()).toBe("");
    expect(burnWatermarkEnable(1.5)).toBe(":enable='gte(t,1.5)'");
    expect(burnWatermarkEnable(undefined, 4)).toBe(":enable='between(t,0,4)'");
  });

  it("loops a still only while it fades, and never past the clip", () => {
    expect(burnWatermarkLoopSeconds({ fadeIn: 0, fadeOut: 0 }, 2, 6, 10)).toBeNull();
    expect(burnWatermarkLoopSeconds({ fadeIn: 0.5, fadeOut: 0 }, 2, undefined, 10)).toBe(2.75);
    expect(burnWatermarkLoopSeconds({ fadeIn: 0.5, fadeOut: 0.5 }, 2, 6, 10)).toBe(6.25);
    expect(burnWatermarkLoopSeconds({ fadeIn: 0.3, fadeOut: 0.3 }, 0.2, 0.8, 1)).toBe(1);
    expect(burnWatermarkInputArgs("/badge.png", null, "12/1")).toEqual(["-i", "/badge.png"]);
    expect(burnWatermarkInputArgs("/badge.png", 2.75, "30000/1001")).toEqual([
      "-loop", "1", "-framerate", "30000/1001", "-t", "2.75", "-i", "/badge.png",
    ]);
  });
});

describe("burnGraphics", () => {
  let root: string;
  let files = 0;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "videobook-graphics-burn-"));
  });

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  function scratch(name: string): string {
    files += 1;
    return join(root, `${files}-${name}`);
  }

  async function sourceVideo(options: { rotated?: boolean } = {}): Promise<string> {
    const plain = scratch("source.mp4");
    const size = options.rotated ? `${HEIGHT}x${WIDTH}` : `${WIDTH}x${HEIGHT}`;
    await execFileAsync(FFMPEG, [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", `color=c=0x2060a0:s=${size}:r=30:d=${DURATION}`,
      "-f", "lavfi", "-i", `sine=frequency=330:sample_rate=44100:duration=${DURATION}`,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", plain,
    ]);
    if (!options.rotated) return plain;
    const rotated = scratch("rotated.mp4");
    await execFileAsync(FFMPEG, ["-y", "-v", "error", "-display_rotation", "90", "-i", plain, "-c", "copy", rotated]);
    return rotated;
  }

  async function still(boxes: ReadonlyArray<{ box: Box; color: Rgb }>, size = { width: WIDTH, height: HEIGHT }): Promise<string> {
    const path = scratch("still.png");
    const composites = await Promise.all(boxes.map(async ({ box, color }) => ({
      input: await sharp({ create: { width: box.width, height: box.height, channels: 4, background: { r: color[0], g: color[1], b: color[2], alpha: 1 } } }).png().toBuffer(),
      left: box.left,
      top: box.top,
    })));
    await sharp({ create: { width: size.width, height: size.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite(composites)
      .png()
      .toFile(path);
    return path;
  }

  async function frame(path: string, seconds: number): Promise<Buffer> {
    const { stdout } = await execFileAsync(FFMPEG, [
      "-v", "error", "-ss", seconds.toFixed(3), "-i", path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
    ], { encoding: "buffer", maxBuffer: WIDTH * HEIGHT * 4 });
    return stdout;
  }

  function pixel(pixels: Buffer, point: readonly [number, number]): Rgb {
    const offset = (point[1] * WIDTH + point[0]) * 3;
    return [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
  }

  async function burn(videoPath: string, stills: ReadonlyArray<{ path: string; timing: ResolvedGraphicsTiming }>): Promise<string> {
    const outputPath = scratch("output.mp4");
    await burnGraphics({ videoPath, outputPath, stills, probe: await probeVideo(videoPath), signal: new AbortController().signal });
    return outputPath;
  }

  it("overlays each still only inside its window, at its place, and fades the edges inside the clip", async () => {
    const source = await sourceVideo();
    const output = await burn(source, [
      { path: await still([{ box: { left: 20, top: 20, width: 80, height: 40 }, color: RED }]), timing: WHOLE },
      { path: await still([]), timing: WHOLE },
      { path: await still([{ box: { left: 140, top: 300, width: 100, height: 60 }, color: GREEN }]), timing: MIDDLE },
      { path: await still([{ box: { left: 220, top: 560, width: 100, height: 40 }, color: YELLOW }]), timing: TAIL },
    ]);
    const [sourceProbe, outputProbe] = await Promise.all([probeVideo(source), probeVideo(output)]);
    expect(outputProbe).toMatchObject({ width: WIDTH, height: HEIGHT, hasAudio: true });
    expect(Math.abs(outputProbe.duration - sourceProbe.duration)).toBeLessThan(0.2);

    const early = await frame(output, 0.5);
    expect(distance(pixel(early, RED_POINT), RED)).toBeLessThan(60);
    expect(distance(pixel(early, GREEN_POINT), BACKGROUND)).toBeLessThan(30);
    expect(distance(pixel(early, YELLOW_POINT), BACKGROUND)).toBeLessThan(30);
    expect(distance(pixel(early, [300, 150]), BACKGROUND)).toBeLessThan(30);

    const fading = pixel(await frame(output, 1.25), GREEN_POINT);
    expect(fading[1]).toBeGreaterThan(130);
    expect(fading[1]).toBeLessThan(225);
    expect(fading[2]).toBeGreaterThan(40);
    expect(fading[2]).toBeLessThan(130);

    const middle = await frame(output, 2);
    expect(distance(pixel(middle, GREEN_POINT), GREEN)).toBeLessThan(60);
    expect(distance(pixel(middle, RED_POINT), RED)).toBeLessThan(60);
    expect(distance(pixel(middle, YELLOW_POINT), BACKGROUND)).toBeLessThan(30);

    const late = await frame(output, 3.6);
    expect(distance(pixel(late, GREEN_POINT), BACKGROUND)).toBeLessThan(30);
    expect(distance(pixel(late, YELLOW_POINT), YELLOW)).toBeLessThan(60);
    expect(distance(pixel(late, RED_POINT), RED)).toBeLessThan(60);
  });

  it("draws in display geometry over a video stored rotated", async () => {
    const source = await sourceVideo({ rotated: true });
    const sourceProbe = await probeVideo(source);
    expect([sourceProbe.width, sourceProbe.height, sourceProbe.videoStream?.video?.rotationDegrees]).toEqual([HEIGHT, WIDTH, 90]);
    const output = await burn(source, [{ path: await still([{ box: { left: 20, top: 20, width: 80, height: 40 }, color: RED }]), timing: WHOLE }]);
    const outputProbe = await probeVideo(output);
    expect([outputProbe.width, outputProbe.height, outputProbe.videoStream?.video?.rotationDegrees ?? 0]).toEqual([WIDTH, HEIGHT, 0]);
    const pixels = await frame(output, 1);
    expect(distance(pixel(pixels, RED_POINT), RED)).toBeLessThan(60);
    expect(distance(pixel(pixels, GREEN_POINT), BACKGROUND)).toBeLessThan(30);
  });

  it("refuses stills of another size and a set with nothing to draw, leaving no output", async () => {
    const source = await sourceVideo();
    const probe = await probeVideo(source);
    const signal = new AbortController().signal;
    const outputPath = scratch("refused.mp4");
    const small = await still([{ box: { left: 0, top: 0, width: 10, height: 10 }, color: RED }], { width: 100, height: 100 });
    await expect(burnGraphics({ videoPath: source, outputPath, stills: [{ path: small, timing: WHOLE }], probe, signal }))
      .rejects.toThrow(/100x100, but the video is 360x640/u);
    await expect(burnGraphics({ videoPath: source, outputPath, stills: [{ path: await still([]), timing: WHOLE }], probe, signal }))
      .rejects.toThrow(/nothing to draw/u);
    await expect(burnGraphics({ videoPath: source, outputPath, stills: [], probe, signal })).rejects.toThrow(/nothing to draw/u);
    await expect(access(outputPath)).rejects.toThrow();
  });
});
