import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeEngineForTest, createEngineForTest } from "../fs.js";
import { findUnprocessedUploads } from "./process-upload.js";
import { queue } from "../queue.js";
import type { Engine } from "videobook-engine";

describe("findUnprocessedUploads", () => {
  let tempDir: string;
  let fs: Engine;

  beforeAll(async () => {
    await queue.start();
  });

  afterAll(async () => {
    await queue.stop();
  });

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-upload-test-"));
    fs = createEngineForTest(tempDir);
  });

  afterEach(async () => {
    closeEngineForTest(tempDir, fs);
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("returns empty array when project has no assets", async () => {
    const result = await findUnprocessedUploads(fs, []);
    expect(result).toEqual([]);
  });

  it("returns empty array when all assets are already processed", async () => {
    // Create an asset via fs with prefix + name
    const assetResult = await fs.artifacts.create("img", "photo");
    expect(assetResult.ok).toBe(true);
    if (!assetResult.ok) return;

    const assetId = assetResult.value.artifactId;

    const pngData = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
      "base64",
    );
    await fs.files.write(assetId, "original.png", pngData);
    await fs.metadata.artifacts.write(assetId, "original", { origin: "upload" });

    const assets = await fs.artifacts.list();
    expect(assets.length).toBeGreaterThan(0);

    const result = await findUnprocessedUploads(fs, assets);
    expect(result).toEqual([]);
  });

  it("detects an externally-placed file without origin metadata", async () => {
    // Create an asset and write a media file but skip origin metadata
    const assetResult = await fs.artifacts.create("img", "external");
    expect(assetResult.ok).toBe(true);
    if (!assetResult.ok) return;

    const assetId = assetResult.value.artifactId;

    const pngData = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
      "base64",
    );
    await fs.files.write(assetId, "photo.png", pngData);

    const assets = await fs.artifacts.list();
    expect(assets.length).toBeGreaterThan(0);

    const result = await findUnprocessedUploads(fs, assets);
    expect(result.length).toBe(1);
    expect(result[0].assetId).toBe(assetId);
    expect(result[0].mediaFilename).toBe("photo.png");
    expect(result[0].extension).toBe(".png");
    expect(result[0].mediaType).toBe("image");
  });

  it("classifies a vid- asset by prefix even when an OG thumbnail is present", async () => {
    // Regression: a download_video that succeeds but whose process_video then
    // fails leaves original.mp4 + original.jpg (the promoted OG thumbnail) on
    // disk. The previous extension-first selector picked original.jpg and
    // enqueued process_image in a tight retry loop.
    const assetResult = await fs.artifacts.create("vid", "from-yt");
    expect(assetResult.ok).toBe(true);
    if (!assetResult.ok) return;
    const assetId = assetResult.value.artifactId;

    const pngData = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
      "base64",
    );
    await fs.files.write(assetId, "original.jpg", pngData);
    await fs.files.write(assetId, "original.mp4", Buffer.from("fake-mp4-bytes"));

    const assets = await fs.artifacts.list();
    const result = await findUnprocessedUploads(fs, assets);

    expect(result.length).toBe(1);
    expect(result[0].assetId).toBe(assetId);
    expect(result[0].mediaFilename).toBe("original.mp4");
    expect(result[0].mediaType).toBe("video");
  });

  it("skips an image asset that already has process_image variants but lost its origin metadata", async () => {
    // Regression: when process_image's writeMetadata commit lags behind the
    // variant writes, a sync-sweep race used to pick `landscape.jpg` (the
    // alphabetically first matching file) and rename it to `original.jpg`,
    // permanently cropping a portrait PNG into a 1920x1080 landscape JPG.
    const assetResult = await fs.artifacts.create("img", "racey");
    expect(assetResult.ok).toBe(true);
    if (!assetResult.ok) return;
    const assetId = assetResult.value.artifactId;

    const pngData = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
      "base64",
    );
    // Simulate a real post-process_image asset where .original.json is
    // briefly missing: original.png plus the three cropped variants.
    await fs.files.write(assetId, "original.png", pngData);
    await fs.files.write(assetId, "landscape.jpg", Buffer.from("fake"));
    await fs.files.write(assetId, "portrait.jpg", Buffer.from("fake"));
    await fs.files.write(assetId, "square.jpg", Buffer.from("fake"));

    const assets = await fs.artifacts.list();
    const result = await findUnprocessedUploads(fs, assets);

    // The upload that gets processed must be the canonical original.png —
    // never landscape.jpg, which would be promoted into original.jpg by
    // processExternalUpload.
    expect(result.length).toBe(1);
    expect(result[0].assetId).toBe(assetId);
    expect(result[0].mediaFilename).toBe("original.png");
    expect(result[0].extension).toBe(".png");
  });

  it("skips an image asset whose only image files are process_image variants", async () => {
    // Defense in depth: even if original.png is somehow missing but the
    // variants stayed behind, the sweep must not promote a variant to
    // `original.jpg`. Better to leave the asset alone and surface the
    // anomaly than to silently rewrite the canonical original.
    const assetResult = await fs.artifacts.create("img", "variants-only");
    expect(assetResult.ok).toBe(true);
    if (!assetResult.ok) return;
    const assetId = assetResult.value.artifactId;

    await fs.files.write(assetId, "landscape.jpg", Buffer.from("fake"));
    await fs.files.write(assetId, "portrait.jpg", Buffer.from("fake"));
    await fs.files.write(assetId, "square.jpg", Buffer.from("fake"));

    const assets = await fs.artifacts.list();
    const result = await findUnprocessedUploads(fs, assets);

    expect(result).toEqual([]);
  });

  it("skips assets whose prior work is in 'error' state", async () => {
    // Regression: when process_video fails it sets the assets row to 'error'.
    // The engine's lease guard then refuses any new owner, so re-enqueuing
    // produces an infinite "could not claim local lease" failure loop. The
    // sweep must wait for explicit recovery (e.g. /clear-failed-tasks).
    const assetResult = await fs.artifacts.create("vid", "broken");
    expect(assetResult.ok).toBe(true);
    if (!assetResult.ok) return;
    const assetId = assetResult.value.artifactId;

    await fs.files.write(assetId, "original.mp4", Buffer.from("fake-mp4-bytes"));

    // Simulate the failed-job aftermath: lease begun, then failed.
    const begun = await fs.jobs.artifactWork.begin(assetId, { kind: "process", ownerKind: "job", durationMs: 60_000 });
    expect(begun).not.toBeNull();
    if (!begun) return;
    await fs.jobs.artifactWork.fail(assetId, begun.ownerId, { message: "moov atom not found" });

    const assets = await fs.artifacts.list();
    const result = await findUnprocessedUploads(fs, assets);

    expect(result).toEqual([]);
  });
});
