import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { queue } from "../queue.js";
import { createFs, type VideocityFs } from "videocity-engine";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

type TextContent = Array<{ type: string; text: string }>;

describe("render tool", () => {
  let client: Client;
  let fs: VideocityFs;
  let tempDir: string;
  const projectSlug = "test-proj";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-render-tool-test-"));
    client = await createTestClient(tempDir);
    fs = createFs({ projectsDir: tempDir });
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: projectSlug },
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function createVideoAsset(): Promise<string> {
    const created = await fs.createAsset("vid", "clip", projectSlug);
    if (!created.ok) throw new Error(created.error.message);
    const write = await fs.writeFile(created.value.assetId, "original.mp4", Buffer.from("fake-video"), projectSlug);
    if (!write.ok) throw new Error(write.error.message);
    return created.value.assetId;
  }

  it("enqueues one render job per orientation when none is specified", async () => {
    const enqueue = vi.spyOn(queue, "enqueue").mockResolvedValue(undefined);
    const assetId = await createVideoAsset();

    const result = await client.callTool({
      name: "render",
      arguments: { asset_id: assetId, project_slug: projectSlug, subtitles_enabled: false },
    });

    expect(result.isError).toBeFalsy();
    expect(enqueue).toHaveBeenCalledTimes(3);
    const orientations = enqueue.mock.calls.map((call) => call[1].orientation);
    expect(orientations).toEqual(["landscape", "portrait", "square"]);
  });

  it("clears a stale error row so a re-render can claim the asset", async () => {
    vi.spyOn(queue, "enqueue").mockResolvedValue(undefined);
    const assetId = await createVideoAsset();
    // Wedge the asset the way a failed job does: status='error' rows are
    // refused by beginAssetWork and never reset by enqueue.
    const lease = await fs.assetWork.begin(projectSlug, assetId, {
      kind: "render",
      ownerKind: "job",
      durationMs: 60_000,
    });
    if (!lease) throw new Error("test setup: could not begin lease");
    await fs.assetWork.fail(projectSlug, assetId, lease.ownerId, { message: "boom" });
    const blocked = await fs.assetWork.begin(projectSlug, assetId, {
      kind: "render",
      ownerKind: "job",
      durationMs: 60_000,
    });
    expect(blocked).toBeNull();

    const result = await client.callTool({
      name: "render",
      arguments: { asset_id: assetId, project_slug: projectSlug, orientation: "landscape", subtitles_enabled: false },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("enqueued");
    const errorRow = await fs.generationErrors.read(projectSlug, assetId);
    if (!errorRow.ok) throw new Error(errorRow.error.message);
    expect(errorRow.value).toBeNull();
    const reclaimed = await fs.assetWork.begin(projectSlug, assetId, {
      kind: "render",
      ownerKind: "job",
      durationMs: 60_000,
    });
    expect(reclaimed).not.toBeNull();
    if (reclaimed) await fs.assetWork.complete(projectSlug, assetId, reclaimed.ownerId);
  });
});
