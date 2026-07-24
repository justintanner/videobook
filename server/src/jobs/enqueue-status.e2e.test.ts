import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createEngineForTest } from "../fs.js";
import { queue, setEngineRoot } from "../queue.js";
import type { Engine } from "videobook-engine";

/**
 * Asserts the gen-start red-flash bug stays fixed: after a tool calls
 * queue.enqueue, the asset status must be the in-progress UI state
 * immediately — never `"error"` — so the sidebar card paints green from t=0.
 *
 * No job handlers are registered, so the queue runner's resolveHandler
 * returns null for these job types and the job stays queued indefinitely.
 * The assets row that writePendingAssetRow co-wrote at enqueue is what
 * computeArtifactStatus must consult.
 */
describe("enqueue status (no red-flash window)", () => {
  let tempDir: string;
  let fs: Engine;
  const slug = "test-proj";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-enqstatus-"));
    fs = createEngineForTest(tempDir);
    await setEngineRoot(tempDir, fs);
    const created = await fs.projects.create(slug);
    expect(created.ok).toBe(true);
  });

  afterEach(async () => {
    await queue.stop();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("vid- generation: status is 'generating' immediately after enqueue", async () => {
    const asset = await fs.artifacts.create("vid", "gen-test");
    expect(asset.ok).toBe(true);
    if (!asset.ok) return;

    await queue.enqueue(`gen-${Date.now()}`, {
      type: "generate_grok_imagine_video",
      bookId: slug,
      vidAssetId: asset.value.slug,
      prompt: "ignored — handler is not registered",
    });

    const status = await fs.status.get(asset.value.slug);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.value).toBe("generating");
  });

  it("render: status is 'render-queued-landscape' immediately after enqueue", async () => {
    const asset = await fs.artifacts.create("vid", "ren-test");
    expect(asset.ok).toBe(true);
    if (!asset.ok) return;

    await queue.enqueue(`ren-${Date.now()}`, {
      type: "render_project",
      bookId: slug,
      assetId: asset.value.slug,
      orientation: "landscape",
    });

    const status = await fs.status.get(asset.value.slug);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.value).toBe("render-queued-landscape");
  });

  it("render-portrait classifies orientation correctly", async () => {
    const asset = await fs.artifacts.create("vid", "ren-port");
    expect(asset.ok).toBe(true);
    if (!asset.ok) return;

    await queue.enqueue(`ren-p-${Date.now()}`, {
      type: "render_project",
      bookId: slug,
      assetId: asset.value.slug,
      orientation: "portrait",
    });

    const status = await fs.status.get(asset.value.slug);
    expect(status.ok && status.value).toBe("render-queued-portrait");
  });

  it("QR outro render reports its queued orientation", async () => {
    const asset = await fs.artifacts.create("vid", "qr-outro");
    expect(asset.ok).toBe(true);
    if (!asset.ok) return;

    await queue.enqueue(`qr-outro-${Date.now()}`, {
      type: "render_qr_outro",
      bookId: slug,
      assetId: asset.value.slug,
      orientation: "landscape",
    });

    const status = await fs.status.get(asset.value.slug);
    expect(status.ok && status.value).toBe("render-queued-landscape");
  });

  it("trim: status is 'trimming' immediately after enqueue", async () => {
    const asset = await fs.artifacts.create("vid", "trim-test");
    expect(asset.ok).toBe(true);
    if (!asset.ok) return;

    await queue.enqueue(`trim-${Date.now()}`, {
      type: "trim_video",
      bookId: slug,
      assetId: asset.value.slug,
      start: 0,
      end: 1,
    });

    const status = await fs.status.get(asset.value.slug);
    expect(status.ok && status.value).toBe("trimming");
  });

  it.each([
    "suggest_cuts",
    "suggest_sfx",
    "analyze_jokes",
    "detect_scenes",
  ])("%s: status is 'analyzing' immediately after enqueue", async (type) => {
    const asset = await fs.artifacts.create("vid", `an-${type}`);
    expect(asset.ok).toBe(true);
    if (!asset.ok) return;

    await queue.enqueue(`an-${type}-${Date.now()}`, {
      type,
      bookId: slug,
      assetId: asset.value.slug,
    });

    const status = await fs.status.get(asset.value.slug);
    expect(status.ok && status.value).toBe("analyzing");
  });

  it("download: status is 'downloading' immediately after enqueue", async () => {
    const asset = await fs.artifacts.create("vid", "dl-test");
    expect(asset.ok).toBe(true);
    if (!asset.ok) return;

    await queue.enqueue(`dl-${Date.now()}`, {
      type: "download_video",
      bookId: slug,
      assetId: asset.value.slug,
      url: "https://example.com/x.mp4",
    });

    const status = await fs.status.get(asset.value.slug);
    expect(status.ok && status.value).toBe("downloading");
  });
});
