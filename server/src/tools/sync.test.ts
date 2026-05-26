import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { createFsForTest } from "../fs.js";
import { queue, setProjectsDir } from "../queue.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { VideocityFs } from "vc-engine";

describe("sync tool", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-test-"));
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
    expect(data.auto_transcribe).toEqual([]);
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

// Per-test createTestClient + create_project under parallel test load was
// racing on the queue's global projectsDir, intermittently failing with
// ENOENT on .project.lock. Mirror asset-manifest.test.ts: a single
// beforeAll/afterAll, with a unique project slug per test for isolation.
describe("list_assets tool", () => {
  let client: Client;
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-test-"));
    client = await createTestClient(tempDir);
  });

  afterAll(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("empty project returns empty assets array", async () => {
    const slug = "list-empty";
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: slug },
    });

    const result = await client.callTool({
      name: "list_assets",
      arguments: { project_slug: slug },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text);
    expect(data.assets).toEqual([]);
  });

  it("lists assets after upload", async () => {
    const slug = "list-populated";
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: slug },
    });

    const imgData = Buffer.from("fake-png-data").toString("base64");
    await client.callTool({
      name: "upload_file",
      arguments: { project_slug: slug, filename: "photo.png", data: imgData },
    });

    const result = await client.callTool({
      name: "list_assets",
      arguments: { project_slug: slug },
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
  let fs: VideocityFs;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-test-"));
    fs = createFsForTest(tempDir);
    await setProjectsDir(tempDir);
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
    await writeFile(join(assetDir, "original.jpg"), "fake-thumb");

    const assets = await buildAssetList(fs, "test-proj");
    expect(assets.length).toBe(1);
    expect(assets[0].thumbnail_url).toContain("original.jpg");
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

  it("shows status processing for fresh video without .original.json", async () => {
    const { buildAssetList } = await import("./sync.js");
    const createResult = await fs.createAsset("vid", "fresh-test", "test-proj");
    if (!createResult.ok) throw new Error(createResult.error.message);
    const assetDir = createResult.value.path;

    await writeFile(join(assetDir, "original.mp4"), "fake-video-data");

    const assets = await buildAssetList(fs, "test-proj");
    expect(assets.length).toBe(1);
    expect(assets[0].status).toBe("processing");
  });

  it("shows status ready for processed video without analysis (analysis is lazy)", async () => {
    const { buildAssetList } = await import("./sync.js");
    const createResult = await fs.createAsset("vid", "analyzing-test", "test-proj");
    if (!createResult.ok) throw new Error(createResult.error.message);
    const assetDir = createResult.value.path;

    await writeFile(join(assetDir, "original.mp4"), "fake-video-data");
    await writeFile(join(assetDir, ".original.json"), JSON.stringify({ width: 1, height: 1, duration: 1 }));

    const assets = await buildAssetList(fs, "test-proj");
    expect(assets.length).toBe(1);
    expect(assets[0].status).toBe("ready");
  });

  it("shows status ready for fully analyzed video", async () => {
    const { buildAssetList } = await import("./sync.js");
    const createResult = await fs.createAsset("vid", "ready-analyzed-test", "test-proj");
    if (!createResult.ok) throw new Error(createResult.error.message);
    const assetDir = createResult.value.path;

    await writeFile(join(assetDir, "original.mp4"), "fake-video-data");
    await writeFile(join(assetDir, ".original.json"), JSON.stringify({ width: 1, height: 1, duration: 1 }));
    await writeFile(join(assetDir, ".original.analysis.json"), JSON.stringify({ summary: "" }));

    const assets = await buildAssetList(fs, "test-proj");
    expect(assets.length).toBe(1);
    expect(assets[0].status).toBe("ready");
  });

  it("shows status ready for video with render metadata", async () => {
    const { buildAssetList } = await import("./sync.js");
    const createResult = await fs.createAsset("vid", "ready-test", "test-proj");
    if (!createResult.ok) throw new Error(createResult.error.message);
    const assetDir = createResult.value.path;

    await writeFile(join(assetDir, "original.mp4"), "fake-video-data");
    await writeFile(join(assetDir, ".original.json"), JSON.stringify({ width: 1, height: 1, duration: 1 }));
    await writeFile(join(assetDir, ".original.analysis.json"), JSON.stringify({ summary: "" }));
    await writeFile(join(assetDir, ".landscape.render.json"), JSON.stringify({ done: true }));

    const assets = await buildAssetList(fs, "test-proj");
    expect(assets.length).toBe(1);
    expect(assets[0].status).toBe("ready");
  });

  it("surfaces lock state for video with active lock (no clamp)", async () => {
    const { buildAssetList } = await import("./sync.js");
    const createResult = await fs.createAsset("vid", "locked-no-state", "test-proj");
    if (!createResult.ok) throw new Error(createResult.error.message);
    const assetDir = createResult.value.path;

    await writeFile(join(assetDir, "original.mp4"), "fake-video-data");
    // Lock without explicit state defaults to "loading" in the derivation rule.
    // Whitelist clamp is gone — the lock state passes through unchanged.
    await fs.acquireLock(assetDir, { durationMs: 60_000 });

    const assets = await buildAssetList(fs, "test-proj");
    const asset = assets.find(a => a.id === createResult.value.assetId)!;
    expect(asset.status).toBe("loading");

    await fs.releaseLock(assetDir);
  });

  it("surfaces 'error' for video with no media/lock/task (orphaned)", async () => {
    const { buildAssetList } = await import("./sync.js");
    const createResult = await fs.createAsset("vid", "empty-vid", "test-proj");
    if (!createResult.ok) throw new Error(createResult.error.message);

    // Empty asset directory — no media, no lock, no pending task — is an
    // orphaned failed generation. The clamp now allows "error" through so
    // the inbox shows the failure instead of appearing stuck in "generating".
    const assets = await buildAssetList(fs, "test-proj");
    const asset = assets.find(a => a.id === createResult.value.assetId)!;
    expect(asset.status).toBe("error");
  });

  it("does not clamp non-video assets", async () => {
    const { buildAssetList } = await import("./sync.js");
    const createResult = await fs.createAsset("img", "empty-img", "test-proj");
    if (!createResult.ok) throw new Error(createResult.error.message);

    // Empty image asset — no media, no lock, no pending task — is an orphaned
    // failed generation. The video-only clamp does not apply to images, so
    // "error" passes through unchanged (it would pass through for videos too
    // now that "error" is in the clamp allow-list).
    const assets = await buildAssetList(fs, "test-proj");
    const asset = assets.find(a => a.id === createResult.value.assetId)!;
    expect(asset.status).toBe("error");
  });
});

