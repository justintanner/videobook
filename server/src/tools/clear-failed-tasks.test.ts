import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFsForTest } from "../fs.js";
import { failPendingTaskAndLog } from "../jobs/task-failure.js";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { VideocityFs } from "videocity-engine";

async function createImageAsset(fs: VideocityFs, projectSlug: string, name: string): Promise<string> {
  const result = await fs.createAsset("img", name, projectSlug);
  if (!result.ok) throw new Error(`createAsset failed: ${result.error.message}`);
  return result.value.assetId;
}

async function writeSyntheticPendingTask(
  fs: VideocityFs,
  projectSlug: string,
  assetId: string,
  taskId: string,
): Promise<void> {
  const lease = await fs.assetWork.begin(projectSlug, assetId, {
    kind: "generate",
    ownerKind: "job",
    durationMs: 60_000,
  });
  if (!lease) throw new Error(`assetWork.begin failed for ${assetId}`);
  const written = await fs.pendingTasks.write(
    projectSlug,
    {
      taskId,
      taskType: "alibaba_image",
      assetId,
      assetDir: assetId,
      meta: {},
    },
    lease.ownerId,
  );
  if (!written.ok) throw new Error(`pendingTasks.write failed: ${written.error.message}`);
  if (!written.value) throw new Error(`pendingTasks.write lost lease for ${assetId}`);
}

describe("clear_failed_tasks tool", () => {
  let client: Client;
  let tempDir: string;
  let fs: VideocityFs;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-test-"));
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

    const fakeTaskOne = "task-fail-one";
    const fakeTaskTwo = "task-fail-two";
    await writeSyntheticPendingTask(fs, "test-proj", failedOne, fakeTaskOne);
    await writeSyntheticPendingTask(fs, "test-proj", failedTwo, fakeTaskTwo);
    await failPendingTaskAndLog(fs, "test-proj", failedOne, fakeTaskOne, { message: "boom" });
    await failPendingTaskAndLog(fs, "test-proj", failedTwo, fakeTaskTwo, { message: "kaboom" });

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
