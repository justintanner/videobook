import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  applyRequestedDownloadRange,
  isImageContent,
  imageExtension,
} from "./download-video.js";
import { closeEngineForTest, createEngineForTest } from "../fs.js";
import { probeVideo, runFfmpeg } from "../ffmpeg.js";

describe("applyRequestedDownloadRange", () => {
  it("persists an exact first-30-seconds original", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "videobook-download-range-"));
    const engineRoot = join(tempDir, "engine");
    const engine = createEngineForTest(engineRoot);
    try {
      const artifact = await engine.artifacts.create("vid", "range-source");
      if (!artifact.ok) throw new Error(artifact.error.message);
      const sourcePath = join(tempDir, "source.mp4");
      await runFfmpeg([
        "-y",
        "-f", "lavfi", "-i", "color=c=black:s=16x16:d=32:r=10",
        "-pix_fmt", "yuv420p",
        "-c:v", "libx264", "-preset", "ultrafast",
        "-movflags", "+faststart",
        sourcePath,
      ]);
      const written = await engine.files.writeFromPath(
        artifact.value.artifactId,
        "original.mp4",
        sourcePath,
      );
      if (!written.ok) throw new Error(written.error.message);

      const applied = await applyRequestedDownloadRange(
        engine,
        artifact.value.artifactId,
        artifact.value.path,
        written.value,
        { start: 0, end: 30 },
      );

      const media = await probeVideo(written.value);
      expect(applied).toBe(true);
      expect(media.duration).toBeGreaterThanOrEqual(29.9);
      expect(media.duration).toBeLessThanOrEqual(30.05);
    } finally {
      closeEngineForTest(engineRoot, engine);
      await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});

describe("download-video job handler", () => {
  it("exports registerDownloadVideoJob function", async () => {
    const mod = await import("./download-video.js");
    expect(typeof mod.registerDownloadVideoJob).toBe("function");
  });

  it("registerDownloadVideoJob accepts a fs argument", async () => {
    const mod = await import("./download-video.js");
    expect(mod.registerDownloadVideoJob.length).toBe(1);
  });
});

describe("validateDownloadOutput (RC1)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-dl-validate-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function writeValidMp4(path: string): Promise<void> {
    await runFfmpeg([
      "-y",
      "-f", "lavfi", "-i", "color=c=black:s=16x16:d=0.1:r=10",
      "-pix_fmt", "yuv420p",
      "-c:v", "libx264", "-preset", "ultrafast",
      "-movflags", "+faststart",
      path,
    ]);
  }

  it("succeeds when output file exists and contains a valid mp4", async () => {
    const { validateDownloadOutput } = await import("./download-video.js");
    const outputPath = join(tempDir, "original.mp4");
    await writeValidMp4(outputPath);

    // Should not throw
    await validateDownloadOutput(outputPath);
  });

  it("throws when the file is non-empty but not a decodable container", async () => {
    // Regression: yt-dlp can finalize a non-empty mp4 missing its moov atom
    // when --download-sections is interrupted. The size check passed but
    // process_video would then fail mid-pipeline and strand the asset.
    const { validateDownloadOutput } = await import("./download-video.js");
    const { access } = await import("node:fs/promises");
    const outputPath = join(tempDir, "original.mp4");
    await writeFile(outputPath, "fake-video-content-no-moov-atom");

    await expect(validateDownloadOutput(outputPath)).rejects.toThrow(/unreadable video/i);
    // Broken file is removed so a retry doesn't trip on stale bytes.
    await expect(access(outputPath)).rejects.toThrow();
  });

  it("throws when output file is missing and .part file exists", async () => {
    const { validateDownloadOutput } = await import("./download-video.js");
    const outputPath = join(tempDir, "original.mp4");
    // Only .part file exists (simulating failed download)
    await writeFile(outputPath + ".part", "");

    await expect(validateDownloadOutput(outputPath)).rejects.toThrow(/download incomplete/i);
  });

  it("removes the .part file when cleaning up failed download", async () => {
    const { validateDownloadOutput } = await import("./download-video.js");
    const { access } = await import("node:fs/promises");
    const outputPath = join(tempDir, "original.mp4");
    await writeFile(outputPath + ".part", "");

    await expect(validateDownloadOutput(outputPath)).rejects.toThrow();

    // .part file should be cleaned up
    await expect(access(outputPath + ".part")).rejects.toThrow();
  });

  it("throws when output file is missing and no .part file exists", async () => {
    const { validateDownloadOutput } = await import("./download-video.js");
    const outputPath = join(tempDir, "original.mp4");
    // Nothing exists

    await expect(validateDownloadOutput(outputPath)).rejects.toThrow(/download failed/i);
  });

  it("throws when output file exists but is 0 bytes", async () => {
    const { validateDownloadOutput } = await import("./download-video.js");
    const outputPath = join(tempDir, "original.mp4");
    await writeFile(outputPath, ""); // 0 bytes

    await expect(validateDownloadOutput(outputPath)).rejects.toThrow(/empty/i);
  });
});

describe("isImageContent", () => {
  it("returns true for jpg with no video codec", () => {
    expect(isImageContent({ ext: "jpg", vcodec: "none" })).toBe(true);
  });

  it("returns true for png with no vcodec field", () => {
    expect(isImageContent({ ext: "png" })).toBe(true);
  });

  it("returns true for webp with vcodec none", () => {
    expect(isImageContent({ ext: "webp", vcodec: "none" })).toBe(true);
  });

  it("returns false for mp4 with h264 codec", () => {
    expect(isImageContent({ ext: "mp4", vcodec: "h264" })).toBe(false);
  });

  it("returns false when ext is mp4 even without vcodec", () => {
    expect(isImageContent({ ext: "mp4" })).toBe(false);
  });

  it("returns false when no ext is set", () => {
    expect(isImageContent({})).toBe(false);
  });

  it("returns false for image ext with a real video codec", () => {
    expect(isImageContent({ ext: "jpg", vcodec: "h264" })).toBe(false);
  });

  it("handles case-insensitive extensions", () => {
    expect(isImageContent({ ext: "JPG", vcodec: "none" })).toBe(true);
    expect(isImageContent({ ext: "PNG" })).toBe(true);
  });
});

describe("imageExtension", () => {
  it("returns .jpg for jpg ext", () => {
    expect(imageExtension({ ext: "jpg" })).toBe(".jpg");
  });

  it("returns .png for png ext", () => {
    expect(imageExtension({ ext: "png" })).toBe(".png");
  });

  it("returns .webp for webp ext", () => {
    expect(imageExtension({ ext: "webp" })).toBe(".webp");
  });

  it("defaults to .jpg when ext is missing", () => {
    expect(imageExtension({})).toBe(".jpg");
  });

  it("defaults to .jpg for non-image ext", () => {
    expect(imageExtension({ ext: "mp4" })).toBe(".jpg");
  });
});