describe("performSync", () => {
  let fs: VideocityFs;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-sync-test-"));
    fs = createFsForTest(tempDir);
    await setProjectsDir(tempDir);
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
    expect(result.auto_transcribe).toEqual([]);
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

describe("buildAssetList — failed download detection (RC3)", () => {
  let fs: VideocityFs;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-rc3-test-"));
    fs = createFsForTest(tempDir);
    await setProjectsDir(tempDir);
    await fs.createProject("test-proj");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("surfaces 'error' for video with .part file (failed download)", async () => {
    const { buildAssetList } = await import("./sync.js");
    const createResult = await fs.createAsset("vid", "broken-download", "test-proj");
    if (!createResult.ok) throw new Error(createResult.error.message);
    const assetDir = createResult.value.path;

    // Simulate failed download: 0-byte .part file, no original.mp4
    await writeFile(join(assetDir, "original.mp4.part"), "");

    const assets = await buildAssetList(fs, "test-proj");
    expect(assets.length).toBe(1);
    // The clamp now allows "error" through so failed downloads surface in
    // the inbox instead of appearing stuck in "generating" forever.
    expect(assets[0].status).toBe("error");
  });

  it("surfaces 'error' for video with .part + thumbnail (failed download)", async () => {
    const { buildAssetList } = await import("./sync.js");
    const createResult = await fs.createAsset("vid", "broken-with-thumb", "test-proj");
    if (!createResult.ok) throw new Error(createResult.error.message);
    const assetDir = createResult.value.path;

    // Simulate: OG image downloaded as original.jpg, but video download failed
    await writeFile(join(assetDir, "original.jpg"), "fake-thumbnail");
    await writeFile(join(assetDir, "original.mp4.part"), "");

    const assets = await buildAssetList(fs, "test-proj");
    expect(assets.length).toBe(1);
    expect(assets[0].status).toBe("error");
  });


  it("does not show status 'error' when original.mp4 exists alongside .part file", async () => {
    const { buildAssetList } = await import("./sync.js");
    const createResult = await fs.createAsset("vid", "good-download", "test-proj");
    if (!createResult.ok) throw new Error(createResult.error.message);
    const assetDir = createResult.value.path;

    // Both .part and completed file exist (shouldn't happen, but be safe)
    await writeFile(join(assetDir, "original.mp4"), "fake-video");
    await writeFile(join(assetDir, "original.mp4.part"), "");

    const assets = await buildAssetList(fs, "test-proj");
    expect(assets.length).toBe(1);
    expect(assets[0].status).not.toBe("error");
  });
});

// performSync no longer enqueues render_project jobs. These tests now lock in
// the invariant that auto_render is always empty from sync, regardless of
// whether the asset would otherwise have qualified.
describe("performSync — never auto-renders from sync", () => {
  let fs: VideocityFs;
  let tempDir: string;
  let savedKieKey: string | undefined;

  beforeAll(async () => {
    await queue.start();
  });

  afterAll(async () => {
    await queue.stop();
  });

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-rc2-test-"));
    fs = createFsForTest(tempDir);
    await setProjectsDir(tempDir);
    await fs.createProject("test-proj");
    savedKieKey = process.env.KIE_API_KEY;
    delete process.env.KIE_API_KEY;
  });

  afterEach(async () => {
    if (savedKieKey !== undefined) {
      process.env.KIE_API_KEY = savedKieKey;
    } else {
      delete process.env.KIE_API_KEY;
    }
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("skips auto-render for dialog video without elevenlabs.json", async () => {
    const { performSync } = await import("./sync.js");
    const createResult = await fs.createAsset("vid", "dialog-no-elevenlabs", "test-proj");
    if (!createResult.ok) throw new Error(createResult.error.message);
    const assetDir = createResult.value.path;

    await writeFile(join(assetDir, "original.mp4"), "fake-video-data");
    await writeFile(join(assetDir, ".original.analysis.json"), JSON.stringify({
      summary: "A person speaking about economics",
    }));
    await writeFile(join(assetDir, ".analysis.gpt4otrans.json"), JSON.stringify({
      text: "So money is infinite. Why do we have poor people then? Because we don't want people to all have money.",
    }));

    const result = await performSync(fs, "test-proj");
    expect(result.auto_render.length).toBe(0);
  });

  it("does not auto-render dialog video even when elevenlabs.json exists", async () => {
    const { performSync } = await import("./sync.js");
    const createResult = await fs.createAsset("vid", "dialog-with-elevenlabs", "test-proj");
    if (!createResult.ok) throw new Error(createResult.error.message);
    const assetDir = createResult.value.path;

    await writeFile(join(assetDir, "original.mp4"), "fake-video-data");
    await writeFile(join(assetDir, ".original.analysis.json"), JSON.stringify({
      summary: "A person speaking about economics",
    }));
    await writeFile(join(assetDir, ".analysis.gpt4otrans.json"), JSON.stringify({
      text: "So money is infinite. Why do we have poor people then? Because we don't want people to all have money.",
    }));
    await writeFile(join(assetDir, "elevenlabs.json"), JSON.stringify({ words: [] }));

    const result = await performSync(fs, "test-proj");
    expect(result.auto_render.length).toBe(0);
  });

  it("skips auto-render when gpt4otrans is missing for audio video", async () => {
    const { performSync } = await import("./sync.js");
    const createResult = await fs.createAsset("vid", "no-stt", "test-proj");
    if (!createResult.ok) throw new Error(createResult.error.message);
    const assetDir = createResult.value.path;

    await writeFile(join(assetDir, "original.mp4"), "fake-video-data");
    await writeFile(join(assetDir, ".original.analysis.json"), JSON.stringify({
      summary: "Video with audio",
    }));
    await fs.writeMetadata(createResult.value.assetId, "original", { hasAudio: true }, "test-proj");

    const result = await performSync(fs, "test-proj");
    expect(result.auto_render.length).toBe(0);
  });

  it("does not auto-render no-audio video without gpt4otrans", async () => {
    const { performSync } = await import("./sync.js");
    const createResult = await fs.createAsset("vid", "silent-clip", "test-proj");
    if (!createResult.ok) throw new Error(createResult.error.message);
    const assetId = createResult.value.assetId;
    const assetDir = createResult.value.path;

    await writeFile(join(assetDir, "original.mp4"), "fake-video-data");
    await writeFile(join(assetDir, ".original.analysis.json"), JSON.stringify({
      summary: "Silent AI-generated clip",
    }));
    await fs.writeMetadata(assetId, "original", { hasAudio: false }, "test-proj");

    const result = await performSync(fs, "test-proj");
    expect(result.auto_render.length).toBe(0);
  });

  it("skips auto-render when kie-task.json exists", async () => {
    const { performSync } = await import("./sync.js");
    const createResult = await fs.createAsset("vid", "transcribing-video", "test-proj");
    if (!createResult.ok) throw new Error(createResult.error.message);
    const assetDir = createResult.value.path;

    await writeFile(join(assetDir, "original.mp4"), "fake-video-data");
    await writeFile(join(assetDir, ".original.analysis.json"), JSON.stringify({
      summary: "A person speaking",
    }));
    await writeFile(join(assetDir, ".analysis.gpt4otrans.json"), JSON.stringify({
      text: "Hello world this is a real transcription with enough words to count as dialog",
    }));
    await writeFile(join(assetDir, ".kie-task.json"), JSON.stringify({
      taskId: "task-123", taskType: "transcribe",
    }));

    const result = await performSync(fs, "test-proj");
    expect(result.auto_render.length).toBe(0);
  });

  it("does not auto-render non-dialog video without elevenlabs.json", async () => {
    const { performSync } = await import("./sync.js");
    const createResult = await fs.createAsset("vid", "music-video", "test-proj");
    if (!createResult.ok) throw new Error(createResult.error.message);
    const assetDir = createResult.value.path;

    await writeFile(join(assetDir, "original.mp4"), "fake-video-data");
    await writeFile(join(assetDir, ".original.analysis.json"), JSON.stringify({
      summary: "Scenic landscape with background music",
    }));
    await writeFile(join(assetDir, ".analysis.gpt4otrans.json"), JSON.stringify({
      text: "[music]",
    }));

    const result = await performSync(fs, "test-proj");
    expect(result.auto_render.length).toBe(0);
  });
});

describe("performSync — auto-transcribe", () => {
  let fs: VideocityFs;
  let tempDir: string;
  let savedKey: string | undefined;

  beforeAll(async () => {
    await queue.start();
  });

  afterAll(async () => {
    await queue.stop();
  });

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-autotranscribe-test-"));
    fs = createFsForTest(tempDir);
    await setProjectsDir(tempDir);
    await fs.createProject("test-proj");
    savedKey = process.env.ELEVENLABS_API_KEY;
    process.env.ELEVENLABS_API_KEY = "test-key";
  });

  afterEach(async () => {
    if (savedKey !== undefined) {
      process.env.ELEVENLABS_API_KEY = savedKey;
    } else {
      delete process.env.ELEVENLABS_API_KEY;
    }
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("auto-transcribes analyzed video with dialog and audio", async () => {
    const { performSync } = await import("./sync.js");
    const createResult = await fs.createAsset("vid", "transcribe-candidate", "test-proj");
    if (!createResult.ok) throw new Error(createResult.error.message);
    const assetId = createResult.value.assetId;
    const assetDir = createResult.value.path;

    await writeFile(join(assetDir, "original.mp4"), "fake-video-data");
    await writeFile(join(assetDir, "audio_original.mp3"), "fake-audio-data");
    await writeFile(join(assetDir, ".original.analysis.json"), JSON.stringify({
      summary: "A person speaking about economics",
    }));
    await writeFile(join(assetDir, ".analysis.gpt4otrans.json"), JSON.stringify({
      text: "So money is infinite. Why do we have poor people then? Because we don't want people to all have money.",
    }));

    const result = await performSync(fs, "test-proj");
    expect(result.auto_transcribe.length).toBe(1);
    expect(result.auto_transcribe[0].assetId).toBe(assetId);
  });

  it("skips auto-transcribe when elevenlabs.json already exists", async () => {
    const { performSync } = await import("./sync.js");
    const createResult = await fs.createAsset("vid", "already-transcribed", "test-proj");
    if (!createResult.ok) throw new Error(createResult.error.message);
    const assetDir = createResult.value.path;

    await writeFile(join(assetDir, "original.mp4"), "fake-video-data");
    await writeFile(join(assetDir, "audio_original.mp3"), "fake-audio-data");
    await writeFile(join(assetDir, ".original.analysis.json"), JSON.stringify({
      summary: "A person speaking",
    }));
    await writeFile(join(assetDir, ".analysis.gpt4otrans.json"), JSON.stringify({
      text: "Hello world this is a test transcription with real dialog content",
    }));
    await writeFile(join(assetDir, "elevenlabs.json"), JSON.stringify({ words: [] }));

    const result = await performSync(fs, "test-proj");
    expect(result.auto_transcribe.length).toBe(0);
  });

  it("skips auto-transcribe when a prior transcription failed", async () => {
    const { performSync } = await import("./sync.js");
    const createResult = await fs.createAsset("vid", "prior-failure", "test-proj");
    if (!createResult.ok) throw new Error(createResult.error.message);
    const assetId = createResult.value.assetId;
    const assetDir = createResult.value.path;

    await writeFile(join(assetDir, "original.mp4"), "fake-video-data");
    await writeFile(join(assetDir, "audio_original.mp3"), "fake-audio-data");
    await writeFile(join(assetDir, ".original.analysis.json"), JSON.stringify({
      summary: "A person speaking about economics",
    }));
    await writeFile(join(assetDir, ".analysis.gpt4otrans.json"), JSON.stringify({
      text: "So money is infinite. Why do we have poor people then? Because we don't want people to all have money.",
    }));
    const writeErr = await fs.generationErrors.write("test-proj", assetId, {
      message: "The upstream API service timed out and no results were returned, please try again.",
      failCode: "500",
    });
    if (!writeErr.ok) throw new Error(writeErr.error.message);

    const result = await performSync(fs, "test-proj");
    expect(result.auto_transcribe.length).toBe(0);
  });

  it("skips auto-transcribe when no dialog detected", async () => {
    const { performSync } = await import("./sync.js");
    const createResult = await fs.createAsset("vid", "no-dialog", "test-proj");
    if (!createResult.ok) throw new Error(createResult.error.message);
    const assetDir = createResult.value.path;

    await writeFile(join(assetDir, "original.mp4"), "fake-video-data");
    await writeFile(join(assetDir, "audio_original.mp3"), "fake-audio-data");
    await writeFile(join(assetDir, ".original.analysis.json"), JSON.stringify({
      summary: "Scenic landscape footage",
    }));
    await writeFile(join(assetDir, ".analysis.gpt4otrans.json"), JSON.stringify({
      text: "[music]",
    }));

    const result = await performSync(fs, "test-proj");
    expect(result.auto_transcribe.length).toBe(0);
  });
});
