import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { runFfmpeg } from "../ffmpeg.js";
import { extractKeywordFrames } from "./analyze-keyword-placement.js";
import type { KeywordGraphic } from "../remotion/subtitles/types.js";

describe("extractKeywordFrames", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it("extracts one exact midpoint frame per cue and builds a hidden contact sheet", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-keyword-extract-test-"));
    const videoPath = join(tempDir, "source.mp4");
    await runFfmpeg([
      "-y",
      "-f", "lavfi",
      "-i", "color=c=blue:s=640x360:d=2",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      videoPath,
    ]);
    const graphics: KeywordGraphic[] = [
      { text: "Alpha", start: 0.4, end: 1.2, frameTime: 0.6, side: "right" },
      { text: "Bravo", start: 1.2, end: 2.5, frameTime: 1.5, side: "left" },
    ];

    const result = await extractKeywordFrames(videoPath, graphics, 2);

    expect(result.frames.map((frame) => frame.frameTime)).toEqual([0.6, 1.5]);
    expect(result.frames.every((frame) => frame.buffer.length > 0)).toBe(true);
    const metadata = await sharp(result.contactSheet).metadata();
    expect(metadata.width).toBe(1280);
    expect(metadata.height).toBe(408);
  });
});
