import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createEngineForTest } from "../fs.js";
import { failPendingTaskAndLog } from "./task-failure.js";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Engine } from "videobook-engine";

const SLUG = "doc-proj";

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
  const result = await fs.artifacts.create(prefix, name, SLUG);
  if (!result.ok) throw new Error(`createAsset failed: ${result.error.message}`);
  return result.value.slug;
}

/** Drive an asset into the error state: claim a lease, write a pending task,
 *  then fail it — exactly the path a crashed generation job leaves behind. */
async function breakAsset(fs: Engine, assetId: string, taskId: string): Promise<void> {
  const lease = await fs.jobs.artifactWork.begin(SLUG, assetId, {
    kind: "generate",
    ownerKind: "job",
    durationMs: 60_000,
  });
  if (!lease) throw new Error(`assetWork.begin failed for ${assetId}`);
  const written = await fs.jobs.pending.write(
    SLUG,
    { taskId, taskType: "alibaba_image", artifactId: assetId, meta: {} },
    lease.ownerId,
  );
  if (!written.ok || !written.value) throw new Error(`pendingTasks.write failed for ${assetId}`);
  await failPendingTaskAndLog(fs, SLUG, assetId, taskId, { message: "lease expired" });
}

interface DoctorReport {
  project_slug: string;
  total: number;
  healthy: number;
  broken: Array<{ asset_id: string; type: string; error: { message: string } | null }>;
  stuck: Array<{ asset_id: string; type: string; work_status: string; minutes_overdue: number }>;
  hint?: string;
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

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-doctor-test-"));
    client = await createTestClient(tempDir);
    fs = createEngineForTest(tempDir);
    await client.callTool({ name: "create_project", arguments: { project_slug: SLUG } });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("reports broken and stuck assets and leaves healthy ones unflagged (all types)", async () => {
    // Healthy script asset.
    const healthy = await createAsset(fs, "script", "good one");
    await fs.files.write(healthy, "original.md", "all is well", SLUG);

    // Broken image asset (intact media but a recorded generation error).
    const broken = await createAsset(fs, "img", "failed one");
    await fs.files.write(broken, "original.png", Buffer.from([0xff]), SLUG);
    await breakAsset(fs, broken, "task-broken");

    // Stuck audio asset: a working lease whose deadline has already elapsed.
    const stuck = await createAsset(fs, "aud", "wedged one");
    await fs.files.write(stuck, "original.mp3", Buffer.from([0x00]), SLUG);
    const lease = await fs.jobs.artifactWork.begin(SLUG, stuck, {
      kind: "generate",
      ownerKind: "job",
      durationMs: 500,
    });
    expect(lease).toBeTruthy();
    await sleep(1200);

    const res = await client.callTool({ name: "doctor", arguments: { project_slug: SLUG } });
    expect(res.isError).toBeFalsy();
    const report = parse<DoctorReport>(res);

    expect(report.broken.map((b) => b.asset_id)).toContain(broken);
    expect(report.broken.find((b) => b.asset_id === broken)?.error?.message).toBe("lease expired");
    expect(report.stuck.map((s) => s.asset_id)).toContain(stuck);
    expect(report.broken.map((b) => b.asset_id)).not.toContain(healthy);
    expect(report.stuck.map((s) => s.asset_id)).not.toContain(healthy);
    expect(report.hint).toBeTruthy();
  });

  it("fix recovers an asset in place when its media is intact (tier 1)", async () => {
    const assetId = await createAsset(fs, "img", "recoverable");
    await fs.files.write(assetId, "original.png", Buffer.from([0xff]), SLUG);
    await breakAsset(fs, assetId, "task-recover");

    const before = await fs.status.get(assetId, SLUG);
    expect(before.ok && before.value).toBe("error");

    const res = await client.callTool({
      name: "doctor",
      arguments: { project_slug: SLUG, asset_id: assetId, fix: true },
    });
    expect(res.isError).toBeFalsy();
    const result = parse<DoctorFixResult>(res);
    expect(result.status).toBe("recovered_in_place");
    expect(result.asset_status).toBe("ready");

    const after = await fs.status.get(assetId, SLUG);
    expect(after.ok && after.value).toBe("ready");
    const err = await fs.jobs.failures.read(SLUG, assetId);
    expect(err.ok && err.value).toBeFalsy();
  });

  it("fix restores from git history when the working tree is broken (tier 2)", async () => {
    const assetId = await createAsset(fs, "img", "restorable");
    // Commit a usable state: media present.
    await fs.files.write(assetId, "original.png", Buffer.from([0xde, 0xad]), SLUG);
    await fs.history.recordOperation("doctor-test-seed-media", assetId, {}, SLUG);
    // Break the working tree: remove the primary media and record a failure, so
    // the asset is genuinely in 'error' and can't be recovered in place.
    await fs.files.delete(assetId, "original.png", SLUG);
    await breakAsset(fs, assetId, "task-restore");
    await fs.history.recordOperation("doctor-test-break", assetId, {}, SLUG);

    const before = await fs.status.get(assetId, SLUG);
    expect(before.ok && before.value).toBe("error");

    const res = await client.callTool({
      name: "doctor",
      arguments: { project_slug: SLUG, asset_id: assetId, fix: true },
    });
    expect(res.isError).toBeFalsy();
    const result = parse<DoctorFixResult>(res);
    expect(result.status).toBe("restored");
    expect(result.asset_status).toBe("ready");
    expect(result.from_commit).toBeTruthy();

    const after = await fs.status.get(assetId, SLUG);
    expect(after.ok && after.value).toBe("ready");
    const manifest = await fs.files.manifest(assetId, SLUG);
    expect(manifest.ok && manifest.value.files.some((f) => f.name === "original.png")).toBe(true);
  });

  it("rejects fix without an explicit asset_id", async () => {
    const res = await client.callTool({
      name: "doctor",
      arguments: { project_slug: SLUG, fix: true },
    });
    expect(res.isError).toBe(true);
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toMatch(/requires an explicit asset_id/i);
  });
});
