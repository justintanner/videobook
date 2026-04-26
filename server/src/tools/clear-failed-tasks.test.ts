import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFsForTest } from "../fs.js";
import { failPendingTask } from "../jobs/pending-task.js";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ClipfirstFs } from "clipfirst-fs";

async function createImageAsset(fs: ClipfirstFs, projectSlug: string, name: string): Promise<string> {
  // Create the asset directly via fs.createAsset rather than upload_file so
  // we don't enqueue a process_image job. The async job would race with the
  // test's failPendingTask + clear_failed_tasks calls and pollute results
  // (process_image fails on synthetic image bytes and would write its own
  // generation-error.json, getting swept up by clear_failed_tasks).
  const result = await fs.createAsset("img", name, projectSlug);
  if (!result.ok) throw new Error(`createAsset failed: ${result.error.message}`);
  return result.value.assetId;
}

describe("clear_failed_tasks tool", () => {
  let client: Client;
  let tempDir: string;
  let fs: ClipfirstFs;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-test-"));
    client = await createTestClient(tempDir);
    fs = createFsForTest(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "test-proj" },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("deletes assets that have a generation-error.json and leaves healthy ones alone", async () => {
    const failedOne = await createImageAsset(fs, "test-proj", "bad one");
    const failedTwo = await createImageAsset(fs, "test-proj", "bad two");
    const healthy = await createImageAsset(fs, "test-proj", "good");

    await failPendingTask(fs, failedOne, "test-proj", { message: "boom" });
    await failPendingTask(fs, failedTwo, "test-proj", { message: "kaboom" });

    const res = await client.callTool({
      name: "clear_failed_tasks",
      arguments: { project_slug: "test-proj" },
    });
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(
      (res.content as Array<{ type: string; text: string }>)[0].text,
    ) as { cleared: string[]; errors: Array<{ assetId: string; message: string }> };
    expect(parsed.cleared.sort()).toEqual([failedOne, failedTwo].sort());
    expect(parsed.errors).toEqual([]);

    for (const id of [failedOne, failedTwo]) {
      const manifest = await client.callTool({
        name: "asset_manifest",
        arguments: { asset_id: id, project_slug: "test-proj" },
      });
      expect(manifest.isError).toBe(true);
    }

    const healthyManifest = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: healthy, project_slug: "test-proj" },
    });
    expect(healthyManifest.isError).toBeFalsy();
  });

  it("returns empty lists when there are no failed assets", async () => {
    await createImageAsset(fs, "test-proj", "only good");

    const res = await client.callTool({
      name: "clear_failed_tasks",
      arguments: { project_slug: "test-proj" },
    });
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(
      (res.content as Array<{ type: string; text: string }>)[0].text,
    ) as { cleared: string[]; errors: unknown[] };
    expect(parsed.cleared).toEqual([]);
    expect(parsed.errors).toEqual([]);
  });
});
