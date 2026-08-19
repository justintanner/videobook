import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { createEngineForTest } from "../engine.js";
import { queue, setEngineRoot } from "../queue.js";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine } from "videobook-engine";

async function writeNativeFile(
  fs: Engine,
  targetPath: string,
  data: Buffer | string,
): Promise<void> {
  const absoluteTarget = resolve(targetPath);
  for (const artifact of fs.artifacts.list()) {
    const filename = relative(artifact.path, absoluteTarget);
    if (
      filename.length === 0 ||
      filename === ".." ||
      filename.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      isAbsolute(filename)
    ) {
      continue;
    }
    const written = await fs.files.write(artifact.artifactId, filename, data
    );
    if (!written.ok) throw new Error(written.error.message);
    return;
  }
  throw new Error(`No native artifact workspace owns ${targetPath}`);
}

describe("reconcile_project_work tool", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "test-proj" },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("reconciliation on an empty project returns empty arrays", async () => {
    const result = await client.callTool({
      name: "reconcile_project_work",
      arguments: { book_id: "test-proj" },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text);
    expect(data.pending).toEqual([]);
    expect(data.completed).toEqual([]);
    expect(data.failed).toEqual([]);
    expect(data.external_uploads).toEqual([]);
    expect(data.auto_transcribe).toEqual([]);
  });

  it("reconciliation after creating assets returns no errors", async () => {
    const imgData = Buffer.from("fake-png-data").toString("base64");
    await client.callTool({
      name: "upload_file",
      arguments: { book_id: "test-proj", filename: "photo.png", data: imgData },
    });

    const result = await client.callTool({
      name: "reconcile_project_work",
      arguments: { book_id: "test-proj" },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text);
    expect(data).toHaveProperty("pending");
    expect(data).toHaveProperty("completed");
    expect(data).toHaveProperty("failed");
    expect(data).toHaveProperty("external_uploads");
    expect(data).toHaveProperty("auto_transcribe");
  });
});

