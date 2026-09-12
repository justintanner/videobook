import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "videobook-engine";
import { createEngineForTest } from "./engine.js";
import {
  configureProviderPollDriverForTests,
  isProviderPollDriverActive,
  queue,
  resetProviderPollDriverForTests,
  setEngineRoot,
  setProviderPollWorkHookForTests,
  stopBookQueue,
} from "./queue.js";
import { pollPendingProviderTasks } from "./tools/reconcile-project-work.js";

async function seedPendingTask(fs: Engine, taskId = "shutdown-poll-task"): Promise<string> {
  const asset = await fs.artifacts.create("img", "shutdown-poll");
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
      taskType: "gpt_image",
      meta: { prompt: "keep this pending" },
    },
    lease.ownerId,
  );
  if (!written.ok || !written.value) throw new Error("pending write failed");
  return asset.value.artifactId;
}

describe("queue and server stop abort in-flight provider polls", () => {
  let fs: Engine;
  let tempDir: string;
  let bookId: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vb-queue-shutdown-"));
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

  it("aborts an in-flight poll on queue.stop without corrupting durable tasks", async () => {
    configureProviderPollDriverForTests({ intervalMs: 20 });
    await stopBookQueue(bookId);
    await Promise.all(Array.from({ length: 4 }, () => queue.startBook(bookId)));
    const artifactId = await seedPendingTask(fs);

    let started = 0;
    setProviderPollWorkHookForTests(async (signal) => {
      started += 1;
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });

    const deadline = Date.now() + 2_000;
    while (!started && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(started).toBe(1);
    expect(isProviderPollDriverActive(bookId)).toBe(true);

    const stopStarted = Date.now();
    const stopping = queue.stop();
    await expect(queue.startBook(bookId)).rejects.toThrow("Book queue is stopping");
    await stopping;
    expect(Date.now() - stopStarted).toBeLessThan(1_000);
    expect(isProviderPollDriverActive(bookId)).toBe(false);

    const pending = await fs.jobs.pending.findAll();
    expect(pending.ok).toBe(true);
    if (!pending.ok) return;
    expect(pending.value.some((task) => task.artifactId === artifactId)).toBe(true);

    started = 0;
    await queue.startBook(bookId);
    await expect.poll(() => started).toBe(1);
    const stoppingBook = stopBookQueue(bookId);
    await expect(queue.startBook(bookId)).rejects.toThrow("Book queue is stopping");
    await stoppingBook;
    expect(isProviderPollDriverActive(bookId)).toBe(false);
  });

  it("restarts polling after queue.stop and can terminalize leftover work", async () => {
    const artifactId = await seedPendingTask(fs, "restart-poll-task");
    await queue.stop();
    const stillPending = await fs.jobs.pending.findAll();
    expect(stillPending.ok).toBe(true);
    if (!stillPending.ok) return;
    expect(stillPending.value).toHaveLength(1);

    await setEngineRoot(tempDir, fs);
    const aged = await pollPendingProviderTasks(fs, bookId, {
      timeoutMs: 1,
      nowMs: Date.now() + 60_000,
    });
    expect(aged.failed.some((row) => row.assetId === artifactId)).toBe(true);
    const after = await fs.jobs.pending.findAll();
    expect(after.ok).toBe(true);
    if (after.ok) expect(after.value).toEqual([]);
  });
});
