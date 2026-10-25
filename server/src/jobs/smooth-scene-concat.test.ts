import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FFMPEG, probeVideo } from "../ffmpeg.js";
import { smoothSceneConcatFiles } from "./smooth-scene-concat.js";
import { testBudget } from "../test-budget.js";

const execFileAsync = promisify(execFile);

describe("smooth scene concat files", () => {
  let tempDir: string;
  let firstPath: string;
  let secondPath: string;
  let silentPath: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-smooth-scene-concat-"));
    const audioPath = join(tempDir, "shared.wav");
    firstPath = join(tempDir, "first.mp4");
    secondPath = join(tempDir, "second.mp4");
    silentPath = join(tempDir, "silent.mp4");

    await execFileAsync(FFMPEG, [
      "-y",
      "-f", "lavfi",
      "-i", "anoisesrc=color=pink:amplitude=0.2:duration=4:seed=142:r=48000",
      "-c:a", "pcm_s16le",
      audioPath,
    ]);
    await execFileAsync(FFMPEG, [
      "-y",
      "-f", "lavfi",
      "-i", "color=c=blue:s=160x90:r=20:d=2",
      "-i", audioPath,
      "-t", "2",
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-shortest",
      firstPath,
    ]);
    await execFileAsync(FFMPEG, [
      "-y",
      "-f", "lavfi",
      "-i", "color=c=red:s=120x120:r=24:d=2",
      "-ss", "1.8",
      "-i", audioPath,
      "-t", "2",
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-shortest",
      secondPath,
    ]);
    await execFileAsync(FFMPEG, [
      "-y",
      "-f", "lavfi",
      "-i", "color=c=green:s=120x120:r=24:d=1.5",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      silentPath,
    ]);
  }, testBudget(30_000));

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("aligns shared boundary audio and dissolves between different scenes", async () => {
    const outputPath = join(tempDir, "matched.mp4");
    const result = await smoothSceneConcatFiles({
      firstPath,
      secondPath,
      outputPath,
    });
    const output = await probeVideo(outputPath);

    expect(result.mode).toBe("audio_match");
    expect(result.matchScore).toBeGreaterThan(0.8);
    expect(result.audioOverlapSeconds).toBeCloseTo(0.2, 1);
    expect(result.secondStartSeconds).toBeCloseTo(1.8, 1);
    expect(output.width).toBe(160);
    expect(output.height).toBe(90);
    expect(output.hasAudio).toBe(true);
    expect(Math.abs(output.videoDuration - result.outputDuration)).toBeLessThanOrEqual(
      1 / output.fps + 0.001,
    );
  }, testBudget(30_000));

  it("uses a fixed dissolve and retains one available audio track", async () => {
    const first = await probeVideo(firstPath);
    const second = await probeVideo(silentPath);
    const outputPath = join(tempDir, "fixed.mp4");
    const result = await smoothSceneConcatFiles({
      firstPath,
      secondPath: silentPath,
      outputPath,
      transitionSeconds: 0.25,
    });
    const output = await probeVideo(outputPath);

    expect(result.mode).toBe("fixed");
    expect(result.transitionSeconds).toBe(0.25);
    expect(result.matchScore).toBeNull();
    expect(result.outputDuration).toBeCloseTo(
      first.videoDuration + second.videoDuration - 0.25,
      5,
    );
    expect(output.hasAudio).toBe(true);
    expect(Math.abs(output.videoDuration - result.outputDuration)).toBeLessThanOrEqual(
      1 / output.fps + 0.001,
    );
  }, testBudget(30_000));

  it("rejects a transition as long as either input", async () => {
    await expect(smoothSceneConcatFiles({
      firstPath,
      secondPath: silentPath,
      outputPath: join(tempDir, "invalid.mp4"),
      transitionSeconds: 1.5,
    })).rejects.toThrow("shorter than both");
  });
});
