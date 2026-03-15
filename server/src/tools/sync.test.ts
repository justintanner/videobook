import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { createFsForTest } from "../fs.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ClipfirstFs } from "clipfirst-fs";

describe("sync tool", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "test-proj" },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("sync on empty project returns empty arrays", async () => {
    const result = await client.callTool({
      name: "sync",
      arguments: { project_slug: "test-proj" },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text);
    expect(data.pending).toEqual([]);
    expect(data.completed).toEqual([]);
    expect(data.failed).toEqual([]);
    expect(data.external_uploads).toEqual([]);
    expect(data.auto_render).toEqual([]);
  });

  it("sync after creating assets returns result with no errors", async () => {
    const imgData = Buffer.from("fake-png-data").toString("base64");
    await client.callTool({
      name: "upload_file",
      arguments: { project_slug: "test-proj", filename: "photo.png", data: imgData },
    });

    const result = await client.callTool({
      name: "sync",
      arguments: { project_slug: "test-proj" },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text);
    expect(data).toHaveProperty("pending");
    expect(data).toHaveProperty("completed");
    expect(data).toHaveProperty("failed");
    expect(data).toHaveProperty("external_uploads");
    expect(data).toHaveProperty("auto_render");
  });
});

describe("list_assets tool", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "test-proj" },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("empty project returns empty assets array", async () => {
    const result = await client.callTool({
      name: "list_assets",
      arguments: { project_slug: "test-proj" },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text);
    expect(data.assets).toEqual([]);
  });

  it("lists assets after upload", async () => {
    const imgData = Buffer.from("fake-png-data").toString("base64");
    await client.callTool({
      name: "upload_file",
      arguments: { project_slug: "test-proj", filename: "photo.png", data: imgData },
    });

    const result = await client.callTool({
      name: "list_assets",
      arguments: { project_slug: "test-proj" },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text);
    expect(data.assets.length).toBeGreaterThanOrEqual(1);
    const asset = data.assets[0];
    expect(asset).toHaveProperty("id");
    expect(asset).toHaveProperty("status");
    expect(asset).toHaveProperty("media_url");
  });
});

