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
  summarizeFfmpegStderr,
  withQuietFfmpegArgs,
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
    expect(result.videoDuration).toBeGreaterThan(0.8);
    expect(result.videoDuration).toBeLessThan(1.5);
    expect(result.audioDuration).not.toBeNull();
    expect(result.audioDuration!).toBeGreaterThan(0.8);
    expect(result.audioDuration!).toBeLessThan(1.5);
    expect(result.fps).toBe(30);
    expect(result.hasAudio).toBe(true);
    expect(result.videoStream).toMatchObject({
      index: 0,
      codec: "h264",
      video: {
        width: 320,
        height: 240,
        pixelAspect: { numerator: 1, denominator: 1 },
      },
    });
    expect(result.videoStream?.durationTicks).toBeGreaterThan(0);
    expect(result.audioStream).toMatchObject({
      codec: "aac",
      audio: {
        sampleRateHz: 44_100,
        channels: 1,
        channelLayout: "mono",
      },
    });
    expect(result.audioStream?.durationTicks).toBeGreaterThan(0);
  });

  it("reports separate video and audio stream durations", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ffmpeg-test-"));
    const videoPath = join(tempDir, "different-durations.mp4");

    await execFileAsync(FFMPEG, [
      "-f", "lavfi", "-i", "testsrc=duration=1:size=320x240:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1.6",
      "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac",
      "-pix_fmt", "yuv420p",
      "-y", videoPath,
    ]);

    const result = await probeVideo(videoPath);

    expect(result.videoDuration).toBeGreaterThan(0.9);
    expect(result.videoDuration).toBeLessThan(1.1);
    expect(result.audioDuration).not.toBeNull();
    expect(result.audioDuration!).toBeGreaterThan(1.5);
    expect(result.audioDuration!).toBeLessThan(1.7);
    expect(result.duration).toBeGreaterThanOrEqual(result.audioDuration!);
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
    expect(result.videoDuration).toBeGreaterThan(0.8);
    expect(result.audioDuration).toBeNull();
    expect(result.hasAudio).toBe(false);
    expect(result.videoStream).not.toBeNull();
    expect(result.audioStream).toBeNull();
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

  it("terminates ffmpeg when its process deadline expires", async () => {
    await expect(
      runFfmpeg([
        "-f", "lavfi",
        "-i", "testsrc=size=16x16:rate=30",
        "-f", "null",
        "-",
      ], { timeoutMs: 50 }),
    ).rejects.toThrow("ffmpeg timed out after 50ms");
  });

  it("error message excludes the ffmpeg version banner", async () => {
    let caught: Error | null = null;
    try {
      await runFfmpeg(["-i", "/nonexistent/file.mp4", "-y", "/tmp/out.mp4"]);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/^ffmpeg failed:/);
    expect(caught!.message).not.toContain("ffmpeg version");
    expect(caught!.message).not.toContain("Copyright (c)");
    expect(caught!.message).not.toContain("built with");
    expect(caught!.message).not.toContain("configuration:");
    expect(caught!.message).not.toMatch(/lib\w+\s+\d+\./);
    expect(caught!.message.length).toBeLessThan(800);
    expect(caught!.message.toLowerCase()).toMatch(/no such file|does not exist|error opening|no such file or directory|invalid/);
  });
});

describe("withQuietFfmpegArgs", () => {
  it("prepends hide_banner and loglevel error once", () => {
    expect(withQuietFfmpegArgs(["-i", "in.mp4", "out.mp4"])).toEqual([
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "in.mp4",
      "out.mp4",
    ]);
  });

  it("leaves explicit loglevel/hide_banner callers unchanged", () => {
    const args = ["-hide_banner", "-nostats", "-loglevel", "info", "-i", "in.mp4"];
    expect(withQuietFfmpegArgs(args)).toEqual(args);
  });
});

describe("summarizeFfmpegStderr", () => {
  it("strips banner and keeps the actual error tail", () => {
    const stderr = `ffmpeg version 6.0 Copyright (c) 2000-2023 the FFmpeg developers
  built with Apple clang version 13.1.6 (clang-1316.0.21.2.5)
  configuration: --prefix=/Volumes/tempdisk/sw --extra-cflags=-fno-stack-check
  libavutil      58.  2.100 / 58.  2.100
  libavcodec     60.  3.100 / 60.  3.100
  libavformat    60.  3.100 / 60.  3.100
  libpostproc    57.  1.100 / 57.  1.100
Input #0, concat, from '/path/to/concat.txt':
  Duration: N/A, bitrate: N/A
Output #0, mp4, to '/path/to/original_trimmed.mp4':
[out#0/mp4 @ 0x600000150540] Output file does not contain any stream
`;
    const result = summarizeFfmpegStderr(stderr);
    expect(result).not.toContain("ffmpeg version");
    expect(result).not.toContain("Copyright");
    expect(result).not.toContain("configuration:");
    expect(result).not.toContain("libavutil");
    expect(result).toContain("Output file does not contain any stream");
    expect(result).toContain("Input #0, concat");
    expect(result.length).toBeLessThan(600);
  });

  it("drops frame= progress lines", () => {
    const stderr = `frame=  120 fps= 60 q=23.0 size=    1024kB time=00:00:04.00 bitrate=2097.2kbits/s
frame=  240 fps= 60 q=23.0 size=    2048kB time=00:00:08.00 bitrate=2097.2kbits/s
[error] could not write trailer
Conversion failed!
`;
    const result = summarizeFfmpegStderr(stderr);
    expect(result).not.toContain("frame=");
    expect(result).toContain("could not write trailer");
    expect(result).toContain("Conversion failed");
  });

  it("preserves the root cause and final failure when truncating", () => {
    const stderr = [
      "[Parsed_xfade_14] The inputs need a constant frame rate",
      ...Array.from({ length: 8 }, (_, index) => `diagnostic detail ${index}: ${"x".repeat(30)}`),
      "Nothing was written into output file",
    ].join("\n");

    const result = summarizeFfmpegStderr(stderr, 160);
    expect(result).toContain("constant frame rate");
    expect(result).toContain("Nothing was written");
    expect(result.length).toBeLessThanOrEqual(160);
  });

  it("falls back gracefully when stderr is empty", () => {
    expect(summarizeFfmpegStderr("")).toBe("");
  });
});

describe("getFFmpeggy", () => {
  it("returns an object with probe method", async () => {
    const FFmpeggy = await getFFmpeggy();

    expect(FFmpeggy).toBeDefined();
    expect(typeof FFmpeggy.probe).toBe("function");
  });
});
