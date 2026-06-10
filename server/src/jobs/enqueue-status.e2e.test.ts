import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFsForTest } from "../fs.js";
import { queue, setProjectsDir } from "../queue.js";
import type { VideocityFs } from "videocity-engine";

/**
 * Asserts the gen-start red-flash bug stays fixed: after a tool calls
 * queue.enqueue, the asset status must be the in-progress UI state
 * immediately — never `"error"` — so the sidebar card paints green from t=0.
 *
 * No job handlers are registered, so the queue runner's resolveHandler
 * returns null for these job types and the job stays queued indefinitely.
 * The assets row that writePendingAssetRow co-wrote at enqueue is what
 * computeAssetStatus must consult.
 */
describe("enqueue status (no red-flash window)", () => {
  let tempDir: string;
  let fs: VideocityFs;
  const slug = "test-proj";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-enqstatus-"));
    await setProjectsDir(tempDir);
    fs = createFsForTest(tempDir);
    const created = await fs.createProject(slug);
    expect(created.ok).toBe(true);
  });

  afterEach(async () => {
    await queue.stop();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("vid- generation: status is 'generating' immediately after enqueue", async () => {
    const asset = await fs.createAsset("vid", "gen-test", slug);
    expect(asset.ok).toBe(true);
    if (!asset.ok) return;

    await queue.enqueue(`gen-${Date.now()}`, {
      type: "generate_grok_imagine_video",
      projectSlug: slug,
      vidAssetId: asset.value.assetId,
      prompt: "ignored — handler is not registered",
    });

    const status = await fs.getAssetStatus(asset.value.assetId, slug);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.value).toBe("generating");
  });

  it("render: status is 'render-queued-landscape' immediately after enqueue", async () => {
    const asset = await fs.createAsset("vid", "ren-test", slug);
    expect(asset.ok).toBe(true);
    if (!asset.ok) return;

    await queue.enqueue(`ren-${Date.now()}`, {
      type: "render_project",
      projectSlug: slug,
      assetId: asset.value.assetId,
      orientation: "landscape",
    });

    const status = await fs.getAssetStatus(asset.value.assetId, slug);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.value).toBe("render-queued-landscape");
  });

  it("render-portrait classifies orientation correctly", async () => {
    const asset = await fs.createAsset("vid", "ren-port", slug);
    expect(asset.ok).toBe(true);
    if (!asset.ok) return;

    await queue.enqueue(`ren-p-${Date.now()}`, {
      type: "render_project",
      projectSlug: slug,
      assetId: asset.value.assetId,
      orientation: "portrait",
    });

    const status = await fs.getAssetStatus(asset.value.assetId, slug);
    expect(status.ok && status.value).toBe("render-queued-portrait");
  });

  it("trim: status is 'trimming' immediately after enqueue", async () => {
    const asset = await fs.createAsset("vid", "trim-test", slug);
    expect(asset.ok).toBe(true);
    if (!asset.ok) return;

    await queue.enqueue(`trim-${Date.now()}`, {
      type: "trim_video",
      projectSlug: slug,
      assetId: asset.value.assetId,
      start: 0,
      end: 1,
    });

    const status = await fs.getAssetStatus(asset.value.assetId, slug);
    expect(status.ok && status.value).toBe("trimming");
  });

  it("download: status is 'downloading' immediately after enqueue", async () => {
    const asset = await fs.createAsset("vid", "dl-test", slug);
    expect(asset.ok).toBe(true);
    if (!asset.ok) return;

    await queue.enqueue(`dl-${Date.now()}`, {
      type: "download_video",
      projectSlug: slug,
      assetId: asset.value.assetId,
      url: "https://example.com/x.mp4",
    });

    const status = await fs.getAssetStatus(asset.value.assetId, slug);
    expect(status.ok && status.value).toBe("downloading");
  });
});
