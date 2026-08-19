import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { FFMPEG, probeVideo } from "../ffmpeg.js";
import { COMMON_VIDEO_FIXTURES, copyVideoFixture } from "../test-media-fixtures.js";
import {
  buildAudioFilter,
  buildReencodeArgs,
  planTimelineVideo,
  type TimelineVideoProbe,
} from "./render-timeline.js";

const execFileAsync = promisify(execFile);

describe("render-timeline job handler", () => {
  it("exports registerRenderTimelineJob function", async () => {
    const mod = await import("./render-timeline.js");
    expect(typeof mod.registerRenderTimelineJob).toBe("function");
  });

  it("registerRenderTimelineJob accepts a fs argument", async () => {
    const mod = await import("./render-timeline.js");
    expect(mod.registerRenderTimelineJob.length).toBe(1);
  });
});

describe("render-timeline constants", () => {
  it("uses expected render filenames from remotion constants", async () => {
    const constants = await import("../remotion/constants.js");
    expect(constants.LANDSCAPE_WIDTH).toBe(1920);
    expect(constants.LANDSCAPE_HEIGHT).toBe(1080);
    expect(constants.PORTRAIT_WIDTH).toBe(1080);
    expect(constants.PORTRAIT_HEIGHT).toBe(1920);
    expect(constants.SQUARE_WIDTH).toBe(1080);
    expect(constants.SQUARE_HEIGHT).toBe(1080);
  });
});

describe("buildAudioFilter", () => {
  const slot = { artifactId: "vid-a", volume: 100, fadeIn: 0, fadeOut: 0, assetDir: "/tmp" };

  it("uses the real a:0 stream when the slot has audio", () => {
    const filter = buildAudioFilter(1, slot, 4.5, true);
    expect(filter.startsWith("[1:a:0]")).toBe(true);
    expect(filter).toContain("[a1]");
    expect(filter).not.toContain("anullsrc");
  });

  it("synthesizes silence for silent slots instead of requiring a:0", () => {
    const filter = buildAudioFilter(2, { ...slot, volume: 50, fadeIn: 200 }, 3, false);
    expect(filter).toContain("anullsrc=");
    expect(filter).toContain("atrim=0:3");
    expect(filter).toContain("volume=0.5");
    expect(filter).not.toMatch(/\[2:a:0\]/);
    expect(filter.endsWith("[a2]")).toBe(true);
  });
});

describe("planTimelineVideo", () => {
  const cfr30: TimelineVideoProbe = {
    fps: 30,
    avgFps: 30,
    width: 1920,
    height: 1080,
    videoCodec: "h264",
  };

  it("stream-copies when all inputs are uniform CFR h264", () => {
    expect(planTimelineVideo([cfr30, { ...cfr30 }])).toEqual({ mode: "copy" });
  });

  it("re-encodes at 30fps when slot frame rates differ", () => {
    const plan = planTimelineVideo([cfr30, { ...cfr30, fps: 24, avgFps: 24 }]);
    expect(plan.mode).toBe("reencode");
    if (plan.mode !== "reencode") return;
    expect(plan.targetFps).toBe(30);
    expect(plan.reasons).toContain("mixed frame rates");
  });

  it("re-encodes VFR input at its own nominal rate", () => {
    // The skips-on-X shape: nominal 24fps, measured ~25.2fps.
    const plan = planTimelineVideo([{ ...cfr30, fps: 24, avgFps: 25.19 }]);
    expect(plan.mode).toBe("reencode");
    if (plan.mode !== "reencode") return;
    expect(plan.targetFps).toBe(24);
    expect(plan.reasons).toContain("variable frame rate input");
  });

  it("tolerates rounding noise in the measured rate", () => {
    expect(planTimelineVideo([{ ...cfr30, avgFps: 30.001 }])).toEqual({ mode: "copy" });
  });

  it("re-encodes non-h264 and mixed-resolution inputs", () => {
    const hevc = planTimelineVideo([{ ...cfr30, videoCodec: "hevc" }]);
    expect(hevc.mode).toBe("reencode");
    const mixedSize = planTimelineVideo([cfr30, { ...cfr30, width: 1280, height: 720 }]);
    expect(mixedSize.mode).toBe("reencode");
    if (mixedSize.mode !== "reencode") return;
    expect(mixedSize.reasons).toContain("mixed resolutions");
  });

  it("treats a null measured rate as not-VFR", () => {
    expect(planTimelineVideo([{ ...cfr30, avgFps: null }])).toEqual({ mode: "copy" });
  });
});

describe("timeline re-encode with real ffmpeg", () => {
  let workDir: string;
  let clip24: string;
  let clip30: string;

  async function makeClip(path: string, rate: number): Promise<void> {
    await copyVideoFixture(COMMON_VIDEO_FIXTURES.timeline(rate), path);
  }

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "render-timeline-test-"));
    clip24 = join(workDir, "clip24.mp4");
    clip30 = join(workDir, "clip30.mp4");
    await Promise.all([makeClip(clip24, 24), makeClip(clip30, 30)]);
  }, 60_000);

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("concatenating mixed-fps slots produces a constant-frame-rate file", async () => {
    const slots = [
      { artifactId: "vid-a", volume: 100, fadeIn: 0, fadeOut: 0, assetDir: workDir },
      { artifactId: "vid-b", volume: 100, fadeIn: 0, fadeOut: 0, assetDir: workDir },
    ];
    const probes = await Promise.all([probeVideo(clip24), probeVideo(clip30)]);
    const plan = planTimelineVideo(
      probes.map((p) => ({
        fps: p.fps,
        avgFps: p.avgFps,
        width: p.width,
        height: p.height,
        videoCodec: p.videoCodec,
      })),
    );
    expect(plan.mode).toBe("reencode");
    if (plan.mode !== "reencode") return;

    const outputPath = join(workDir, "timeline.mp4");
    const args = buildReencodeArgs({
      inputPaths: [clip24, clip30],
      resolvedSlots: slots,
      durations: probes.map((p) => p.duration),
      hasAudioFlags: probes.map((p) => p.hasAudio),
      resolvedAudio: [],
      plan,
      outputPath,
    });
    await execFileAsync(FFMPEG, args);

    const result = await probeVideo(outputPath);
    expect(result.fps).toBe(30);
    expect(result.avgFps).not.toBeNull();
    expect(Math.abs((result.avgFps ?? 0) - result.fps)).toBeLessThan(0.05);
    expect(result.width).toBe(320);
    expect(result.height).toBe(240);
    expect(result.hasAudio).toBe(true);
    expect(result.duration).toBeGreaterThan(1.8);
    expect(result.duration).toBeLessThan(2.3);
  }, 60_000);
});
