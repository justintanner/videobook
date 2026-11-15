import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLAIM_RETRY_INTERVAL_MS } from "./jobs/_lease.js";
import {
  currentAwaitNotebookOutputPollMs,
  currentQueuePollIntervalMs,
  DEFAULT_AWAIT_NOTEBOOK_OUTPUT_POLL_MS,
  DEFAULT_QUEUE_POLL_INTERVAL_MS,
} from "./poll-intervals.js";
import { STATUS_POLL_MIN_INTERVAL_MS } from "./x/post-to-x.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("deterministic test clocks", () => {
  it("keeps production lease and X poll intervals unchanged", () => {
    expect(CLAIM_RETRY_INTERVAL_MS).toBe(1_000);
    expect(STATUS_POLL_MIN_INTERVAL_MS).toBe(2_000);
    expect(DEFAULT_QUEUE_POLL_INTERVAL_MS).toBe(250);
    expect(DEFAULT_AWAIT_NOTEBOOK_OUTPUT_POLL_MS).toBe(2_000);
  });

  it("polls the queue and notebook output faster inside vitest only", () => {
    expect(currentQueuePollIntervalMs()).toBe(50);
    expect(currentAwaitNotebookOutputPollMs()).toBe(50);
    const previous = process.env.VITEST;
    delete process.env.VITEST;
    try {
      expect(currentQueuePollIntervalMs()).toBe(DEFAULT_QUEUE_POLL_INTERVAL_MS);
      expect(currentAwaitNotebookOutputPollMs()).toBe(DEFAULT_AWAIT_NOTEBOOK_OUTPUT_POLL_MS);
    } finally {
      if (previous === undefined) delete process.env.VITEST;
      else process.env.VITEST = previous;
    }
  });

  it("inventories remaining repeated polling helpers after the lease and X migrations", async () => {
    const queueSource = await readFile(join(root, "server/src/queue.ts"), "utf8");
    expect(queueSource).toContain("runner.waitFor");
    expect(queueSource).toMatch(/export async function waitForJob/);

    const remaining = [
      ["server/src/queue.test.ts", "queue runner observability (25ms)"],
      ["server/src/tools/poll-pending-provider-tasks.test.ts", "driver tick observation"],
      ["server/src/tools/reconcile-project-work.test.ts", "fire-and-forget workflow land"],
    ];
    for (const [relative] of remaining) {
      const source = await readFile(join(root, relative), "utf8");
      expect(source.includes("setTimeout") || source.includes("pollIntervalMs")).toBe(true);
    }
  });
});
