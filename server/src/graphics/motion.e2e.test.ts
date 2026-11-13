import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FFMPEG, probeVideo } from "../ffmpeg.js";
import { testBudget } from "../test-budget.js";
import { burnGraphics } from "./burn.js";
import { layoutGraphics } from "./layout.js";
import { graphicsDocumentFromLayers } from "./model.js";
import { renderGraphicsStills } from "./render-stills.js";
import { groupMotionAt, resolveLayerTiming } from "./timing.js";

const execFileAsync = promisify(execFile);
const FRAME = { width: 640, height: 480 };
const FPS = 12;
const DURATION = 4;

function redBox(pixels: Buffer, threshold: number): { x: number; y: number; width: number; height: number } | null {
  let minX = FRAME.width;
  let minY = FRAME.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < FRAME.height; y += 1) {
    for (let x = 0; x < FRAME.width; x += 1) {
      const at = (y * FRAME.width + x) * 3;
      if (pixels[at] < threshold || pixels[at] < pixels[at + 1] * 3 || pixels[at] < pixels[at + 2] * 3) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

describe("graphics motion render parity", () => {
  let root: string;
  let source: string;
  let logo: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "videobook-motion-"));
    source = join(root, "source.mp4");
    logo = join(root, "logo.png");
    await sharp({ create: { width: 160, height: 80, channels: 4, background: "#FF0000" } }).png().toFile(logo);
    await execFileAsync(FFMPEG, ["-y", "-v", "error", "-f", "lavfi", "-i", `color=black:s=640x480:r=${FPS}:d=${DURATION}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", source], { timeout: testBudget(30_000) });
  }, testBudget(60_000));

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("reveals laid-out words in order and hides them on exit", async () => {
    const outputDir = join(root, "words");
    await mkdir(outputDir);
    const document = graphicsDocumentFromLayers([{
      kind: "text", width: 0.9, align: "left", position: { space: "frame", anchor: "top-left", x: 0.05, y: 0.3 },
      timing: { start: 1, end: 3, fade: 0.5, enter: "words", exit: "words" },
      items: [{ text: "ONE TWO THREE FOUR FIVE SIX SEVEN EIGHT", shadow: false, size: 0.06, maxLines: 3 }],
    }]);
    const { groups } = await renderGraphicsStills({ document, frame: FRAME, durationSeconds: DURATION, fps: FPS, images: {}, outputDir, signal: new AbortController().signal });
    const counts: number[][] = [];
    for (const transition of groups[0].transitions ?? []) {
      const pixels: number[] = [];
      for (const path of transition.paths) {
        const alpha = await sharp(path).ensureAlpha().extractChannel("alpha").raw().toBuffer();
        pixels.push(alpha.reduce((sum, value) => sum + (value > 128 ? 1 : 0), 0));
      }
      counts.push(pixels);
    }
    expect(counts).toHaveLength(2);
    expect(counts[0][0]).toBe(0);
    expect(counts[0][1]).toBeGreaterThan(0);
    expect(counts[0][1]).toBeLessThan(counts[0].at(-1)!);
    expect(counts[0]).toEqual([...counts[0]].sort((a, b) => a - b));
    expect(counts[1]).toEqual([...counts[1]].sort((a, b) => b - a));
    expect(counts[1].at(-1)).toBeLessThan(counts[1][0]);
  }, testBudget(180_000));

  it.each(["slide", "pop"] as const)("matches preview geometry for %s at source fps through both transitions", async (preset) => {
    const outputDir = join(root, preset);
    await mkdir(outputDir);
    const document = graphicsDocumentFromLayers([{
      kind: "image", artifactId: "logo", size: 1 / 3,
      position: { space: "frame", anchor: "top-left", x: 0.25, y: 1 / 3 },
      timing: { start: 1, end: 3, fade: 0.5, enter: preset, exit: preset },
    }]);
    const images = { logo: { path: logo, width: 160, height: 80 } };
    const signal = new AbortController().signal;
    const probe = await probeVideo(source);
    const { groups } = await renderGraphicsStills({ document, frame: FRAME, durationSeconds: DURATION, fps: probe.fps, images, outputDir, signal });
    expect(groups[0].transitions?.map((entry) => entry.paths.length)).toEqual([6, 6]);
    const outputPath = join(outputDir, "burn.mp4");
    await burnGraphics({ videoPath: source, outputPath, stills: groups, probe, signal });
    const box = layoutGraphics({ document, frame: FRAME, images, measure: () => 0 })[0].box;
    const timing = resolveLayerTiming(document.layers[0].timing, DURATION);
    for (const seconds of [0.5, 1, 1.25, 1.5, 2, 2.5, 2.75, 3, 3.5]) {
      const { stdout } = await execFileAsync(FFMPEG, ["-v", "error", "-i", outputPath, "-vf", `select=eq(n\\,${Math.round(seconds * FPS)})`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { encoding: "buffer", maxBuffer: FRAME.width * FRAME.height * 4, timeout: testBudget(30_000) });
      const motion = groupMotionAt(timing, seconds, { ...box, frameWidth: FRAME.width, frameHeight: FRAME.height });
      const actual = redBox(stdout, Math.max(12, motion.opacity * 255 / 2));
      if (seconds <= 1 || seconds >= 3) {
        expect(actual, `hidden at ${seconds}`).toBeNull();
        continue;
      }
      expect(actual, `visible at ${seconds}`).not.toBeNull();
      if (!actual) continue;
      const left = box.x + motion.dx + box.width * (1 - motion.scale) / 2;
      const top = box.y + motion.dy + box.height * (1 - motion.scale) / 2;
      const right = Math.min(FRAME.width, left + box.width * motion.scale);
      const bottom = Math.min(FRAME.height, top + box.height * motion.scale);
      expect(Math.abs(actual.x - Math.max(0, left)), `x at ${seconds}`).toBeLessThanOrEqual(1);
      expect(Math.abs(actual.y - Math.max(0, top)), `y at ${seconds}`).toBeLessThanOrEqual(1);
      expect(Math.abs(actual.width - (right - Math.max(0, left))) / box.width, `width at ${seconds}`).toBeLessThanOrEqual(0.02);
      expect(Math.abs(actual.height - (bottom - Math.max(0, top))) / box.height, `height at ${seconds}`).toBeLessThanOrEqual(0.02);
    }
  }, testBudget(180_000));
});
