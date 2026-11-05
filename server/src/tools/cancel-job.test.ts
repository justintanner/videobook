import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Engine, Result, EngineError } from "videobook-engine";
import { closeEngineForTest, createEngineForTest } from "../engine.js";
import { cancelJobDef } from "./cancel-job.js";

function value<T>(result: Result<T, EngineError>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("cancel orphaned provider task", () => {
  let root: string;
  let engine: Engine;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "videobook-cancel-task-"));
    engine = createEngineForTest(root);
    await engine.ready;
  });

  afterEach(async () => {
    closeEngineForTest(root, engine);
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  async function pending(taskId: string, live = false) {
    const assetId = value(await engine.artifacts.create("image", "Preserved image")).artifactId;
    const bytes = await sharp({ create: { width: 16, height: 16, channels: 3, background: "red" } }).png().toBuffer();
    value(await engine.files.write(assetId, "original.png", bytes));
    const lease = engine.jobs.artifactWork.begin(assetId, { kind: "generate", ownerKind: "job", durationMs: 60_000 });
    if (!lease) throw new Error("No work lease");
    expect(value(await engine.jobs.pending.write({ artifactId: assetId, taskId, taskType: "media_kie", meta: {} }, lease.ownerId))).not.toBeNull();
    if (!live) expect(engine.jobs.artifactWork.complete(assetId, lease.ownerId)).toBe(true);
    return { assetId, bytes };
  }

  const cancel = (assetId: string, taskId: string) => cancelJobDef(engine).handler({
    book_id: engine.book.get().bookId, asset_id: assetId, expected_task_id: taskId,
  });

  it.each([false, true])("clears only the matching task and retains media when completing=%s", async (completing) => {
    const target = await pending("target");
    const other = await pending("other");
    if (completing) value(engine.jobs.pending.markCompleting(target.assetId));
    const notebook = engine.notebooks.list();
    const result = await cancel(target.assetId, "target");
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text)).toEqual({ asset_id: target.assetId, task_id: "target", state: "aborted", provider_cancelled: false });
    expect(value(engine.jobs.pending.read(target.assetId))).toBeNull();
    expect(value(engine.jobs.pending.read(other.assetId))?.taskId).toBe("other");
    expect(value(engine.jobs.failures.read(target.assetId))).toMatchObject({ message: "Cancelled by user", failCode: "cancelled" });
    expect(value(await engine.files.read(target.assetId, "original.png"))).toEqual(target.bytes);
    expect(engine.notebooks.list()).toEqual(notebook);
  });

  it("refuses stale task identities and repeated cancellation without changing history", async () => {
    const target = await pending("replacement");
    const head = engine.head;
    expect((await cancel(target.assetId, "superseded")).isError).toBe(true);
    expect(engine.head).toBe(head);
    expect(value(engine.jobs.pending.read(target.assetId))?.taskId).toBe("replacement");
    expect((await cancel(target.assetId, "replacement")).isError).toBeUndefined();
    const cancelledHead = engine.head;
    expect((await cancel(target.assetId, "replacement")).isError).toBe(true);
    expect(engine.head).toBe(cancelledHead);
  });

  it("refuses a task while a local job or live work lease remains", async () => {
    const target = await pending("active");
    const queued = engine.jobs.queue.enqueue({ type: "semantic_index", payload: {}, dedupeKey: "active" }).job;
    expect((await cancel(target.assetId, "active")).isError).toBe(true);
    expect(value(engine.jobs.pending.read(target.assetId))?.taskId).toBe("active");
    expect(await engine.jobs.queue.abort(queued.id, "test cleanup")).toBe(true);
    const live = await pending("live", true);
    expect((await cancel(live.assetId, "live")).isError).toBe(true);
    expect(value(engine.jobs.pending.read(live.assetId))?.taskId).toBe("live");
  });

  it("requires one explicit target", async () => {
    const target = await pending("target");
    const tool = cancelJobDef(engine);
    for (const args of [{}, { asset_id: target.assetId }, { expected_task_id: "target" }, { job_id: 1, asset_id: target.assetId, expected_task_id: "target" }]) {
      expect((await tool.handler({ book_id: engine.book.get().bookId, ...args })).isError).toBe(true);
    }
    expect(value(engine.jobs.pending.read(target.assetId))?.taskId).toBe("target");
  });
});
