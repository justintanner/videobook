import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as fsP from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { createFs } from "vc-engine";
import {
  queue as appQueue,
  registerJobHandler,
  setProjectsDir,
} from "./queue.js";
import { withProviderHandoff } from "./jobs/_lease.js";

describe("server queue (sqlite-backed)", () => {
  let projectsDir: string;

  beforeEach(async () => {
    projectsDir = await fsP.mkdtemp(path.join(os.tmpdir(), "cfs-srv-q-"));
  });

  afterEach(async () => {
    await appQueue.stop();
    await fsP.rm(projectsDir, { recursive: true, force: true });
  });

  it("enqueues, runs handler, and resolves enqueueAndWait via the SQLite queue", async () => {
    const cfs = createFs({ projectsDir });
    const created = await cfs.createProject("p");
    expect(created.ok).toBe(true);

    const runner = (await cfs.queue.createRunner("p", {
      concurrency: 2,
      pollIntervalMs: 25,
      resolveHandler: (type) =>
        type === "noop"
          ? async (job) => ({ ok: true, ref: job.payload.ref })
          : null,
    }))!;
    runner.start();
    try {
      const result = await cfs.queue.enqueueAndWait<{ ok: boolean; ref: string }>(
        "p",
        {
          type: "noop",
          payload: { ref: "abc" },
          dedupeKey: "test-job-1",
        },
        5_000,
      );
      expect(result.ok).toBe(true);
      expect(result.ref).toBe("abc");
    } finally {
      await runner.stop();
      cfs.close();
    }
  });

  it("lets provider handoff helpers reuse the queue wrapper owner", async () => {
    await setProjectsDir(projectsDir);
    const cfs = createFs({ projectsDir });
    const created = await cfs.createProject("p");
    expect(created.ok).toBe(true);
    const asset = await cfs.createAsset("img", "handoff", "p");
    expect(asset.ok).toBe(true);
    if (!asset.ok) return;

    const taskId = "provider-task-1";
    registerJobHandler("generate_provider_handoff_probe", async (_payload, ctx) =>
      withProviderHandoff(
        cfs,
        "p",
        asset.value.assetId,
        ctx,
        "generate",
        async (ownerId) => {
          const written = await cfs.pendingTasks.write(
            "p",
            {
              assetId: asset.value.assetId,
              taskId,
              taskType: "fal_nano_banana",
              assetDir: asset.value.path,
            },
            ownerId,
          );
          expect(written.ok).toBe(true);
          if (!written.ok) throw new Error(written.error.message);
          expect(written.value).not.toBeNull();
          return { taskId, result: { ok: true } };
        },
      ),
    );

    const result = await appQueue.enqueueAndWait<{ ok: boolean }>(
      "provider-handoff-probe",
      {
        type: "generate_provider_handoff_probe",
        projectSlug: "p",
        imgAssetId: asset.value.assetId,
      },
      5_000,
    );

    expect(result.ok).toBe(true);
    const pending = await cfs.pendingTasks.read("p", asset.value.assetId);
    expect(pending.ok).toBe(true);
    expect(pending.ok ? pending.value?.taskId : null).toBe(taskId);
    await appQueue.stop();
    cfs.close();
  });

  it("releases a wrapper-owned synchronous generate before child jobs run", async () => {
    await setProjectsDir(projectsDir);
    const cfs = createFs({ projectsDir });
    const created = await cfs.createProject("p");
    expect(created.ok).toBe(true);
    const asset = await cfs.createAsset("img", "sync", "p");
    expect(asset.ok).toBe(true);
    if (!asset.ok) return;

    let childSawReady = false;
    registerJobHandler("generate_sync_probe", async () => {
      await appQueue.enqueue("sync-child-probe", {
        type: "sync_child_probe",
        projectSlug: "p",
        assetId: asset.value.assetId,
      });
      return { ok: true };
    });
    registerJobHandler("sync_child_probe", async () => {
      const row = await cfs.assetWork.read("p", asset.value.assetId);
      childSawReady =
        row.ok &&
        row.value?.status === "ready" &&
        row.value.ownerId === null;
      return { ok: true };
    });

    const result = await appQueue.enqueueAndWait<{ ok: boolean }>(
      "sync-parent-probe",
      {
        type: "generate_sync_probe",
        projectSlug: "p",
        imgAssetId: asset.value.assetId,
      },
      5_000,
    );
    expect(result.ok).toBe(true);

    const start = Date.now();
    while (Date.now() - start < 5_000) {
      const status = await appQueue.getStatus("sync-child-probe");
      if (status?.state === "completed") {
        expect(childSawReady).toBe(true);
        await appQueue.stop();
        cfs.close();
        return;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("child job did not complete");
  });
});
