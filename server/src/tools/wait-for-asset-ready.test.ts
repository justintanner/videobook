import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { createEngineForTest } from "../engine.js";
import { waitForAssetReadyDef } from "./wait-for-asset-ready.js";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine } from "videobook-engine";
import { testBudget } from "../test-budget.js";

describe("wait_for_asset_ready tool", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "test-proj" },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("returns not_found for nonexistent asset", async () => {
    const result = await client.callTool({
      name: "wait_for_asset_ready",
      arguments: {
        asset_id: "vid-does-not-exist",
        book_id: "test-proj",
        timeout_seconds: 1,
      },
    });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text);
    expect(data.status).toBe("not_found");
  });

  it("returns ready immediately for asset with no pending task and not locked", async () => {
    // Create the asset directly so no process_image job is enqueued. The job
    // fails on synthetic bytes and writes a generation_errors row, which reconciliation
    // surfaces as a failure — same race the clear_failed_tasks test avoids.
    const fs = createEngineForTest(tempDir);
    const created = await fs.artifacts.create("img", "photo");
    if (!created.ok) throw new Error(created.error.message);

    const result = await client.callTool({
      name: "wait_for_asset_ready",
      arguments: {
        asset_id: created.value.artifactId,
        book_id: "test-proj",
        timeout_seconds: 1,
      },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text);
    expect(data.status).toBe("ready");
    expect(data.asset_id).toBe(created.value.artifactId);
  });
});

