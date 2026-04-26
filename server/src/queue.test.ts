import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as fsP from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { createFs } from "clipfirst-fs";

describe("server queue (sqlite-backed)", () => {
  let projectsDir: string;

  beforeEach(async () => {
    projectsDir = await fsP.mkdtemp(path.join(os.tmpdir(), "cfs-srv-q-"));
  });

  afterEach(async () => {
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
});
