import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FFMPEG, probeVideo } from "../ffmpeg.js";
import { spliceVideoChain, spliceVideoFiles } from "./splice-video.js";
import { testBudget } from "../test-budget.js";

const execFileAsync = promisify(execFile);

describe("splice video files", () => {
  let tempDir: string;
  let firstPath: string;
  let secondPath: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-splice-video-"));
    firstPath = join(tempDir, "first.mp4");
    secondPath = join(tempDir, "second.mp4");
    await execFileAsync(FFMPEG, [
      "-y",
      "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=10:d=1",
      "-f", "lavfi", "-i", "color=c=red:s=160x90:r=10:d=1",
      "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=10:d=1",
      "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
      "-map", "[v]",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      firstPath,
    ]);
    await execFileAsync(FFMPEG, [
      "-y",
      "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=10:d=1",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      secondPath,
    ]);
  }, testBudget(30_000));

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("concatenates both complete clips when overlap is zero", async () => {
    const first = await probeVideo(firstPath);
    const second = await probeVideo(secondPath);
    const outputPath = join(tempDir, "concat.mp4");

    const result = await spliceVideoFiles({
      firstPath,
      secondPath,
      outputPath,
      width: first.width,
      height: first.height,
      fps: first.fps,
      firstDuration: first.videoDuration,
      secondDuration: second.videoDuration,
      withAudio: false,
      overlap: 0,
    });

    const output = await probeVideo(outputPath);
    expect(result).toEqual({
      timestamp: first.videoDuration,
      frameIndex: null,
      score: null,
    });
    expect(output.videoDuration).toBeCloseTo(first.videoDuration + second.videoDuration, 1);
  }, testBudget(30_000));

  it("only searches for a match inside the requested tail overlap", async () => {
    const first = await probeVideo(firstPath);
    const second = await probeVideo(secondPath);
    const outputPath = join(tempDir, "overlap.mp4");

    const result = await spliceVideoFiles({
      firstPath,
      secondPath,
      outputPath,
      width: first.width,
      height: first.height,
      fps: first.fps,
      firstDuration: first.videoDuration,
      secondDuration: second.videoDuration,
      withAudio: false,
      overlap: 1,
    });

    const output = await probeVideo(outputPath);
    expect(result.timestamp).toBeGreaterThanOrEqual(first.videoDuration - 1.1);
    expect(result.timestamp).toBeLessThan(first.videoDuration);
    expect(result.frameIndex).not.toBeNull();
    expect(result.score).not.toBeNull();
    expect(output.videoDuration).toBeCloseTo(result.timestamp + second.videoDuration, 1);
  }, testBudget(30_000));

  it("concatenates three complete clips in order", async () => {
    const first = await probeVideo(firstPath);
    const second = await probeVideo(secondPath);
    const thirdPath = join(tempDir, "third.mp4");
    await execFileAsync(FFMPEG, [
      "-y",
      "-f", "lavfi", "-i", "color=c=green:s=160x90:r=10:d=1",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      thirdPath,
    ]);
    const third = await probeVideo(thirdPath);
    const outputPath = join(tempDir, "concat-three.mp4");

    const result = await spliceVideoChain({
      clips: [
        { path: firstPath, duration: first.videoDuration, hasAudio: false },
        { path: secondPath, duration: second.videoDuration, hasAudio: false },
        { path: thirdPath, duration: third.videoDuration, hasAudio: false },
      ],
      outputPath,
      workDir: tempDir,
      width: first.width,
      height: first.height,
      fps: first.fps,
      overlap: 0,
    });

    const output = await probeVideo(outputPath);
    expect(result.frameIndex).toBeNull();
    expect(output.videoDuration).toBeCloseTo(
      first.videoDuration + second.videoDuration + third.videoDuration,
      1,
    );
  }, testBudget(30_000));

  it("rejects a completed file whose duration is shorter than both clips", async () => {
    const first = await probeVideo(firstPath);
    const second = await probeVideo(secondPath);
    await expect(spliceVideoFiles({
      firstPath,
      secondPath,
      outputPath: join(tempDir, "truncated.mp4"),
      width: first.width,
      height: first.height,
      fps: first.fps,
      firstDuration: first.videoDuration,
      secondDuration: second.videoDuration + 2,
      withAudio: false,
      overlap: 0,
    })).rejects.toThrow("does not match expected");
  }, testBudget(30_000));

  it("rejects negative overlap", async () => {
    const first = await probeVideo(firstPath);
    const second = await probeVideo(secondPath);
    await expect(spliceVideoFiles({
      firstPath,
      secondPath,
      outputPath: join(tempDir, "invalid.mp4"),
      width: first.width,
      height: first.height,
      fps: first.fps,
      firstDuration: first.videoDuration,
      secondDuration: second.videoDuration,
      withAudio: false,
      overlap: -1,
    })).rejects.toThrow("non-negative");
  });
});