describe("list_assets tool", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-test-"));
    client = await createTestClient(tempDir);
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("new book returns no artifacts", async () => {
    const slug = "list-empty";
    await client.callTool({
      name: "create_project",
      arguments: { book_id: slug },
    });

    const result = await client.callTool({
      name: "list_assets",
      arguments: { book_id: slug },
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
      arguments: { book_id: slug },
    });

    const imgData = Buffer.from("fake-png-data").toString("base64");
    await client.callTool({
      name: "upload_file",
      arguments: { book_id: slug, filename: "photo.png", data: imgData },
    });

    const result = await client.callTool({
      name: "list_assets",
      arguments: { book_id: slug },
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
  let fs: Engine;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-test-"));
    fs = createEngineForTest(tempDir);
    await setEngineRoot(tempDir, fs);
  });

  afterEach(async () => {
    // buildAssetList can lazily start a waveform queue runner; stop it before
    // removing the temporary Dolt catalog.
    await queue.stop();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("returns empty array for project with no assets", async () => {
    const { buildAssetList } = await import("./reconcile-project-work.js");
    const assets = await buildAssetList(fs, fs.book.get().bookId);
    expect(assets).toEqual([]);
  });

  it("returns assets with metadata after creating an asset", async () => {
    const { buildAssetList } = await import("./reconcile-project-work.js");
    const createResult = await fs.artifacts.create("img", "test-asset");
    if (!createResult.ok) throw new Error(createResult.error.message);

    const assets = await buildAssetList(fs, fs.book.get().bookId);
    expect(assets.length).toBe(1);
    expect(assets[0].id).toBe(createResult.value.artifactId);
    expect(assets[0].artifact_id).toBe(createResult.value.artifactId);
    expect(assets[0].label).toBe("test-asset");
    expect(assets[0].type).toBe("image");
    expect(assets[0]).toHaveProperty("status");
    expect(assets[0]).toHaveProperty("media_url");
    expect(assets[0]).toHaveProperty("thumbnail_url");
    expect(assets[0]).toHaveProperty("width");
    expect(assets[0]).toHaveProperty("height");
  });

  it("finds mp4 video as primary media file", async () => {
    const { buildAssetList } = await import("./reconcile-project-work.js");
    const createResult = await fs.artifacts.create("vid", "video-test");
    if (!createResult.ok) throw new Error(createResult.error.message);
    const assetDir = createResult.value.path;

    await writeNativeFile(fs, join(assetDir, "original.mp4"), "fake-video-data");

    const assets = await buildAssetList(fs, fs.book.get().bookId);
    expect(assets.length).toBe(1);
    expect(assets[0].media_url).toContain("original.mp4");
  });

  it("defers waveform extraction to a background job instead of blocking", async () => {
    const { buildAssetList } = await import("./reconcile-project-work.js");
    const createResult = await fs.artifacts.create("vid", "wf-defer");
    if (!createResult.ok) throw new Error(createResult.error.message);
    await writeNativeFile(fs, join(createResult.value.path, "original.mp4"), "fake-video-data");

    const assets = await buildAssetList(fs, fs.book.get().bookId);
    // An uncached video does NOT run ffmpeg inline — waveform is deferred.
    expect(assets[0].waveform).toBeNull();

    // ...and a single extract_waveform job is enqueued. The enqueue is
    // fire-and-forget, so poll briefly for it to land. Match any state: whether
    // it has already run depends on whether a handler is registered.
    let wfJobs: Awaited<ReturnType<typeof fs.jobs.queue.list>> = [];
    for (let i = 0; i < 50 && wfJobs.length === 0; i++) {
      const jobs = await fs.jobs.queue.list({
        states: ["queued", "running", "completing", "done", "failed", "aborted"],
      });
      wfJobs = jobs.filter((j) => j.type === "extract_waveform");
      if (wfJobs.length === 0) await new Promise((r) => setTimeout(r, 20));
    }
    expect(wfJobs.length).toBe(1);
  });

  it("finds image as primary media file when no video present", async () => {
    const { buildAssetList } = await import("./reconcile-project-work.js");
    const createResult = await fs.artifacts.create("img", "image-test");
    if (!createResult.ok) throw new Error(createResult.error.message);
    const assetDir = createResult.value.path;

    await writeNativeFile(fs, join(assetDir, "original.png"), "fake-png-data");

    const assets = await buildAssetList(fs, fs.book.get().bookId);
    expect(assets.length).toBe(1);
    expect(assets[0].media_url).toContain("original.png");
  });

  it("finds audio as primary media file", async () => {
    const { buildAssetList } = await import("./reconcile-project-work.js");
    const createResult = await fs.artifacts.create("aud", "audio-test");
    if (!createResult.ok) throw new Error(createResult.error.message);
    const assetDir = createResult.value.path;

    await writeNativeFile(fs, join(assetDir, "original.mp3"), "fake-audio-data");

    const assets = await buildAssetList(fs, fs.book.get().bookId);
    expect(assets.length).toBe(1);
    expect(assets[0].media_url).toContain("original.mp3");
  });

  it("finds m4a audio as primary media file", async () => {
    const { buildAssetList } = await import("./reconcile-project-work.js");
    const createResult = await fs.artifacts.create("aud", "m4a-audio-test");
    if (!createResult.ok) throw new Error(createResult.error.message);

    await writeNativeFile(
      fs,
      join(createResult.value.path, "original.m4a"),
      "fake-m4a-data",
    );

    const assets = await buildAssetList(fs, fs.book.get().bookId);
    expect(assets).toHaveLength(1);
    expect(assets[0].media_url).toContain("original.m4a");
    expect(assets[0].status).toBe("ready");
  });

  it("backfills duration for audio assets missing metadata duration", async () => {
    const { buildAssetList } = await import("./reconcile-project-work.js");
    const { runFfmpeg } = await import("../ffmpeg.js");
    const createResult = await fs.artifacts.create("aud", "audio-duration");
    if (!createResult.ok) throw new Error(createResult.error.message);
    const assetDir = createResult.value.path;
    const mp3Path = join(assetDir, "original.mp3");

    await runFfmpeg([
      "-y",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1.5",
      "-acodec", "libmp3lame", "-q:a", "4",
      mp3Path,
    ]);
    const ingested = await fs.files.ingestWorkspace(
      createResult.value.artifactId,
      ["original.mp3"],
      "test-proj",
      "test_fixture",
    );
    expect(ingested.ok).toBe(true);
    const initialMetadata = await fs.metadata.artifacts.write(createResult.value.artifactId, "original", { origin: "extract_audio", source_asset: "vid-source" }
    );
    expect(initialMetadata.ok).toBe(true);

    const assets = await buildAssetList(fs, fs.book.get().bookId);
    expect(assets.length).toBe(1);
    expect(assets[0].duration).toBeGreaterThan(1.2);
    expect(assets[0].duration).toBeLessThan(2.0);

    // Persisted so the next list does not re-probe.
    const meta = await fs.metadata.artifacts.read<{
      duration: number;
      origin: string;
    }>(createResult.value.artifactId, "original");
    expect(meta.ok).toBe(true);
    if (!meta.ok) throw new Error(meta.error.message);
    expect(meta.value.duration).toBe(assets[0].duration);
    expect(meta.value.origin).toBe("extract_audio");
  });

  it("finds markdown as primary media file", async () => {
    const { buildAssetList } = await import("./reconcile-project-work.js");
    const createResult = await fs.artifacts.create("script", "doc-test");
    if (!createResult.ok) throw new Error(createResult.error.message);
    const assetDir = createResult.value.path;

    await writeNativeFile(fs, join(assetDir, "original.md"), "# Hello");

    const assets = await buildAssetList(fs, fs.book.get().bookId);
    expect(assets.length).toBe(1);
    expect(assets[0].media_url).toContain("original.md");
  });

  it("detects thumbnail when frame file exists", async () => {
    const { buildAssetList } = await import("./reconcile-project-work.js");
    const createResult = await fs.artifacts.create("vid", "thumb-test");
    if (!createResult.ok) throw new Error(createResult.error.message);
    const assetDir = createResult.value.path;

    await writeNativeFile(fs, join(assetDir, "original.mp4"), "fake-video-data");
    await writeNativeFile(fs, join(assetDir, "original.jpg"), "fake-thumb");

    const assets = await buildAssetList(fs, fs.book.get().bookId);
    expect(assets.length).toBe(1);
    expect(assets[0].thumbnail_url).toContain("original.jpg");
  });

  it("returns null thumbnail for video without frame files", async () => {
    const { buildAssetList } = await import("./reconcile-project-work.js");
    const createResult = await fs.artifacts.create("vid", "no-thumb");
    if (!createResult.ok) throw new Error(createResult.error.message);
    const assetDir = createResult.value.path;

    await writeNativeFile(fs, join(assetDir, "original.mp4"), "fake-video-data");

    const assets = await buildAssetList(fs, fs.book.get().bookId);
    expect(assets.length).toBe(1);
    expect(assets[0].thumbnail_url).toBeNull();
  });

  it("shows status processing for fresh video without original metadata", async () => {
    const { buildAssetList } = await import("./reconcile-project-work.js");
    const createResult = await fs.artifacts.create("vid", "fresh-test");
    if (!createResult.ok) throw new Error(createResult.error.message);
    const assetDir = createResult.value.path;

    await writeNativeFile(fs, join(assetDir, "original.mp4"), "fake-video-data");

    const assets = await buildAssetList(fs, fs.book.get().bookId);
    expect(assets.length).toBe(1);
    expect(assets[0].status).toBe("processing");
  });

  it("shows status ready for processed video without analysis (analysis is lazy)", async () => {
    const { buildAssetList } = await import("./reconcile-project-work.js");
    const createResult = await fs.artifacts.create("vid", "analyzing-test");
    if (!createResult.ok) throw new Error(createResult.error.message);
    const assetDir = createResult.value.path;

    await writeNativeFile(fs, join(assetDir, "original.mp4"), "fake-video-data");
    await fs.metadata.artifacts.write(createResult.value.artifactId, "original", { width: 1, height: 1, duration: 1 }
    );

    const assets = await buildAssetList(fs, fs.book.get().bookId);
    expect(assets.length).toBe(1);
    expect(assets[0].status).toBe("ready");
  });

  it("shows status ready for fully analyzed video", async () => {
    const { buildAssetList } = await import("./reconcile-project-work.js");
    const createResult = await fs.artifacts.create("vid", "ready-analyzed-test");
    if (!createResult.ok) throw new Error(createResult.error.message);
    const assetDir = createResult.value.path;

    await writeNativeFile(fs, join(assetDir, "original.mp4"), "fake-video-data");
    await fs.metadata.artifacts.write(createResult.value.artifactId, "original", { width: 1, height: 1, duration: 1 }
    );
    await writeNativeFile(fs, join(assetDir, ".original.analysis.json"), JSON.stringify({ summary: "" }));

    const assets = await buildAssetList(fs, fs.book.get().bookId);
    expect(assets.length).toBe(1);
    expect(assets[0].status).toBe("ready");
  });

  it("shows status ready for video with render metadata", async () => {
    const { buildAssetList } = await import("./reconcile-project-work.js");
    const createResult = await fs.artifacts.create("vid", "ready-test");
    if (!createResult.ok) throw new Error(createResult.error.message);
    const assetDir = createResult.value.path;

    await writeNativeFile(fs, join(assetDir, "original.mp4"), "fake-video-data");
    await fs.metadata.artifacts.write(createResult.value.artifactId, "original", { width: 1, height: 1, duration: 1 }
    );
    await writeNativeFile(fs, join(assetDir, ".original.analysis.json"), JSON.stringify({ summary: "" }));
    const renderMetadata = await fs.metadata.artifacts.write(createResult.value.artifactId, "landscape.render", { renderedAt: new Date().toISOString() }
    );
    expect(renderMetadata.ok).toBe(true);

    const assets = await buildAssetList(fs, fs.book.get().bookId);
    expect(assets.length).toBe(1);
    expect(assets[0].status).toBe("ready");
  });

  it("surfaces lock state for video with active lock (no clamp)", async () => {
    const { buildAssetList } = await import("./reconcile-project-work.js");
    const createResult = await fs.artifacts.create("vid", "locked-no-state");
    if (!createResult.ok) throw new Error(createResult.error.message);
    const assetDir = createResult.value.path;

    await writeNativeFile(fs, join(assetDir, "original.mp4"), "fake-video-data");
    // Lock without explicit state defaults to "loading" in the derivation rule.
    // Whitelist clamp is gone — the lock state passes through unchanged.
    await fs.jobs.locks.acquire(assetDir, { durationMs: 60_000 });

    const assets = await buildAssetList(fs, fs.book.get().bookId);
    const asset = assets.find(a => a.id === createResult.value.artifactId)!;
    expect(asset.status).toBe("loading");

    await fs.jobs.locks.release(assetDir);
  });

  it("surfaces 'loading' for a freshly created video (createAsset→enqueue window)", async () => {
    const { buildAssetList } = await import("./reconcile-project-work.js");
    const createResult = await fs.artifacts.create("vid", "fresh-vid");
    if (!createResult.ok) throw new Error(createResult.error.message);

    // createAsset co-writes a pending assets row with a 5-minute deadline.
    // Until the job enqueue stamps meta.kind, the asset reads as "loading" —
    // not the orphan "error" that used to flash a red tile in the UI.
    const assets = await buildAssetList(fs, fs.book.get().bookId);
    const asset = assets.find(a => a.id === createResult.value.artifactId)!;
    expect(asset.status).toBe("loading");
  });

  it("surfaces 'error' for video with no media/lock/task once the pending deadline expires (orphaned)", async () => {
    const { buildAssetList } = await import("./reconcile-project-work.js");
    const createResult = await fs.artifacts.create("vid", "empty-vid");
    if (!createResult.ok) throw new Error(createResult.error.message);

    // Empty asset directory — no media, no lock, no pending task — is an
    // orphaned failed generation once createAsset's 5-minute pending deadline
    // lapses. Fake only Date so the deadline reads as expired.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 6 * 60_000);
      const assets = await buildAssetList(fs, fs.book.get().bookId);
      const asset = assets.find(a => a.id === createResult.value.artifactId)!;
      expect(asset.status).toBe("error");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not clamp non-video assets", async () => {
    const { buildAssetList } = await import("./reconcile-project-work.js");
    const createResult = await fs.artifacts.create("img", "empty-img");
    if (!createResult.ok) throw new Error(createResult.error.message);

    // Empty image asset past its pending deadline — no media, no lock, no
    // pending task — is an orphaned failed generation. The video-only clamp
    // does not apply to images, so "error" passes through unchanged (it would
    // pass through for videos too now that "error" is in the clamp allow-list).
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 6 * 60_000);
      const assets = await buildAssetList(fs, fs.book.get().bookId);
      const asset = assets.find(a => a.id === createResult.value.artifactId)!;
      expect(asset.status).toBe("error");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("reconcileProjectWork", () => {
  let fs: Engine;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-reconcile-test-"));
    fs = createEngineForTest(tempDir);
    await setEngineRoot(tempDir, fs);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("reconcileProjectWork on empty project returns empty result", async () => {
    const { reconcileProjectWork } = await import("./reconcile-project-work.js");
    const result = await reconcileProjectWork(fs, fs.book.get().bookId);
    expect(result.pending).toEqual([]);
    expect(result.completed).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.external_uploads).toEqual([]);
    expect(result.auto_transcribe).toEqual([]);
  });

  it("reconcileProjectWork skips KIE task polling when KIE_API_KEY is not set", async () => {
    const { reconcileProjectWork } = await import("./reconcile-project-work.js");
    const savedKey = process.env.KIE_API_KEY;
    delete process.env.KIE_API_KEY;

    try {
      const createResult = await fs.artifacts.create("vid", "reconcile-test");
      if (!createResult.ok) throw new Error(createResult.error.message);

      const result = await reconcileProjectWork(fs, fs.book.get().bookId);
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
  let fs: Engine;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-rc3-test-"));
    fs = createEngineForTest(tempDir);
    await setEngineRoot(tempDir, fs);
  });

  afterEach(async () => {
    // See buildAssetList describe: stop the lazily-started waveform queue
    // runner before removing the temp dir.
    await queue.stop();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("surfaces 'error' for video with .part file (failed download)", async () => {
    const { buildAssetList } = await import("./reconcile-project-work.js");
    const createResult = await fs.artifacts.create("vid", "broken-download");
    if (!createResult.ok) throw new Error(createResult.error.message);
    const assetDir = createResult.value.path;

    // Simulate failed download: 0-byte .part file, no original.mp4
    await writeNativeFile(fs, join(assetDir, "original.mp4.part"), "");

    const assets = await buildAssetList(fs, fs.book.get().bookId);
    expect(assets.length).toBe(1);
    // The clamp now allows "error" through so failed downloads surface in
    // the inbox instead of appearing stuck in "generating" forever.
    expect(assets[0].status).toBe("error");
  });

  it("surfaces 'error' for video with .part + thumbnail (failed download)", async () => {
    const { buildAssetList } = await import("./reconcile-project-work.js");
    const createResult = await fs.artifacts.create("vid", "broken-with-thumb");
    if (!createResult.ok) throw new Error(createResult.error.message);
    const assetDir = createResult.value.path;

    // Simulate: OG image downloaded as original.jpg, but video download failed
    await writeNativeFile(fs, join(assetDir, "original.jpg"), "fake-thumbnail");
    await writeNativeFile(fs, join(assetDir, "original.mp4.part"), "");

    const assets = await buildAssetList(fs, fs.book.get().bookId);
    expect(assets.length).toBe(1);
    expect(assets[0].status).toBe("error");
  });


  it("does not show status 'error' when original.mp4 exists alongside .part file", async () => {
    const { buildAssetList } = await import("./reconcile-project-work.js");
    const createResult = await fs.artifacts.create("vid", "good-download");
    if (!createResult.ok) throw new Error(createResult.error.message);
    const assetDir = createResult.value.path;

    // Both .part and completed file exist (shouldn't happen, but be safe)
    await writeNativeFile(fs, join(assetDir, "original.mp4"), "fake-video");
    await writeNativeFile(fs, join(assetDir, "original.mp4.part"), "");

    const assets = await buildAssetList(fs, fs.book.get().bookId);
    expect(assets.length).toBe(1);
    expect(assets[0].status).not.toBe("error");
  });
});

describe("reconcileProjectWork — auto-transcribe", () => {
  let fs: Engine;
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
    fs = createEngineForTest(tempDir);
    await setEngineRoot(tempDir, fs);
    savedKey = process.env.ELEVENLABS_API_KEY;
    process.env.ELEVENLABS_API_KEY = "test-key";
  });

  afterEach(async () => {
    if (savedKey !== undefined) {
      process.env.ELEVENLABS_API_KEY = savedKey;
    } else {
      delete process.env.ELEVENLABS_API_KEY;
    }
    await queue.stop();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("auto-transcribes analyzed video with dialog and audio", async () => {
    const { reconcileProjectWork } = await import("./reconcile-project-work.js");
    const createResult = await fs.artifacts.create("vid", "transcribe-candidate");
    if (!createResult.ok) throw new Error(createResult.error.message);
    const assetId = createResult.value.artifactId;
    const assetDir = createResult.value.path;

    await writeNativeFile(fs, join(assetDir, "original.mp4"), "fake-video-data");
    await writeNativeFile(fs, join(assetDir, "audio_original.mp3"), "fake-audio-data");
    await writeNativeFile(fs, join(assetDir, ".original.analysis.json"), JSON.stringify({
      summary: "A person speaking about economics",
    }));
    await writeNativeFile(fs, join(assetDir, ".analysis.gpt4otrans.json"), JSON.stringify({
      text: "So money is infinite. Why do we have poor people then? Because we don't want people to all have money.",
    }));

    const result = await reconcileProjectWork(fs, fs.book.get().bookId);
    expect(result.auto_transcribe.length).toBe(1);
    expect(result.auto_transcribe[0].assetId).toBe(assetId);
  });

  it("skips auto-transcribe when elevenlabs.json already exists", async () => {
    const { reconcileProjectWork } = await import("./reconcile-project-work.js");
    const createResult = await fs.artifacts.create("vid", "already-transcribed");
    if (!createResult.ok) throw new Error(createResult.error.message);
    const assetDir = createResult.value.path;

    await writeNativeFile(fs, join(assetDir, "original.mp4"), "fake-video-data");
    await writeNativeFile(fs, join(assetDir, "audio_original.mp3"), "fake-audio-data");
    await writeNativeFile(fs, join(assetDir, ".original.analysis.json"), JSON.stringify({
      summary: "A person speaking",
    }));
    await writeNativeFile(fs, join(assetDir, ".analysis.gpt4otrans.json"), JSON.stringify({
      text: "Hello world this is a test transcription with real dialog content",
    }));
    await writeNativeFile(fs, join(assetDir, "elevenlabs.json"), JSON.stringify({ words: [] }));

    const result = await reconcileProjectWork(fs, fs.book.get().bookId);
    expect(result.auto_transcribe.length).toBe(0);
  });

  it("skips auto-transcribe when a prior transcription failed", async () => {
    const { reconcileProjectWork } = await import("./reconcile-project-work.js");
    const createResult = await fs.artifacts.create("vid", "prior-failure");
    if (!createResult.ok) throw new Error(createResult.error.message);
    const assetId = createResult.value.artifactId;
    const assetDir = createResult.value.path;

    await writeNativeFile(fs, join(assetDir, "original.mp4"), "fake-video-data");
    await writeNativeFile(fs, join(assetDir, "audio_original.mp3"), "fake-audio-data");
    await writeNativeFile(fs, join(assetDir, ".original.analysis.json"), JSON.stringify({
      summary: "A person speaking about economics",
    }));
    await writeNativeFile(fs, join(assetDir, ".analysis.gpt4otrans.json"), JSON.stringify({
      text: "So money is infinite. Why do we have poor people then? Because we don't want people to all have money.",
    }));
    const writeErr = await fs.jobs.failures.write(assetId, {
      message: "The upstream API service timed out and no results were returned, please try again.",
      failCode: "500",
    });
    if (!writeErr.ok) throw new Error(writeErr.error.message);

    const result = await reconcileProjectWork(fs, fs.book.get().bookId);
    expect(result.auto_transcribe.length).toBe(0);
  });

  it("skips auto-transcribe when no dialog detected", async () => {
    const { reconcileProjectWork } = await import("./reconcile-project-work.js");
    const createResult = await fs.artifacts.create("vid", "no-dialog");
    if (!createResult.ok) throw new Error(createResult.error.message);
    const assetDir = createResult.value.path;

    await writeNativeFile(fs, join(assetDir, "original.mp4"), "fake-video-data");
    await writeNativeFile(fs, join(assetDir, "audio_original.mp3"), "fake-audio-data");
    await writeNativeFile(fs, join(assetDir, ".original.analysis.json"), JSON.stringify({
      summary: "Scenic landscape footage",
    }));
    await writeNativeFile(fs, join(assetDir, ".analysis.gpt4otrans.json"), JSON.stringify({
      text: "[music]",
    }));

    const result = await reconcileProjectWork(fs, fs.book.get().bookId);
    expect(result.auto_transcribe.length).toBe(0);
  });
});

describe("isTransientKieFailure", () => {
  it("treats a 500 still in flight (no completeTime) as transient", async () => {
    const { isTransientKieFailure } = await import("./reconcile-project-work.js");
    expect(isTransientKieFailure({ state: "fail", failCode: "500", failMsg: "Internal Error, Please try again later." })).toBe(true);
  });

  it("treats a 500 that has terminally completed as a real failure", async () => {
    const { isTransientKieFailure } = await import("./reconcile-project-work.js");
    // Mirrors the actual KIE recordInfo for a failed grok-imagine/extend task:
    // state "fail" with failCode 500 but a completeTime stamped — re-polling
    // can never flip it to success, so it must not be left pending.
    expect(isTransientKieFailure({ state: "fail", failCode: "500", completeTime: 1780581979924, costTime: 0 })).toBe(false);
  });

  it("treats a completeTime of 0 as not-yet-completed", async () => {
    const { isTransientKieFailure } = await import("./reconcile-project-work.js");
    expect(isTransientKieFailure({ state: "fail", failCode: "500", completeTime: 0 })).toBe(true);
  });

  it("never treats a non-500 failure as transient", async () => {
    const { isTransientKieFailure } = await import("./reconcile-project-work.js");
    expect(isTransientKieFailure({ state: "fail", failCode: "400", failMsg: "bad request" })).toBe(false);
    expect(isTransientKieFailure({ state: "fail" })).toBe(false);
  });
});
