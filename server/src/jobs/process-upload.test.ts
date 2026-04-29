import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFsForTest } from "../fs.js";
import { findUnprocessedUploads } from "./process-upload.js";
import { queue } from "../queue.js";
import type { ClipfirstFs } from "clipfirst-engine";

describe("findUnprocessedUploads", () => {
  let tempDir: string;
  let fs: ClipfirstFs;

  beforeAll(async () => {
    await queue.start();
  });

  afterAll(async () => {
    await queue.stop();
  });

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-upload-test-"));
    fs = createFsForTest(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("returns empty array when project has no assets", async () => {
    const createResult = await fs.createProject("test-proj");
    expect(createResult.ok).toBe(true);

    const result = await findUnprocessedUploads(fs, "test-proj", []);
    expect(result).toEqual([]);
  });

  it("returns empty array when all assets are already processed", async () => {
    const createResult = await fs.createProject("test-proj");
    expect(createResult.ok).toBe(true);

    // Create an asset via fs with prefix + name
    const assetResult = await fs.createAsset("img", "photo", "test-proj");
    expect(assetResult.ok).toBe(true);
    if (!assetResult.ok) return;

    const assetId = assetResult.value.assetId;

    const pngData = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
      "base64",
    );
    await fs.writeFile(assetId, "original.png", pngData, "test-proj");
    await fs.writeMetadata(assetId, "original", { origin: "upload" }, "test-proj");

    const assets = await fs.listAssets("test-proj");
    expect(assets.length).toBeGreaterThan(0);

    const result = await findUnprocessedUploads(fs, "test-proj", assets);
    expect(result).toEqual([]);
  });

  it("detects an externally-placed file without origin metadata", async () => {
    const createResult = await fs.createProject("test-proj");
    expect(createResult.ok).toBe(true);

    // Create an asset and write a media file but skip origin metadata
    const assetResult = await fs.createAsset("img", "external", "test-proj");
    expect(assetResult.ok).toBe(true);
    if (!assetResult.ok) return;

    const assetId = assetResult.value.assetId;

    const pngData = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
      "base64",
    );
    await fs.writeFile(assetId, "photo.png", pngData, "test-proj");

    const assets = await fs.listAssets("test-proj");
    expect(assets.length).toBeGreaterThan(0);

    const result = await findUnprocessedUploads(fs, "test-proj", assets);
    expect(result.length).toBe(1);
    expect(result[0].assetId).toBe(assetId);
    expect(result[0].mediaFilename).toBe("photo.png");
    expect(result[0].extension).toBe(".png");
    expect(result[0].mediaType).toBe("image");
  });
});