describe("waitForAssetReadyDef handler", () => {
  let fs: Engine;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-wait-ready-test-"));
    fs = createEngineForTest(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("returns timeout for asset with pending task that never completes", async () => {
    const assetResult = await fs.artifacts.create("vid", "pending-asset");
    if (!assetResult.ok) throw new Error(assetResult.error.message);
    const assetId = assetResult.value.artifactId;

    {
      const lease = await fs.jobs.artifactWork.begin(assetId, {
        kind: "transcribe",
        ownerKind: "job",
        durationMs: 60_000,
      });
      if (!lease) throw new Error(`assetWork.begin failed for ${assetId}`);
      const _ptResult = await fs.jobs.pending.write({
          artifactId: assetResult.value.artifactId,
          taskId: "task-will-timeout",
          taskType: "transcribe",
          meta: {},
        }, lease.ownerId
      );
      if (!_ptResult.ok) throw new Error(`Failed to write pending-task for ${assetId}: ${_ptResult.error.message}`);
    }

    // No KIE_API_KEY so task polling is skipped, pending task stays
    const savedKey = process.env.KIE_API_KEY;
    delete process.env.KIE_API_KEY;

    try {
      const def = waitForAssetReadyDef(fs);
      const result = await def.handler({
        asset_id: assetId,
        book_id: "test-proj",
        timeout_seconds: 0,
      });

      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.status).toBe("timeout");
      expect(data.asset_id).toBe(assetId);
      expect(data.iterations).toBeGreaterThanOrEqual(0);
    } finally {
      if (savedKey !== undefined) {
        process.env.KIE_API_KEY = savedKey;
      }
    }
  }, testBudget(15_000));

  it("does not report ready before an enqueued job claims its asset", async () => {
    const assetResult = await fs.artifacts.create("img", "queued-asset");
    if (!assetResult.ok) throw new Error(assetResult.error.message);
    const options = {
      type: "test_generation",
      artifactId: assetResult.value.artifactId,
      payload: {},
      artifactWorkKind: "generate" as const,
    };
    expect(options.artifactWorkKind).toBe("generate");
    fs.jobs.queue.enqueue(options);
    const queuedWork = await fs.jobs.artifactWork.read(assetResult.value.artifactId
    );
    expect(queuedWork.ok).toBe(true);
    if (!queuedWork.ok) throw new Error(queuedWork.error.message);
    expect(queuedWork.value).toMatchObject({
      status: "pending",
      meta: { kind: "generate", queued: true },
    });
    expect(
      fs.jobs.queue.list({
        artifactId: assetResult.value.artifactId,
      })[0]?.state,
    ).toBe("queued");

    const result = await waitForAssetReadyDef(fs).handler({
      asset_id: assetResult.value.artifactId,
      book_id: "test-proj",
      timeout_seconds: 0.01,
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.status).toBe("timeout");
  });

  it("ignores failed attempts after a successful recovery", async () => {
    const artifact = await fs.artifacts.create("image", "recovered");
    if (!artifact.ok) throw new Error(artifact.error.message);
    const artifactId = artifact.value.artifactId;
    const failed = fs.jobs.queue.enqueue({
      type: "analyze_video", artifactId, initialState: "running", payload: {}, maxAttempts: 1,
    }).job;
    await fs.jobs.queue.fail(failed.id, { error: { message: "No frames to analyze" }, allowRetry: false });
    const recovery = fs.jobs.queue.enqueue({
      type: "doctor_fix", artifactId, initialState: "running", payload: {},
    }).job;
    await fs.jobs.queue.complete(recovery.id, { result: { status: "recovered_in_place", asset_status: "ready" } });

    const result = await waitForAssetReadyDef(fs).handler({
      asset_id: artifactId, book_id: fs.book.get().bookId, timeout_seconds: 1,
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text).status).toBe("ready");
    expect(fs.jobs.queue.get(failed.id)?.state).toBe("failed");
  });

  it("waits for a queued retry instead of returning an older failure", async () => {
    const artifact = await fs.artifacts.create("image", "retrying");
    if (!artifact.ok) throw new Error(artifact.error.message);
    const artifactId = artifact.value.artifactId;
    const failed = fs.jobs.queue.enqueue({
      type: "process_video", artifactId, initialState: "running", payload: {}, maxAttempts: 1,
    }).job;
    await fs.jobs.queue.fail(failed.id, { error: { message: "Old processing failure" }, allowRetry: false });
    fs.jobs.queue.enqueue({ type: "process_video", artifactId, payload: {} });

    const result = await waitForAssetReadyDef(fs).handler({
      asset_id: artifactId, book_id: fs.book.get().bookId, timeout_seconds: 0.01,
    });
    expect(JSON.parse(result.content[0].text).status).toBe("timeout");
  });

  it("reports the latest failed attempt even after an earlier recovery", async () => {
    const artifact = await fs.artifacts.create("image", "failed again");
    if (!artifact.ok) throw new Error(artifact.error.message);
    const artifactId = artifact.value.artifactId;
    const recovery = fs.jobs.queue.enqueue({
      type: "doctor_fix", artifactId, initialState: "running", payload: {},
    }).job;
    await fs.jobs.queue.complete(recovery.id, { result: { status: "recovered_in_place", asset_status: "ready" } });
    const failed = fs.jobs.queue.enqueue({
      type: "analyze_video", artifactId, initialState: "running", payload: {}, maxAttempts: 1,
    }).job;
    await fs.jobs.queue.fail(failed.id, { error: { message: "New analysis failure" }, allowRetry: false });

    const result = await waitForAssetReadyDef(fs).handler({
      asset_id: artifactId, book_id: fs.book.get().bookId, timeout_seconds: 1,
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      status: "failed", error: "New analysis failure",
    });
  });

  it.each(["busy", "unfixable"])("keeps failures when Doctor returns %s", async (status) => {
    const artifact = await fs.artifacts.create("image", "not recovered");
    if (!artifact.ok) throw new Error(artifact.error.message);
    const artifactId = artifact.value.artifactId;
    const failed = fs.jobs.queue.enqueue({
      type: "process_video", artifactId, initialState: "running", payload: {}, maxAttempts: 1,
    }).job;
    await fs.jobs.queue.fail(failed.id, { error: { message: "Processing failed" }, allowRetry: false });
    const recovery = fs.jobs.queue.enqueue({
      type: "doctor_fix", artifactId, initialState: "running", payload: {},
    }).job;
    await fs.jobs.queue.complete(recovery.id, { result: { status, asset_status: "error" } });

    const result = await waitForAssetReadyDef(fs).handler({
      asset_id: artifactId, book_id: fs.book.get().bookId, timeout_seconds: 1,
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ status: "failed", error: "Processing failed" });
  });
});
