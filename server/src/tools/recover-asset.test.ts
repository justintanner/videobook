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

async function failAsset(fs: Engine, bookId: string, assetId: string, taskId: string): Promise<void> {
  const lease = await fs.jobs.artifactWork.begin(assetId, {
    kind: "generate",
    ownerKind: "job",
    durationMs: 60_000,
  });
  if (!lease) throw new Error(`assetWork.begin failed for ${assetId}`);
  const written = await fs.jobs.pending.write({ taskId, taskType: "alibaba_image", artifactId: assetId, meta: {} }, lease.ownerId
  );
  if (!written.ok || !written.value) throw new Error(`pendingTasks.write failed for ${assetId}`);
  await failPendingTaskAndLog(fs, bookId, assetId, taskId, { message: "lease expired" });
}

interface RecoverResult { asset_id: string; recovered: boolean }

function parse(res: Awaited<ReturnType<Client["callTool"]>>): RecoverResult {
  return JSON.parse((res.content as Array<{ type: string; text: string }>)[0].text) as RecoverResult;
}

describe("recover_asset tool", () => {
  let client: Client;
  let tempDir: string;
  let fs: Engine;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-recover-test-"));
    client = await createTestClient(tempDir);
    fs = createEngineForTest(tempDir);
    await client.callTool({ name: "create_project", arguments: { book_id: "rec-proj" } });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("clears the error and keeps the asset intact", async () => {
    const assetId = await createImageAsset(fs, "rec-proj", "failed one");
    await fs.files.write(assetId, "original.png", Buffer.from([0xff]));
    await failAsset(fs, "rec-proj", assetId, "task-x");

    // Error is recorded before recovery.
    const before = await fs.jobs.failures.read(assetId);
    expect(before.ok && before.value).toBeTruthy();

    const res = await client.callTool({
      name: "recover_asset",
      arguments: { asset_id: assetId, book_id: "rec-proj" },
    });
    expect(res.isError).toBeFalsy();
    expect(parse(res)).toEqual({ asset_id: assetId, recovered: true });

    // Error gone, asset still present.
    const after = await fs.jobs.failures.read(assetId);
    expect(after.ok && after.value).toBeFalsy();
    const manifest = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: assetId, book_id: "rec-proj" },
    });
    expect(manifest.isError).toBeFalsy();
  });

  it("accepts an @-prefixed id and reports recovered=false when there was no error", async () => {
    const assetId = await createImageAsset(fs, "rec-proj", "healthy");

    const res = await client.callTool({
      name: "recover_asset",
      arguments: { asset_id: `@${assetId}`, book_id: "rec-proj" },
    });
    expect(res.isError).toBeFalsy();
    expect(parse(res)).toEqual({ asset_id: assetId, recovered: false });
  });
});
