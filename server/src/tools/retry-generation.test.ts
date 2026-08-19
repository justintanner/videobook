import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createEngineForTest } from "../engine.js";
import { failPendingTaskAndLog } from "../jobs/task-failure.js";
import { createTestClient } from "../test-client.js";
import { queue } from "../queue.js";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine } from "videobook-engine";

type TextContent = Array<{ type: string; text: string }>;

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
  await failPendingTaskAndLog(fs, assetId, taskId, { message: "lease expired" });
}

describe("retry_generation tool", () => {
  let client: Client;
  let tempDir: string;
  let fs: Engine;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-retry-test-"));
    client = await createTestClient(tempDir);
    fs = createEngineForTest(tempDir);
    await client.callTool({ name: "create_project", arguments: { book_id: "retry-proj" } });
  });

  afterEach(async () => {
    await client?.close();
    await queue.stop();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("requeues the original payload and clears the error row", async () => {
    const assetResult = await fs.artifacts.create("vid", "failed-clip");
    if (!assetResult.ok) throw new Error("createAsset failed");
    const assetId = assetResult.value.artifactId;
    await failAsset(fs, "retry-proj", assetId, "task-original");

    // Persist a replayable generation-request payload (mirrors what the omni
    // tool writes between createAsset and enqueue).
    const payload = {
      type: "generate_google_omni_video",
      vidAssetId: assetId,
      vidAssetDir: assetId,
      bookId: fs.book.get().bookId,
      prompt: "a sunset",
    };
    await fs.metadata.artifacts.write(assetId, "generation-request", payload);

    const before = await fs.jobs.failures.read(assetId);
    expect(before.ok && before.value).toBeTruthy();

    const res = await client.callTool({
      name: "retry_generation",
      arguments: { asset_id: assetId, book_id: "retry-proj" },
    });
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse((res.content as TextContent)[0].text);
    expect(parsed.retried).toBe(true);
    expect(parsed.job_id).toContain(`retry-${assetId}`);

    const after = await fs.jobs.failures.read(assetId);
    expect(after.ok && after.value).toBeFalsy();
  });

  it("returns an error when no generation-request metadata exists", async () => {
    const assetResult = await fs.artifacts.create("vid", "no-meta");
    if (!assetResult.ok) throw new Error("createAsset failed");
    const assetId = assetResult.value.artifactId;

    const res = await client.callTool({
      name: "retry_generation",
      arguments: { asset_id: assetId, book_id: "retry-proj" },
    });
    expect(res.isError).toBe(true);
    expect((res.content as TextContent)[0].text).toContain("No generation-request metadata");
  });

  it("rejects a payload that targets a different asset", async () => {
    const a = await fs.artifacts.create("vid", "target");
    const b = await fs.artifacts.create("vid", "other");
    if (!a.ok || !b.ok) throw new Error("createAsset failed");
    await fs.metadata.artifacts.write(a.value.artifactId, "generation-request", {
      type: "generate_google_omni_video",
      vidAssetId: b.value.artifactId,
      bookId: "retry-proj",
      prompt: "x",
    });

    const res = await client.callTool({
      name: "retry_generation",
      arguments: { asset_id: a.value.artifactId, book_id: "retry-proj" },
    });
    expect(res.isError).toBe(true);
    expect((res.content as TextContent)[0].text).toContain("different asset");
  });
});
