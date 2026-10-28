import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Engine } from "videobook-engine";
import { BookManager } from "../../server/src/book-manager.js";
import { cutTrending } from "../../server/src/jobs/trending-cut.js";
import { registerTrendingSampleJob, sampleTrending } from "../../server/src/jobs/trending-sample.js";
import { ensureControlBook } from "../../server/src/trending/control-book.js";
import { readLedger, readRuns } from "../../server/src/trending/ledger.js";
import { createTrendingScheduler, stopTrendingSchedulerAndQueue, trendingScheduler } from "../../server/src/trending/scheduler.js";
import { queue, setEngineRoot } from "../../server/src/queue.js";
import { trendingSources } from "../../server/src/trending/sources.js";
import { testBudget } from "../../server/src/test-budget.js";
import { schedule } from "./trending-fixtures.js";

let root: string;
let books: BookManager;
let runner: ReturnType<Engine["jobs"]["queue"]["createRunner"]>;
afterEach(async () => {
  await runner?.stop();
  await books?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

describe("trending scheduler", () => {
  it("stops an active sample by cancelling the queue before waiting for the scheduler", async () => {
    root = await mkdtemp(join(tmpdir(), "trending-shutdown-"));
    books = new BookManager({ libraryDir: root });
    const now = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();
    const control = await ensureControlBook(books, {
      ...schedule, timezone: "UTC", createdAt: now, samplesPerDay: 1440,
      cutoffLocalTime: "23:59", sources: [{ id: "waiting" }],
    });
    await setEngineRoot(control.rootDir, control.engine);
    registerTrendingSampleJob();
    let started = false;
    trendingSources.set("waiting", {
      id: "waiting", health: () => ({}),
      sample: async (_input, { signal }) => {
        started = true;
        await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        return { capturedAt: now, sightings: [] };
      },
    });
    trendingScheduler.start();
    try {
      await expect.poll(() => started, { timeout: testBudget(10_000) }).toBe(true);
      let stopped = false;
      const stopping = stopTrendingSchedulerAndQueue().then(() => { stopped = true; });
      try {
        await expect.poll(() => stopped, { timeout: testBudget(5_000) }).toBe(true);
        await stopping;
      } finally {
        await queue.stop();
        await stopping;
      }
      expect(control.engine.jobs.queue.list({ type: "trending_sample" })[0]?.state).toBe("aborted");
      expect(readLedger(control.engine, now.slice(0, 10)).completedSlots).toEqual([]);
    } finally {
      trendingSources.delete("waiting");
      await stopTrendingSchedulerAndQueue();
    }
  }, testBudget(60_000));

  it.each([
    { start: "2026-03-08T05:00:00.000Z", before: "2026-03-08T06:00:00.000Z", end: "2026-03-09T03:59:00.000Z", cutoff: "02:30", cut: "2026-03-08T07:00:00.000Z", date: "2026-03-08" },
    { start: "2026-11-01T04:00:00.000Z", before: "2026-11-01T05:00:00.000Z", end: "2026-11-02T04:59:00.000Z", cutoff: "01:30", cut: "2026-11-01T05:30:00.000Z", date: "2026-11-01" },
  ])("catches up DST day $date after restart without duplicating jobs", async ({ start, before, end, cutoff, cut, date }) => {
    root = await mkdtemp(join(tmpdir(), "trending-scheduler-"));
    books = new BookManager({ libraryDir: root });
    const control = await ensureControlBook(books, { ...schedule, timezone: "America/New_York", createdAt: start, cutoffLocalTime: cutoff, sources: [] });
    const engine = control.engine;
    let now = new Date(before);
    const enqueue = async (id: string, payload: Record<string, unknown>) => {
      const selected = books.get(String(payload.bookId));
      if (!selected.ok) throw new Error(selected.error.message);
      return selected.value.engine.jobs.queue.enqueue({ type: String(payload.type), payload, dedupeKey: id }).job;
    };
    runner = engine.jobs.queue.createRunner({ concurrency: 2, pollIntervalMs: 10, resolveHandler: (type) => async (job) => {
      if (type === "trending_sample") await sampleTrending(engine, String(job.payload.slot), new AbortController().signal);
      if (type === "trending_cut") await cutTrending(engine, books, String(job.payload.date), String(job.payload.cutAt), enqueue);
      return { success: true };
    } });
    runner.start();
    const options = {
      engines: async () => [engine], now: () => now, enqueue,
      enqueueAndWait: async <T>(id: string, payload: Record<string, unknown>): Promise<T> => {
        const job = await enqueue(id, payload);
        return await runner.waitFor(job.id, testBudget(60_000)) as T;
      },
    };
    const first = createTrendingScheduler(options);
    await first.tick();
    expect(readRuns(engine)).toHaveLength(0);
    await first.stop();
    now = new Date(end);
    const restarted = createTrendingScheduler(options);
    await Promise.all([restarted.tick(), restarted.tick()]);
    expect(readRuns(engine)).toHaveLength(1);
    expect(readRuns(engine)[0]).toMatchObject({ date, cutAt: cut, completed: true });
    expect(readLedger(engine, date).completedSlots).toHaveLength(4);
    expect(engine.jobs.queue.list({ type: "trending_sample" })).toHaveLength(4);
    expect(engine.jobs.queue.list({ type: "trending_cut" })).toHaveLength(1);
    const cutJob = engine.jobs.queue.list({ type: "trending_cut" })[0];
    expect(cutJob.payload.bookId).toBe(control.bookId);
    await restarted.tick();
    expect(engine.jobs.queue.list({ type: "trending_sample" })).toHaveLength(4);
    expect(engine.jobs.queue.list({ type: "trending_cut" })).toHaveLength(1);
    await restarted.stop();
  }, testBudget(120_000));
});
