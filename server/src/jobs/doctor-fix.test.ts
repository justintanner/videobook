import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createEngineForTest } from "../engine.js";
import { failPendingTaskAndLog } from "./task-failure.js";
import { createTestClient } from "../test-client.js";
import { stopBookQueue } from "../queue.js";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine } from "videobook-engine";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parse<T>(res: Awaited<ReturnType<Client["callTool"]>>): T {
  return JSON.parse((res.content as Array<{ type: string; text: string }>)[0].text) as T;
}

async function createAsset(
  fs: Engine,
  prefix: string,
  name: string,
): Promise<string> {
  const result = await fs.artifacts.create(prefix, name);
  if (!result.ok) throw new Error(`createAsset failed: ${result.error.message}`);
  return result.value.artifactId;
}

/** Drive an asset into the error state: claim a lease, write a pending task,
 *  then fail it — exactly the path a crashed generation job leaves behind. */
async function breakAsset(
  fs: Engine,
  _bookId: string,
  assetId: string,
  taskId: string,
): Promise<void> {
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

interface DoctorReport {
  book_id: string;
  total: number;
  healthy: number;
  broken: Array<{ asset_id: string; type: string; error: { message: string } | null }>;
  stuck: Array<{ asset_id: string; type: string; work_status: string; minutes_overdue: number }>;
  hint?: string;
  catalog_gc?: {
    bookId: string;
    name: string;
    bytesBefore: number;
    bytesAfter: number;
    chunksRemoved: number | null;
    chunksKept: number | null;
    summary: string;
  };
}

interface DoctorFixResult {
  status: string;
  asset_id: string;
  asset_status?: string;
  from_commit?: string;
}

describe("doctor tool", () => {
  let client: Client;
  let tempDir: string;
  let fs: Engine;
  let bookId: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-doctor-test-"));
    client = await createTestClient(tempDir);
    fs = createEngineForTest(tempDir);
    bookId = fs.book.get().bookId;
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("reports broken and stuck assets and leaves healthy ones unflagged (all types)", async () => {
    // Healthy script asset.
    const healthy = await createAsset(fs, "script", "good one");
    await fs.files.write(healthy, "original.md", "all is well");

    // Broken image asset (intact media but a recorded generation error).
    const broken = await createAsset(fs, "img", "failed one");
    await fs.files.write(broken, "original.png", Buffer.from([0xff]));
    await breakAsset(fs, bookId, broken, "task-broken");

    // Stuck audio asset: a working lease whose deadline has already elapsed.
    const stuck = await createAsset(fs, "aud", "wedged one");
    await fs.files.write(stuck, "original.mp3", Buffer.from([0x00]));
    const lease = await fs.jobs.artifactWork.begin(stuck, {
      kind: "generate",
      ownerKind: "job",
      durationMs: 500,
    });
    expect(lease).toBeTruthy();
    await sleep(1200);

    const res = await client.callTool({ name: "doctor", arguments: { book_id: bookId } });
    expect(res.isError).toBeFalsy();
    const report = parse<DoctorReport>(res);

    expect(report.broken.map((b) => b.asset_id)).toContain(broken);
    expect(report.broken.find((b) => b.asset_id === broken)?.error?.message).toBe("lease expired");
    expect(report.stuck.map((s) => s.asset_id)).toContain(stuck);
    expect(report.broken.map((b) => b.asset_id)).not.toContain(healthy);
    expect(report.stuck.map((s) => s.asset_id)).not.toContain(healthy);
    expect(report.hint).toBeTruthy();
  });

  it(
    "gc reports per-book bytes and shrinks a churned catalog",
    { timeout: 180_000 },
    async () => {
      // This fixture owns its leases. A background reaper must not turn the
      // oldest churn rows into runnable jobs while doctor compacts the catalog.
      await stopBookQueue(bookId);
      for (let index = 0; index < 2_000; index += 1) {
        fs.jobs.queue.enqueue({
          type: "doctor-gc-churn",
          payload: { index },
          maxAttempts: 1,
        });
        const leased = fs.jobs.queue.dequeue(1, 30_000);
        if (leased) fs.jobs.queue.heartbeat(leased.id, leased.fence, 30_000);
      }
      const catalog = join(tempDir, "data", "videobook.db");
      const bytesBefore = (await stat(catalog)).size;
      const res = await client.callTool({
        name: "doctor",
        arguments: { book_id: bookId, gc: true },
      });
      expect(res.isError).toBeFalsy();
      const report = parse<DoctorReport>(res);
      expect(report.catalog_gc?.bookId).toBe(bookId);
      expect(report.catalog_gc?.bytesBefore).toBeGreaterThan(0);
      expect(report.catalog_gc?.bytesAfter).toBeLessThanOrEqual(
        report.catalog_gc!.bytesBefore,
      );
      expect(report.catalog_gc?.summary).toMatch(/chunks/i);
      expect((await stat(catalog)).size).toBeLessThanOrEqual(bytesBefore);
      expect(report.catalog_gc!.bytesAfter).toBeLessThan(bytesBefore);
    },
  );

  it("fix recovers an asset in place when its media is intact (tier 1)", async () => {
    const assetId = await createAsset(fs, "img", "recoverable");
    await fs.files.write(assetId, "original.png", Buffer.from([0xff]));
    await breakAsset(fs, bookId, assetId, "task-recover");

    const before = await fs.status.get(assetId);
    expect(before.ok && before.value).toBe("error");

    const res = await client.callTool({
      name: "doctor",
      arguments: { book_id: bookId, asset_id: assetId, fix: true },
    });
    expect(res.isError).toBeFalsy();
    const result = parse<DoctorFixResult>(res);
    expect(result.status).toBe("recovered_in_place");
    expect(result.asset_status).toBe("ready");

    const after = await fs.status.get(assetId);
    expect(after.ok && after.value).toBe("ready");
    const err = await fs.jobs.failures.read(assetId);
    expect(err.ok && err.value).toBeFalsy();
  });

  it("fix restores from git history when the working tree is broken (tier 2)", async () => {
    const assetId = await createAsset(fs, "img", "restorable");
    // Commit a usable state: media present.
    await fs.files.write(assetId, "original.png", Buffer.from([0xde, 0xad]));
    await fs.history.recordOperation("doctor-test-seed-media", assetId, {});
    // Break the working tree: remove the primary media and record a failure, so
    // the asset is genuinely in 'error' and can't be recovered in place.
    await fs.files.delete(assetId, "original.png");
    await breakAsset(fs, bookId, assetId, "task-restore");
    await fs.history.recordOperation("doctor-test-break", assetId, {});

    const before = await fs.status.get(assetId);
    expect(before.ok && before.value).toBe("error");

    const res = await client.callTool({
      name: "doctor",
      arguments: { book_id: bookId, asset_id: assetId, fix: true },
    });
    expect(res.isError).toBeFalsy();
    const result = parse<DoctorFixResult>(res);
    expect(result.status).toBe("restored");
    expect(result.asset_status).toBe("ready");
    expect(result.from_commit).toBeTruthy();

    const after = await fs.status.get(assetId);
    expect(after.ok && after.value).toBe("ready");
    const manifest = await fs.files.manifest(assetId);
    expect(manifest.ok && manifest.value.files.some((f) => f.name === "original.png")).toBe(true);
  });

  it("rejects fix without an explicit asset_id", async () => {
    const res = await client.callTool({
      name: "doctor",
      arguments: { book_id: bookId, fix: true },
    });
    expect(res.isError).toBe(true);
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toMatch(/requires an explicit asset_id/i);
  });
});
