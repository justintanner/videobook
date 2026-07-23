import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFsForTest } from "../fs.js";
import { failPendingTaskAndLog } from "../jobs/task-failure.js";
import { createTestClient } from "../test-client.js";
import { queue } from "../queue.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { VideocityFs } from "videobook-engine";

type TextContent = Array<{ type: string; text: string }>;

async function failAsset(fs: VideocityFs, projectSlug: string, assetId: string, taskId: string): Promise<void> {
  const lease = await fs.assetWork.begin(projectSlug, assetId, {
    kind: "generate",
    ownerKind: "job",
    durationMs: 60_000,
  });
  if (!lease) throw new Error(`assetWork.begin failed for ${assetId}`);
  const written = await fs.pendingTasks.write(
    projectSlug,
    { taskId, taskType: "alibaba_image", assetId, assetDir: assetId, meta: {} },
    lease.ownerId,
  );
  if (!written.ok || !written.value) throw new Error(`pendingTasks.write failed for ${assetId}`);
  await failPendingTaskAndLog(fs, projectSlug, assetId, taskId, { message: "lease expired" });
}

describe("retry_generation tool", () => {
  let client: Client;
  let tempDir: string;
  let fs: VideocityFs;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-retry-test-"));
    client = await createTestClient(tempDir);
    fs = createFsForTest(tempDir);
    await client.callTool({ name: "create_project", arguments: { project_slug: "retry-proj" } });
  });

  afterEach(async () => {
    await client?.close();
    await queue.stop();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("requeues the original payload and clears the error row", async () => {
    const assetResult = await fs.createAsset("vid", "failed-clip", "retry-proj");
    if (!assetResult.ok) throw new Error("createAsset failed");
    const assetId = assetResult.value.assetId;
    await failAsset(fs, "retry-proj", assetId, "task-original");

    // Persist a replayable generation-request payload (mirrors what the omni
    // tool writes between createAsset and enqueue).
    const payload = {
      type: "generate_google_omni_video",
      vidAssetId: assetId,
      vidAssetDir: assetId,
      projectSlug: "retry-proj",
      prompt: "a sunset",
    };
    await fs.writeMetadata(assetId, "generation-request", payload, "retry-proj");

    const before = await fs.generationErrors.read("retry-proj", assetId);
    expect(before.ok && before.value).toBeTruthy();

    const res = await client.callTool({
      name: "retry_generation",
      arguments: { asset_id: assetId, project_slug: "retry-proj" },
    });
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse((res.content as TextContent)[0].text);
    expect(parsed.retried).toBe(true);
    expect(parsed.job_id).toContain(`retry-${assetId}`);

    const after = await fs.generationErrors.read("retry-proj", assetId);
    expect(after.ok && after.value).toBeFalsy();
  });

  it("returns an error when no generation-request metadata exists", async () => {
    const assetResult = await fs.createAsset("vid", "no-meta", "retry-proj");
    if (!assetResult.ok) throw new Error("createAsset failed");
    const assetId = assetResult.value.assetId;

    const res = await client.callTool({
      name: "retry_generation",
      arguments: { asset_id: assetId, project_slug: "retry-proj" },
    });
    expect(res.isError).toBe(true);
    expect((res.content as TextContent)[0].text).toContain("No generation-request metadata");
  });

  it("rejects a payload that targets a different asset", async () => {
    const a = await fs.createAsset("vid", "target", "retry-proj");
    const b = await fs.createAsset("vid", "other", "retry-proj");
    if (!a.ok || !b.ok) throw new Error("createAsset failed");
    await fs.writeMetadata(a.value.assetId, "generation-request", {
      type: "generate_google_omni_video",
      vidAssetId: b.value.assetId,
      projectSlug: "retry-proj",
      prompt: "x",
    }, "retry-proj");

    const res = await client.callTool({
      name: "retry_generation",
      arguments: { asset_id: a.value.assetId, project_slug: "retry-proj" },
    });
    expect(res.isError).toBe(true);
    expect((res.content as TextContent)[0].text).toContain("different asset");
  });
});
