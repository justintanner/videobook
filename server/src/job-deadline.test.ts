import { createEngineForTest } from "./fs.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fsP from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

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
    const fs = createEngineForTest(projectsDir);
    const project = await fs.projects.create("p");
    expect(project.ok).toBe(true);
    const asset = await fs.artifacts.create("vid", "deadline", "p");
    expect(asset.ok).toBe(true);
    if (!asset.ok) return;

    const runner = await fs.jobs.queue.createRunner("p", {
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
              asset.value.slug,
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
      const enqueued = await fs.jobs.queue.enqueue("p", {
        type: "deadline_probe",
        assetId: asset.value.slug,
        payload: {},
        dedupeKey: "deadline-probe",
        artifactWorkKind: "render",
      });

      await expect(runner.waitFor(enqueued.job.id, 5_000)).rejects.toThrow(
        "Job deadline_probe timed out after 50ms",
      );

      const job = fs.jobs.queue.get("p", enqueued.job.id);
      expect(job?.state).toBe("failed");
      expect(job?.error?.code).toBe(JobDeadlineError.name);

      const work = await fs.jobs.artifactWork.read("p", asset.value.slug);
      expect(work.ok).toBe(true);
      if (work.ok) {
        expect(work.value?.status).toBe("error");
        expect(work.value?.ownerId).toBeNull();
      }

      const lock = await fs.jobs.locks.acquire(asset.value.path, { durationMs: 1_000 });
      expect(lock.ok).toBe(true);
      if (lock.ok) await fs.jobs.locks.release(asset.value.path);
    } finally {
      await runner.stop();
      fs.close();
    }
  });
});