describe("buildAssetList", () => {
  let fs: ClipfirstFs;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-test-"));
    fs = createFsForTest(tempDir);
    await fs.createProject("test-proj");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("returns empty array for project with no assets", async () => {
    const { buildAssetList } = await import("./sync.js");
    const assets = await buildAssetList(fs, "test-proj");
    expect(assets).toEqual([]);
  });

  it("returns assets with metadata after creating an asset", async () => {
    const { buildAssetList } = await import("./sync.js");
    const createResult = await fs.createAsset("img", "test-asset", "test-proj");
    expect(createResult.ok).toBe(true);

    const assets = await buildAssetList(fs, "test-proj");
    expect(assets.length).toBe(1);
    expect(assets[0].id).toMatch(/^img-/);
    expect(assets[0].type).toBe("image");
    expect(assets[0]).toHaveProperty("status");
    expect(assets[0]).toHaveProperty("media_url");
    expect(assets[0]).toHaveProperty("thumbnail_url");
    expect(assets[0]).toHaveProperty("width");
    expect(assets[0]).toHaveProperty("height");
  });

  it("finds mp4 video as primary media file", async () => {
    const { buildAssetList } = await import("./sync.js");
    const createResult = await fs.createAsset("vid", "video-test", "test-proj");
    if (!createResult.ok) throw new Error(createResult.error.message);
    const assetDir = createResult.value.path;

    await writeFile(join(assetDir, "original.mp4"), "fake-video-data");

    const assets = await buildAssetList(fs, "test-proj");
    expect(assets.length).toBe(1);
    expect(assets[0].media_url).toContain("original.mp4");
  });

  it("finds image as primary media file when no video present", async () => {
    const { buildAssetList } = await import("./sync.js");
    const createResult = await fs.createAsset("img", "image-test", "test-proj");
    if (!createResult.ok) throw new Error(createResult.error.message);
    const assetDir = createResult.value.path;

    await writeFile(join(assetDir, "original.png"), "fake-png-data");

    const assets = await buildAssetList(fs, "test-proj");
    expect(assets.length).toBe(1);
    expect(assets[0].media_url).toContain("original.png");
  });

  it("finds audio as primary media file", async () => {
    const { buildAssetList } = await import("./sync.js");
    const createResult = await fs.createAsset("aud", "audio-test", "test-proj");
    if (!createResult.ok) throw new Error(createResult.error.message);
    const assetDir = createResult.value.path;

    await writeFile(join(assetDir, "original.mp3"), "fake-audio-data");

    const assets = await buildAssetList(fs, "test-proj");
    expect(assets.length).toBe(1);
    expect(assets[0].media_url).toContain("original.mp3");
  });

  it("finds markdown as primary media file", async () => {
    const { buildAssetList } = await import("./sync.js");
    const createResult = await fs.createAsset("script", "doc-test", "test-proj");
    if (!createResult.ok) throw new Error(createResult.error.message);
    const assetDir = createResult.value.path;

    await writeFile(join(assetDir, "original.md"), "# Hello");

    const assets = await buildAssetList(fs, "test-proj");
    expect(assets.length).toBe(1);
    expect(assets[0].media_url).toContain("original.md");
  });

  it("detects thumbnail when frame file exists", async () => {
    const { buildAssetList } = await import("./sync.js");
    const createResult = await fs.createAsset("vid", "thumb-test", "test-proj");
    if (!createResult.ok) throw new Error(createResult.error.message);
    const assetDir = createResult.value.path;

    await writeFile(join(assetDir, "original.mp4"), "fake-video-data");
    await mkdir(join(assetDir, "original_frames"), { recursive: true });
    await writeFile(join(assetDir, "original_frames", "0.00.jpg"), "fake-thumb");

    const assets = await buildAssetList(fs, "test-proj");
    expect(assets.length).toBe(1);
    expect(assets[0].thumbnail_url).toContain("original_frames/0.00.jpg");
  });

  it("returns null thumbnail for video without frame files", async () => {
    const { buildAssetList } = await import("./sync.js");
    const createResult = await fs.createAsset("vid", "no-thumb", "test-proj");
    if (!createResult.ok) throw new Error(createResult.error.message);
    const assetDir = createResult.value.path;

    await writeFile(join(assetDir, "original.mp4"), "fake-video-data");

    const assets = await buildAssetList(fs, "test-proj");
    expect(assets.length).toBe(1);
    expect(assets[0].thumbnail_url).toBeNull();
  });

  it("shows status unreviewed for video without whitelist", async () => {
    const { buildAssetList } = await import("./sync.js");
    const createResult = await fs.createAsset("vid", "unreviewd-test", "test-proj");
    if (!createResult.ok) throw new Error(createResult.error.message);
    const assetDir = createResult.value.path;

    await writeFile(join(assetDir, "original.mp4"), "fake-video-data");

    const assets = await buildAssetList(fs, "test-proj");
    expect(assets.length).toBe(1);
    expect(assets[0].status).toBe("unreviewed");
  });

  it("shows status approved for whitelisted video without render metadata", async () => {
    const { buildAssetList } = await import("./sync.js");
    const createResult = await fs.createAsset("vid", "approved-test", "test-proj");
    if (!createResult.ok) throw new Error(createResult.error.message);
    const assetDir = createResult.value.path;

    await writeFile(join(assetDir, "original.mp4"), "fake-video-data");
    await writeFile(join(assetDir, ".whitelisted_at"), String(Date.now() / 1000));

    const assets = await buildAssetList(fs, "test-proj");
    expect(assets.length).toBe(1);
    expect(assets[0].status).toBe("approved");
  });

  it("shows status ready for whitelisted video with render metadata", async () => {
    const { buildAssetList } = await import("./sync.js");
    const createResult = await fs.createAsset("vid", "ready-test", "test-proj");
    if (!createResult.ok) throw new Error(createResult.error.message);
    const assetDir = createResult.value.path;

    await writeFile(join(assetDir, "original.mp4"), "fake-video-data");
    await writeFile(join(assetDir, ".whitelisted_at"), String(Date.now() / 1000));
    await writeFile(join(assetDir, ".render.json"), JSON.stringify({ done: true }));

    const assets = await buildAssetList(fs, "test-proj");
    expect(assets.length).toBe(1);
    expect(assets[0].status).toBe("ready");
  });
});

describe("performSync", () => {
  let fs: ClipfirstFs;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-sync-test-"));
    fs = createFsForTest(tempDir);
    await fs.createProject("test-proj");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("performSync on empty project returns empty result", async () => {
    const { performSync } = await import("./sync.js");
    const result = await performSync(fs, "test-proj");
    expect(result.pending).toEqual([]);
    expect(result.completed).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.external_uploads).toEqual([]);
    expect(result.auto_render).toEqual([]);
  });

  it("performSync skips KIE task polling when KIE_API_KEY is not set", async () => {
    const { performSync } = await import("./sync.js");
    const savedKey = process.env.KIE_API_KEY;
    delete process.env.KIE_API_KEY;

    try {
      const createResult = await fs.createAsset("vid", "sync-test", "test-proj");
      if (!createResult.ok) throw new Error(createResult.error.message);

      const result = await performSync(fs, "test-proj");
      // Should complete without errors, no KIE polling
      expect(result.pending).toEqual([]);
      expect(result.completed).toEqual([]);
      expect(result.failed).toEqual([]);
    } finally {
      if (savedKey !== undefined) {
        process.env.KIE_API_KEY = savedKey;
      }
    }
  });
});
