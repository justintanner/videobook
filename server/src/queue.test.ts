import { closeEngineForTest, createEngineForTest } from "./engine.js";
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as fsP from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import {
  queue as appQueue,
  registerJobHandler,
  setEngineRoot,
  extractAssetId,
  drainBookQueuesForTests,
  listActiveBookJobsForTests,
  waitForBookQueuesIdleForTests,
} from "./queue.js";
import { withProviderHandoff } from "./jobs/_lease.js";

describe("server queue (Dolt-native)", () => {
  let projectsDir: string;
  let testEngine: ReturnType<typeof createEngineForTest> | undefined;

  beforeEach(async () => {
    projectsDir = await fsP.mkdtemp(path.join(os.tmpdir(), "cfs-srv-q-"));
  });

  afterEach(async () => {
    await appQueue.stop();
    if (testEngine) {
      closeEngineForTest(projectsDir, testEngine);
      testEngine = undefined;
    }
    await fsP.rm(projectsDir, { recursive: true, force: true });
  });

  it("lets provider handoff helpers reuse the queue wrapper owner", async () => {
    const cfs = createEngineForTest(projectsDir);
    testEngine = cfs;
    await setEngineRoot(projectsDir, cfs);
    const bookId = cfs.book.get().bookId;
    const asset = await cfs.artifacts.create("img", "handoff");
    expect(asset.ok).toBe(true);
    if (!asset.ok) return;

    const taskId = "provider-task-1";
    registerJobHandler("generate_provider_handoff_probe", async (_payload, ctx) =>
      withProviderHandoff(
        cfs,
        asset.value.artifactId,
        ctx,
        "generate",
        async (ownerId) => {
          const written = await cfs.jobs.pending.write({
              artifactId: asset.value.artifactId,
              taskId,
              taskType: "fal_nano_banana",
            }, ownerId
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
        bookId,
        imgAssetId: asset.value.artifactId,
      },
      5_000,
    );

    expect(result.ok).toBe(true);
    const pending = await cfs.jobs.pending.read(asset.value.artifactId);
    expect(pending.ok).toBe(true);
    expect(pending.ok ? pending.value?.taskId : null).toBe(taskId);
    await appQueue.stop();
  });

  it("releases a wrapper-owned synchronous generate before child jobs run", async () => {
    const cfs = createEngineForTest(projectsDir);
    testEngine = cfs;
    await setEngineRoot(projectsDir, cfs);
    const bookId = cfs.book.get().bookId;
    const asset = await cfs.artifacts.create("img", "sync");
    expect(asset.ok).toBe(true);
    if (!asset.ok) return;

    let childSawReady = false;
    registerJobHandler("generate_sync_probe", async () => {
      await appQueue.enqueue("sync-child-probe", {
        type: "sync_child_probe",
        bookId,
        assetId: asset.value.artifactId,
      });
      return { ok: true };
    });
    registerJobHandler("sync_child_probe", async () => {
      const row = await cfs.jobs.artifactWork.read(asset.value.artifactId);
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
        bookId,
        imgAssetId: asset.value.artifactId,
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
        return;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("child job did not complete");
  });

  it("drops the jobIdIndex entry once a job reaches a terminal state", async () => {
    const cfs = createEngineForTest(projectsDir);
    testEngine = cfs;
    await setEngineRoot(projectsDir, cfs);
    const bookId = cfs.book.get().bookId;

    registerJobHandler("index_cleanup_probe", async () => ({ ok: true }));

    await appQueue.enqueue("index-cleanup-probe", {
      type: "index_cleanup_probe",
      bookId,
    });

    // The getStatus call that first observes a terminal state also evicts the
    // index entry, so memory can't grow unbounded across fire-and-forget jobs.
    const start = Date.now();
    let sawCompleted = false;
    while (Date.now() - start < 5_000) {
      const status = await appQueue.getStatus("index-cleanup-probe");
      if (status?.state === "completed") {
        sawCompleted = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(sawCompleted).toBe(true);

    // Entry is gone: a follow-up lookup is a miss rather than a stale hit.
    expect(await appQueue.getStatus("index-cleanup-probe")).toBeNull();

    await appQueue.stop();
  });
});


describe("extractAssetId", () => {


  it("prefers imgAssetId over other keys when present", () => {
    expect(extractAssetId({
      imgAssetId: "img-a",
      assetId: "vid-b",
      charAssetId: "char-c",
    })).toBe("img-a");
  });

  it("returns null when no known asset id key is present", () => {
    expect(extractAssetId({ type: "unknown_type", bookId: "p" })).toBeNull();
  });
});

describe("waitForBookQueuesIdleForTests", () => {
  let projectsDir: string;
  let testEngine: ReturnType<typeof createEngineForTest> | undefined;

  beforeEach(async () => {
    projectsDir = await fsP.mkdtemp(path.join(os.tmpdir(), "cfs-srv-drain-"));
  });

  afterEach(async () => {
    await appQueue.stop();
    if (testEngine) {
      closeEngineForTest(projectsDir, testEngine);
      testEngine = undefined;
    }
    await fsP.rm(projectsDir, { recursive: true, force: true });
  });

  it("names the leftover job type when a leaked job exceeds the drain budget", async () => {
    const cfs = createEngineForTest(projectsDir);
    testEngine = cfs;
    await setEngineRoot(projectsDir, cfs);
    const bookId = cfs.book.get().bookId;
    registerJobHandler("leak_probe", async (_payload, ctx) => {
      await new Promise<void>((resolve) => {
        if (ctx.signal.aborted) {
          resolve();
          return;
        }
        ctx.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    await appQueue.enqueue("leak-probe-1", { type: "leak_probe", bookId });
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    expect(listActiveBookJobsForTests().some((job) => job.type === "leak_probe")).toBe(true);
    await expect(
      waitForBookQueuesIdleForTests({
        budgetMs: 80,
        fileLabel: "queue.test.ts :: leaked job",
      }),
    ).rejects.toThrow(/\[test drain] queue\.test\.ts :: leaked job still running after 80ms: leak_probe/);
    await drainBookQueuesForTests({ budgetMs: 50, fileLabel: "queue.test.ts :: cleanup" }).catch(
      () => undefined,
    );
    expect(listActiveBookJobsForTests()).toEqual([]);
  });
});
