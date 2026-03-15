import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  FFMPEG,
  FFPROBE,
  H264_MEDIUM,
  AUDIO_OPTS,
  probeVideo,
  runFfmpeg,
  getFFmpeggy,
} from "./ffmpeg.js";

const execFileAsync = promisify(execFile);

describe("ffmpeg exports", () => {
  it("FFMPEG is a non-empty string", () => {
    expect(typeof FFMPEG).toBe("string");
    expect(FFMPEG.length).toBeGreaterThan(0);
  });

  it("FFPROBE is a non-empty string", () => {
    expect(typeof FFPROBE).toBe("string");
    expect(FFPROBE.length).toBeGreaterThan(0);
  });

  it("H264_MEDIUM is an array of strings", () => {
    expect(Array.isArray(H264_MEDIUM)).toBe(true);
    expect(H264_MEDIUM.length).toBeGreaterThan(0);
    for (const item of H264_MEDIUM) {
      expect(typeof item).toBe("string");
    }
  });

  it("AUDIO_OPTS is an array of strings", () => {
    expect(Array.isArray(AUDIO_OPTS)).toBe(true);
    expect(AUDIO_OPTS.length).toBeGreaterThan(0);
    for (const item of AUDIO_OPTS) {
      expect(typeof item).toBe("string");
    }
  });
});

describe("probeVideo", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns correct dimensions, duration, fps, and hasAudio for video with audio", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ffmpeg-test-"));
    const videoPath = join(tempDir, "test.mp4");

    await execFileAsync(FFMPEG, [
      "-f", "lavfi", "-i", "testsrc=duration=1:size=320x240:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac",
      "-pix_fmt", "yuv420p",
      "-y", videoPath,
    ]);

    const result = await probeVideo(videoPath);

    expect(result.width).toBe(320);
    expect(result.height).toBe(240);
    expect(result.duration).toBeGreaterThan(0.8);
    expect(result.duration).toBeLessThan(1.5);
    expect(result.fps).toBe(30);
    expect(result.hasAudio).toBe(true);
  });

  it("returns hasAudio false for video without audio", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ffmpeg-test-"));
    const videoPath = join(tempDir, "no-audio.mp4");

    await execFileAsync(FFMPEG, [
      "-f", "lavfi", "-i", "testsrc=duration=1:size=320x240:rate=30",
      "-c:v", "libx264", "-preset", "ultrafast",
      "-pix_fmt", "yuv420p", "-an",
      "-y", videoPath,
    ]);

    const result = await probeVideo(videoPath);

    expect(result.width).toBe(320);
    expect(result.height).toBe(240);
    expect(result.hasAudio).toBe(false);
  });
});

describe("runFfmpeg", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("succeeds with valid args", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ffmpeg-test-"));
    const outputPath = join(tempDir, "output.mp4");

    await expect(
      runFfmpeg([
        "-f", "lavfi", "-i", "testsrc=duration=0.5:size=160x120:rate=10",
        "-c:v", "libx264", "-preset", "ultrafast",
        "-pix_fmt", "yuv420p",
        "-y", outputPath,
      ]),
    ).resolves.toBeUndefined();
  });

  it("throws on invalid args", async () => {
    await expect(
      runFfmpeg(["-i", "/nonexistent/file.mp4", "-y", "/tmp/out.mp4"]),
    ).rejects.toThrow("ffmpeg failed");
  });
});

describe("getFFmpeggy", () => {
  it("returns an object with probe method", async () => {
    const FFmpeggy = await getFFmpeggy();

    expect(FFmpeggy).toBeDefined();
    expect(typeof FFmpeggy.probe).toBe("function");
  });
});
