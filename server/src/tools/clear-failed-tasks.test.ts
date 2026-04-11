import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFsForTest } from "../fs.js";
import { failPendingTask } from "../jobs/pending-task.js";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ClipfirstFs } from "clipfirst-fs";

async function uploadPng(client: Client, projectSlug: string, filename: string): Promise<string> {
  const data = Buffer.from("fake-png-data").toString("base64");
  const result = await client.callTool({
    name: "upload_file",
    arguments: { project_slug: projectSlug, filename, data },
  });
  const parsed = JSON.parse(
    (result.content as Array<{ type: string; text: string }>)[0].text,
  ) as { assetId: string };
  return parsed.assetId;
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
    const failedOne = await uploadPng(client, "test-proj", "bad-one.png");
    const failedTwo = await uploadPng(client, "test-proj", "bad-two.png");
    const healthy = await uploadPng(client, "test-proj", "good.png");

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
    await uploadPng(client, "test-proj", "only-good.png");

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
