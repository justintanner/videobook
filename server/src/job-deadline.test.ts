import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fsP from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createFs } from "videobook-engine";
import { JobDeadlineError, runWithJobDeadline } from "./job-deadline.js";
import type { JobHandlerContext, LeaseToken } from "./queue.js";
import { withLockedLocalLease } from "./jobs/_lease.js";

describe("job deadlines", () => {
  let projectsDir: string;

  beforeEach(async () => {
    projectsDir = await fsP.mkdtemp(path.join(os.tmpdir(), "vc-job-deadline-"));
  });

  afterEach(async () => {
    await fsP.rm(projectsDir, { recursive: true, force: true });
  });

  it("fails the job and releases its asset lease and file lock", async () => {
    const fs = createFs({ projectsDir });
    const project = await fs.createProject("p");
    expect(project.ok).toBe(true);
    const asset = await fs.createAsset("vid", "deadline", "p");
    expect(asset.ok).toBe(true);
    if (!asset.ok) return;

    const runner = await fs.queue.createRunner("p", {
      concurrency: 1,
      pollIntervalMs: 10,
      resolveHandler: (type) => type === "deadline_probe"
        ? async () => runWithJobDeadline(
          type,
          async (signal) => {
            let lease: LeaseToken | null = null;
            const ctx: JobHandlerContext = {
              signal,
              setLease: (token) => {
                lease = token;
              },
              getOwnerId: () => {
                if (lease?.kind === "owner") return lease.ownerId;
                throw new Error("owner lease not registered");
              },
            };
            return withLockedLocalLease(
              fs,
              "p",
              asset.value.assetId,
              asset.value.path,
              ctx,
              "render",
              { durationMs: 5_000 },
              async () => new Promise<never>((_resolve, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason), { once: true });
              }),
              { durationMs: 5_000 },
            );
          },
          50,
          1_000,
        )
        : null,
    });
    runner.start();

    try {
      const enqueued = await fs.queue.enqueue("p", {
        type: "deadline_probe",
        assetId: asset.value.assetId,
        payload: {},
        dedupeKey: "deadline-probe",
        assetWorkKind: "render",
      });

      await expect(runner.waitFor(enqueued.job.id, 5_000)).rejects.toThrow(
        "Job deadline_probe timed out after 50ms",
      );

      const job = await fs.queue.getJob("p", enqueued.job.id);
      expect(job?.state).toBe("failed");
      expect(job?.error?.code).toBe(JobDeadlineError.name);

      const work = await fs.assetWork.read("p", asset.value.assetId);
      expect(work.ok).toBe(true);
      if (work.ok) {
        expect(work.value?.status).toBe("error");
        expect(work.value?.ownerId).toBeNull();
      }

      const lock = await fs.acquireLock(asset.value.path, { durationMs: 1_000 });
      expect(lock.ok).toBe(true);
      if (lock.ok) await fs.releaseLock(asset.value.path);
    } finally {
      await runner.stop();
      fs.close();
    }
  });
});
