import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-dl-validate-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("succeeds when output file exists with content", async () => {
    const { validateDownloadOutput } = await import("./download-video.js");
    const outputPath = join(tempDir, "original.mp4");
    await writeFile(outputPath, "fake-video-content");

    // Should not throw
    await validateDownloadOutput(outputPath);
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
