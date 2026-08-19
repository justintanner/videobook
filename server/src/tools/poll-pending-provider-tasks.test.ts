import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "videobook-engine";
import { createEngineForTest } from "../engine.js";
import {
  configureProviderPollDriverForTests,
  isProviderPollDriverActive,
  queue,
  resetProviderPollDriverForTests,
  setEngineRoot,
  setProviderPollTickHookForTests,
  stopBookQueue,
} from "../queue.js";
import { pollPendingProviderTasks } from "./reconcile-project-work.js";

async function seedPendingTask(
  fs: Engine,
  taskType = "gpt_image",
  taskId = "synthetic-provider-task",
): Promise<{ assetSlug: string; taskId: string }> {
  const asset = await fs.artifacts.create("img", "poll-seed");
  if (!asset.ok) throw new Error(asset.error.message);

  const lease = await fs.jobs.artifactWork.begin(asset.value.artifactId, {
    kind: "generate",
    ownerKind: "job",
    durationMs: 60_000,
  });
  if (!lease) throw new Error("assetWork.begin failed");

  const written = await fs.jobs.pending.write(
    {
      artifactId: asset.value.artifactId,
      taskId,
      taskType,
      meta: { prompt: "a test image" },
    },
    lease.ownerId,
  );
  if (!written.ok) throw new Error(written.error.message);
  if (!written.value) throw new Error("pending write lost lease");

  return { assetSlug: asset.value.artifactId, taskId };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("pollPendingProviderTasks", () => {
  let fs: Engine;
  let tempDir: string;
  let bookId: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vb-poll-provider-"));
    fs = createEngineForTest(tempDir);
    await fs.ready;
    await setEngineRoot(tempDir, fs);
    bookId = fs.book.get().bookId;
  });

  afterEach(async () => {
    resetProviderPollDriverForTests();
    await queue.stop();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("is a no-op when the book has no pending tasks", async () => {
    const result = await pollPendingProviderTasks(fs, bookId);
    expect(result.pending).toEqual([]);
    expect(result.completed).toEqual([]);
    expect(result.failed).toEqual([]);

    const stillPending = await fs.jobs.pending.findAll();
    expect(stillPending.ok).toBe(true);
    if (stillPending.ok) expect(stillPending.value).toEqual([]);
  });

  it("ages out stale non-completing tasks via injectable timeout", async () => {
    const { assetSlug } = await seedPendingTask(fs);
    const before = await fs.jobs.pending.findAll();
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    expect(before.value).toHaveLength(1);

    const result = await pollPendingProviderTasks(fs, bookId, {
      timeoutMs: 1_000,
      nowMs: Date.now() + 60_000,
    });

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.assetId).toBe(assetSlug);
    expect(result.failed[0]?.failMsg).toMatch(/timed out/i);
    expect(result.pending).toEqual([]);
    expect(result.completed).toEqual([]);

    const after = await fs.jobs.pending.findAll();
    expect(after.ok).toBe(true);
    if (after.ok) expect(after.value).toEqual([]);
  });

  it("driver ticks poller when pending rows exist and stopBookQueue halts it", async () => {
    configureProviderPollDriverForTests({
      intervalMs: 50,
      timeoutMs: 1,
    });
    // Restart runner so the timer picks up the short interval
    await stopBookQueue(bookId);
    await setEngineRoot(tempDir, fs);

    expect(isProviderPollDriverActive(bookId)).toBe(true);

    let ticks = 0;
    setProviderPollTickHookForTests(() => {
      ticks += 1;
    });

    await seedPendingTask(fs, "gpt_image", "driver-lifecycle-task");
    // Allow createdAt to exceed 1ms timeout, then wait for at least one tick
    await sleep(120);

    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const pending = await fs.jobs.pending.findAll();
      if (pending.ok && pending.value.length === 0 && ticks >= 1) break;
      await sleep(40);
    }

    expect(ticks).toBeGreaterThanOrEqual(1);
    const agedOut = await fs.jobs.pending.findAll();
    expect(agedOut.ok).toBe(true);
    if (agedOut.ok) expect(agedOut.value).toEqual([]);

    const ticksAtStop = ticks;
    await stopBookQueue(bookId);
    expect(isProviderPollDriverActive(bookId)).toBe(false);

    await sleep(200);
    expect(ticks).toBe(ticksAtStop);
  });
});
