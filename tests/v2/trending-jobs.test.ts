import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Engine } from "videobook-engine";
import { BookManager } from "../../server/src/book-manager.js";
import { enqueueOptions } from "../../server/src/queue.js";
import { runFfmpeg } from "../../server/src/ffmpeg.js";
import { cutTrending } from "../../server/src/jobs/trending-cut.js";
import { retryTrending } from "../../server/src/jobs/trending-retry.js";
import { sampleTrending } from "../../server/src/jobs/trending-sample.js";
import { ensureControlBook } from "../../server/src/trending/control-book.js";
import { localDate, readLedger, readRuns, readSchedule, readSourceHealth, updateLedger } from "../../server/src/trending/ledger.js";
import type { TrendingSource } from "../../server/src/trending/sources.js";
import { testBudget } from "../../server/src/test-budget.js";
import { cutAt, schedule, sighting } from "./trending-fixtures.js";

let root: string;
let books: BookManager;
afterEach(async () => {
  await books?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

async function setup() {
  root = await mkdtemp(join(tmpdir(), "trending-jobs-"));
  books = new BookManager({ libraryDir: root });
  return ensureControlBook(books, { ...schedule, sources: [{ id: "fixture" }, { id: "missing" }] });
}

const source: TrendingSource = {
  id: "fixture",
  async sample() {
    return { capturedAt: "2026-10-27T23:00:00.000Z", sightings: [sighting("123"), sighting("456")] };
  },
  health: () => ({}),
};

function enqueue(jobId: string, payload: Record<string, unknown>) {
  const selected = books.get(String(payload.bookId));
  if (!selected.ok) throw new Error(selected.error.message);
  return Promise.resolve(selected.value.engine.jobs.queue.enqueue(enqueueOptions(jobId, payload)).job);
}

async function seed(engine: Engine) {
  await updateLedger(engine, "2026-10-27", (ledger) => ({ ...ledger, sightings: [sighting("123"), sighting("456")] }));
}

describe("trending research jobs", () => {
  it("bootstraps the control book and deduplicates snapshots while isolating source errors", async () => {
    const control = await setup();
    expect(control.name).toBe("tiktok-th-research");
    expect(readSchedule(control.engine)?.scheduleId).toBe(schedule.scheduleId);
    const sources = new Map([[source.id, source]]);
    const signal = new AbortController().signal;
    await sampleTrending(control.engine, cutAt, signal, sources);
    await sampleTrending(control.engine, cutAt, signal, sources);
    await sampleTrending(control.engine, "2026-10-28T06:00:00.000Z", signal, sources);
    expect(readLedger(control.engine, "2026-10-28").sightings).toHaveLength(2);
    expect(readLedger(control.engine, "2026-10-28").completedSlots).toHaveLength(2);
    expect(readSourceHealth(control.engine).missing.lastError).toContain("unavailable");
    expect(readSourceHealth(control.engine).fixture.lastCapturedAt).toBe("2026-10-27T23:00:00.000Z");
  }, testBudget(60_000));

  it("cuts once, persists ranks and provenance, and downloads offline media into the day book", async () => {
    const control = await setup();
    await seed(control.engine);
    const run = (await cutTrending(control.engine, books, "2026-10-28", cutAt, enqueue))!;
    const selected = books.get(run.dayBookId);
    if (!selected.ok) throw new Error(selected.error.message);
    const day = selected.value.engine;
    expect(run.completed).toBe(true);
    expect(day.jobs.queue.list({ type: "download_video" })).toHaveLength(2);
    const notebook = day.notebooks.read(run.notebookId!);
    if (!notebook.ok) throw new Error(notebook.error.message);
    expect(notebook.value.cells.filter((cell) => cell.type === "video").every((cell) => cell.inputs?.jobId)).toBe(true);
    for (const job of day.jobs.queue.list({ type: "download_video" })) {
      expect(job.payload.bookId).toBe(run.dayBookId);
      expect(job.payload.research).toMatchObject({ country: "TH", date: run.date, scheduleId: schedule.scheduleId });
    }
    const runner = day.jobs.queue.createRunner({ concurrency: 1, pollIntervalMs: 10, resolveHandler: () => async (job) => {
      const assetId = String(job.payload.assetId);
      const artifact = day.artifacts.get(assetId);
      if (!artifact.ok) throw new Error(artifact.error.message);
      const path = join(artifact.value.path, "original.mp4");
      await runFfmpeg(["-y", "-f", "lavfi", "-i", "color=c=blue:s=64x64:d=0.1", "-c:v", "libx264", path]);
      const saved = await day.files.writeFromPath(assetId, "original.mp4", path);
      if (!saved.ok) throw new Error(saved.error.message);
      return { success: true };
    } });
    runner.start();
    try {
      for (const download of run.downloads) await runner.waitFor(download.queueJobId!, testBudget(60_000));
    } finally { await runner.stop(); }
    const repeated = await cutTrending(control.engine, books, run.date, cutAt, enqueue);
    expect(repeated).toEqual(run);
    expect(day.jobs.queue.list({ type: "download_video" })).toHaveLength(2);
    for (const download of run.downloads) {
      expect((await day.files.read(download.artifactId!, "original.mp4")).ok).toBe(true);
      const metadata = await day.metadata.artifacts.read(download.artifactId!, "original");
      expect(metadata.ok && metadata.value).toMatchObject({ research: { country: "TH", date: run.date } });
    }
    await retryTrending(control.engine, day, run.date, new Date(cutAt), enqueue);
    expect(readRuns(control.engine)[0].downloads.every((entry) => entry.status === "completed")).toBe(true);
  }, testBudget(90_000));

  it("fills from a weekly snapshot outside the normal sighting window", async () => {
    const control = await setup();
    await updateLedger(control.engine, "2026-10-22", (ledger) => ({
      ...ledger, sightings: [sighting("weekly", {
        source: "tiktok-creative-center", observedAt: "2026-10-22T00:00:00.000Z",
        createdAt: "2026-10-20T00:00:00.000Z",
      })],
    }));
    const run = (await cutTrending(control.engine, books, "2026-10-28", cutAt, enqueue))!;
    expect(run.videos).toHaveLength(1);
    expect(run.videos[0]).toMatchObject({ videoId: "weekly", fallback: true });
  }, testBudget(60_000));

  it("resumes an interrupted cut without duplicating artifacts or completed downloads", async () => {
    const control = await setup();
    await seed(control.engine);
    let count = 0;
    const interrupted = async (id: string, payload: Record<string, unknown>) => {
      if (++count === 2) throw new Error("Interrupted enqueue");
      return enqueue(id, payload);
    };
    await expect(cutTrending(control.engine, books, "2026-10-28", cutAt, interrupted)).rejects.toThrow("Interrupted");
    const before = readRuns(control.engine)[0];
    const selected = books.get(before.dayBookId);
    if (!selected.ok) throw new Error(selected.error.message);
    const day = selected.value.engine;
    const first = day.jobs.queue.dequeue(process.pid, testBudget(60_000))!;
    await day.jobs.queue.complete(first.id);
    const resumed = (await cutTrending(control.engine, books, before.date, cutAt, enqueue))!;
    expect(resumed.downloads.map((download) => download.artifactId)).toEqual(before.downloads.map((download) => download.artifactId));
    expect(day.jobs.queue.list({ type: "download_video" })).toHaveLength(2);
  }, testBudget(60_000));

  it("backs off failed downloads, preserves reasons and ranks, and stops at three attempts", async () => {
    const control = await setup();
    await seed(control.engine);
    const run = (await cutTrending(control.engine, books, localDate(new Date(), schedule.timezone), cutAt, enqueue))!;
    const selected = books.get(run.dayBookId);
    if (!selected.ok) throw new Error(selected.error.message);
    const day = selected.value.engine;
    const now = new Date();
    const originalDate = run.date;
    for (let attempt = 1; attempt <= 3; attempt++) {
      let job = day.jobs.queue.dequeue(process.pid, testBudget(60_000));
      while (job) {
        await day.jobs.queue.fail(job.id, { error: { message: `failure ${attempt}` }, allowRetry: false });
        job = day.jobs.queue.dequeue(process.pid, testBudget(60_000));
      }
      const failedAt = day.jobs.queue.get(readRuns(control.engine)[0].downloads[0].queueJobId!)!.finishedAt!;
      now.setTime(failedAt);
      await retryTrending(control.engine, day, originalDate, now, enqueue);
      expect(day.jobs.queue.list({ states: ["queued"] })).toHaveLength(0);
      now.setTime(failedAt + 600_000);
      await retryTrending(control.engine, day, originalDate, now, enqueue);
      if (attempt < 3) expect(day.jobs.queue.list({ states: ["queued"] })).toHaveLength(2);
    }
    expect(day.jobs.queue.list({ type: "download_video" })).toHaveLength(6);
    expect(readRuns(control.engine)[0].downloads).toEqual(expect.arrayContaining([expect.objectContaining({ attempts: 3, error: "failure 3", status: "failed" })]));
  }, testBudget(60_000));
});
