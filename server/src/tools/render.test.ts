import { createEngineForTest } from "../fs.js";
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
