import { createEngineForTest } from "../engine.js";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { queue } from "../queue.js";
import { type Engine } from "videobook-engine";
import type { Client } from "@modelcontextprotocol/client";

type TextContent = Array<{ type: string; text: string }>;

describe("render tool", () => {
  let client: Client;
  let fs: Engine;
  let tempDir: string;
  const bookId = "test-proj";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-render-tool-test-"));
    client = await createTestClient(tempDir);
    fs = createEngineForTest(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: bookId },
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function createVideoAsset(): Promise<string> {
    const created = await fs.artifacts.create("vid", "clip");
    if (!created.ok) throw new Error(created.error.message);
    const write = await fs.files.write(created.value.artifactId, "original.mp4", Buffer.from("fake-video"));
    if (!write.ok) throw new Error(write.error.message);
    return created.value.artifactId;
  }

  it("enqueues one render job per orientation when none is specified", async () => {
    const enqueue = vi.spyOn(queue, "enqueue").mockResolvedValue(undefined);
    const assetId = await createVideoAsset();

    const result = await client.callTool({
      name: "render_video",
      arguments: { asset_id: assetId, book_id: bookId },
    });

    expect(result.isError).toBeFalsy();
    expect(enqueue).toHaveBeenCalledTimes(3);
    const orientations = enqueue.mock.calls.map((call) => call[1].orientation);
    expect(orientations).toEqual(["landscape", "portrait", "square"]);
    for (const call of enqueue.mock.calls) {
      expect(call[1].subtitlesEnabled).toBe(false);
      expect(call[1].audioVolume).toBe(100);
      expect(call[1].audioFadeIn).toBe(0);
      expect(call[1].audioFadeOut).toBe(0);
    }
  });

  it("preserves explicit subtitle and audio settings", async () => {
    const enqueue = vi.spyOn(queue, "enqueue").mockResolvedValue(undefined);
    const assetId = await createVideoAsset();

    const result = await client.callTool({
      name: "render_video",
      arguments: {
        asset_id: assetId,
        book_id: bookId,
        orientation: "portrait",
        subtitles_enabled: true,
        audio_volume: 75,
        audio_fade_in: 200,
        audio_fade_out: 300,
      },
    });

    expect(result.isError).toBeFalsy();
    expect(enqueue).toHaveBeenCalledTimes(1);
    const payload = enqueue.mock.calls[0][1];
    expect(payload.subtitlesEnabled).toBe(true);
    expect(payload.audioVolume).toBe(75);
    expect(payload.audioFadeIn).toBe(200);
    expect(payload.audioFadeOut).toBe(300);
  });

  async function createWatermarkImageAsset(): Promise<string> {
    const created = await fs.artifacts.create("img", "badge");
    if (!created.ok) throw new Error(created.error.message);
    const assetId = created.value.artifactId;
    // Alphabetically the cover-crop preview sorts before the transparent
    // source; the resolver must still pick original.png.
    for (const name of ["landscape.jpg", "original.png", "portrait.jpg", "square.jpg"]) {
      const write = await fs.files.write(assetId, name, Buffer.from(`fake-${name}`));
      if (!write.ok) throw new Error(write.error.message);
    }
    return assetId;
  }

  it("resolves the OSG image to the original file, not a preview variant", async () => {
    const enqueue = vi.spyOn(queue, "enqueue").mockResolvedValue(undefined);
    const assetId = await createVideoAsset();
    const osgAssetId = await createWatermarkImageAsset();

    const result = await client.callTool({
      name: "render_video",
      arguments: {
        asset_id: assetId,
        book_id: bookId,
        orientation: "landscape",
        osg_asset_id: osgAssetId,
        osg_opacity: 0.5,
      },
    });

    expect(result.isError).toBeFalsy();
    const payload = enqueue.mock.calls[0][1];
    expect(String(payload.osgImagePath)).toMatch(/original\.png$/);
    expect(payload.osgAssetId).toBe(osgAssetId);
    expect(payload.osgOpacity).toBe(0.5);
  });

  it("falls back to stored per-orientation OSG settings when args omit them", async () => {
    const enqueue = vi.spyOn(queue, "enqueue").mockResolvedValue(undefined);
    const assetId = await createVideoAsset();
    const osgAssetId = await createWatermarkImageAsset();

    const overlay = await client.callTool({
      name: "set_video_overlay",
      arguments: {
        asset_id: assetId,
        book_id: bookId,
        osg_asset_id: osgAssetId,
        osg_position: "top-right",
        osg_positions: { landscape: "bottom-left", portrait: "top-left" },
        osg_size: "medium",
        osg_scale: 0.8,
        osg_opacity: 0.5,
      },
    });
    expect(overlay.isError).toBeFalsy();

    const result = await client.callTool({
      name: "render_video",
      arguments: { asset_id: assetId, book_id: bookId },
    });

    expect(result.isError).toBeFalsy();
    expect(enqueue).toHaveBeenCalledTimes(3);
    const byOrientation = new Map(enqueue.mock.calls.map((call) => [call[1].orientation, call[1]]));
    for (const [orientation, expected] of [
      ["landscape", "bottom-left"],
      ["portrait", "top-left"],
      ["square", "top-right"],
    ] as const) {
      const payload = byOrientation.get(orientation);
      expect(payload.osgAssetId).toBe(osgAssetId);
      expect(String(payload.osgImagePath)).toMatch(/original\.png$/);
      expect(payload.osgPosition).toBe(expected);
      expect(payload.osgScale).toBe(0.8);
      expect(payload.osgOpacity).toBe(0.5);
    }
  });

  it("renders without an OSG when nothing is stored", async () => {
    const enqueue = vi.spyOn(queue, "enqueue").mockResolvedValue(undefined);
    const assetId = await createVideoAsset();

    const result = await client.callTool({
      name: "render_video",
      arguments: { asset_id: assetId, book_id: bookId, orientation: "landscape" },
    });

    expect(result.isError).toBeFalsy();
    const payload = enqueue.mock.calls[0][1];
    expect(payload.osgAssetId).toBeNull();
    expect(payload.osgImagePath).toBeNull();
    expect(payload.osgPosition).toBe("top-right");
    expect(payload.osgOpacity).toBe(1);
  });

  it("clears a stale error row so a re-render can claim the asset", async () => {
    vi.spyOn(queue, "enqueue").mockResolvedValue(undefined);
    const assetId = await createVideoAsset();
    // Wedge the asset the way a failed job does: status='error' rows are
    // refused by beginAssetWork and never reset by enqueue.
    const lease = await fs.jobs.artifactWork.begin(assetId, {
      kind: "render",
      ownerKind: "job",
      durationMs: 60_000,
    });
    if (!lease) throw new Error("test setup: could not begin lease");
    await fs.jobs.artifactWork.fail(assetId, lease.ownerId, { message: "boom" });
    const blocked = await fs.jobs.artifactWork.begin(assetId, {
      kind: "render",
      ownerKind: "job",
      durationMs: 60_000,
    });
    expect(blocked).toBeNull();

    const result = await client.callTool({
      name: "render_video",
      arguments: { asset_id: assetId, book_id: bookId, orientation: "landscape", subtitles_enabled: false },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("enqueued");
    const errorRow = await fs.jobs.failures.read(assetId);
    if (!errorRow.ok) throw new Error(errorRow.error.message);
    expect(errorRow.value).toBeNull();
    const reclaimed = await fs.jobs.artifactWork.begin(assetId, {
      kind: "render",
      ownerKind: "job",
      durationMs: 60_000,
    });
    expect(reclaimed).not.toBeNull();
    if (reclaimed) await fs.jobs.artifactWork.complete(assetId, reclaimed.ownerId);
  });
});
