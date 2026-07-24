import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createEngineForTest } from "../fs.js";
import { failPendingTaskAndLog } from "../jobs/task-failure.js";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Engine } from "videobook-engine";

async function createImageAsset(fs: Engine, bookId: string, name: string): Promise<string> {
  const result = await fs.artifacts.create("img", name);
  if (!result.ok) throw new Error(`createAsset failed: ${result.error.message}`);
  return result.value.slug;
}

async function writeSyntheticPendingTask(
  fs: Engine,
  bookId: string,
  assetId: string,
  taskId: string,
): Promise<void> {
  const lease = await fs.jobs.artifactWork.begin(assetId, {
    kind: "generate",
    ownerKind: "job",
    durationMs: 60_000,
  });
  if (!lease) throw new Error(`assetWork.begin failed for ${assetId}`);
  const written = await fs.jobs.pending.write({
      artifactId: assetId,
      taskId,
      taskType: "alibaba_image",
      meta: {},
    }, lease.ownerId
  );
  if (!written.ok) throw new Error(`pendingTasks.write failed: ${written.error.message}`);
  if (!written.value) throw new Error(`pendingTasks.write lost lease for ${assetId}`);
}

describe("clear_failed_tasks tool", () => {
  let client: Client;
  let tempDir: string;
  let fs: Engine;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-test-"));
    client = await createTestClient(tempDir);
    fs = createEngineForTest(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "test-proj" },
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
      name: "clean_failed_assets",
      arguments: { book_id: "test-proj" },
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
        arguments: { asset_id: id, book_id: "test-proj" },
      });
      expect(manifest.isError).toBe(true);
    }

    const healthyManifest = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: healthy, book_id: "test-proj" },
    });
    expect(healthyManifest.isError).toBeFalsy();
  });

  it("keeps a materialized asset and clears its error row instead of deleting", async () => {
    // A completed video whose sidecar job (e.g. ElevenLabs transcribe) failed:
    // it has real media, so /clear-failed must not destroy it.
    const created = await fs.artifacts.create("vid", "real clip");
    if (!created.ok) throw new Error(created.error.message);
    const videoAsset = created.value.slug;
    const written = await fs.files.write(videoAsset, "original.mp4", Buffer.from("fake-video"));
    if (!written.ok) throw new Error(written.error.message);
    const errWritten = await fs.jobs.failures.write(videoAsset, {
      message: "ElevenLabs API error 401: Invalid API key",
    });
    if (!errWritten.ok) throw new Error(errWritten.error.message);

    const husk = await createImageAsset(fs, "test-proj", "dead gen");
    await writeSyntheticPendingTask(fs, "test-proj", husk, "task-husk");
    await failPendingTaskAndLog(fs, "test-proj", husk, "task-husk", { message: "boom" });

    const res = await client.callTool({
      name: "clean_failed_assets",
      arguments: { book_id: "test-proj" },
    });
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(
      (res.content as Array<{ type: string; text: string }>)[0].text,
    ) as { cleared: string[]; error_cleared: string[]; errors: unknown[] };
    expect(parsed.cleared).toEqual([husk]);
    expect(parsed.error_cleared).toEqual([videoAsset]);
    expect(parsed.errors).toEqual([]);

    // Video asset survives with its media; error row is gone.
    const manifest = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: videoAsset, book_id: "test-proj" },
    });
    expect(manifest.isError).toBeFalsy();
    const errorRow = await fs.jobs.failures.read(videoAsset);
    expect(errorRow.ok && errorRow.value).toBeNull();
  });

  it("returns empty lists when there are no failed assets", async () => {
    await createImageAsset(fs, "test-proj", "only good");

    const res = await client.callTool({
      name: "clean_failed_assets",
      arguments: { book_id: "test-proj" },
    });
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(
      (res.content as Array<{ type: string; text: string }>)[0].text,
    ) as { cleared: string[]; errors: unknown[] };
    expect(parsed.cleared).toEqual([]);
    expect(parsed.errors).toEqual([]);
  });
});
