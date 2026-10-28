import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BookManager, type ManagedBook } from "../../server/src/book-manager.js";
import { enqueueOptions } from "../../server/src/queue.js";
import { cutTrending } from "../../server/src/jobs/trending-cut.js";
import { retainTrending, type ArchiveResearchClip } from "../../server/src/jobs/trending-retention.js";
import { trendingResearchDef } from "../../server/src/tools/trending-research.js";
import { ensureControlBook } from "../../server/src/trending/control-book.js";
import {
  localDate, readHistory, readRetention, readRuns, readSchedule, updateLedger, writeHistory, writeRetention, writeRun,
} from "../../server/src/trending/ledger.js";
import { createTrendingScheduler } from "../../server/src/trending/scheduler.js";
import type { TrendingSchedule } from "../../server/src/trending/types.js";
import { testBudget } from "../../server/src/test-budget.js";
import { schedule, sighting } from "./trending-fixtures.js";

let root: string;
let books: BookManager;
afterEach(async () => {
  await books?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

async function setup(patch: Partial<TrendingSchedule> = {}): Promise<ManagedBook> {
  root = await mkdtemp(join(tmpdir(), "trending-retention-"));
  books = new BookManager({ libraryDir: root });
  return ensureControlBook(books, { ...schedule, ...patch });
}

function enqueue(jobId: string, payload: Record<string, unknown>) {
  const selected = books.get(String(payload.bookId));
  if (!selected.ok) throw new Error(selected.error.message);
  return Promise.resolve(selected.value.engine.jobs.queue.enqueue(enqueueOptions(jobId, payload)).job);
}

async function cutDay(control: ManagedBook, date: string, videoIds: string[]) {
  const cutAt = `${date}T00:00:00.000Z`;
  const observedAt = new Date(Date.parse(cutAt) - 12 * 3_600_000).toISOString();
  await updateLedger(control.engine, localDate(observedAt, schedule.timezone), (ledger) => ({
    ...ledger, sightings: [...ledger.sightings, ...videoIds.map((videoId) => sighting(videoId, { observedAt }))],
  }));
  const run = (await cutTrending(control.engine, books, date, cutAt, enqueue))!;
  const day = books.get(run.dayBookId);
  if (!day.ok) throw new Error(day.error.message);
  return { run, day: day.value };
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

describe("trending day-book retention", () => {
  it("deletes expired day books after summarizing them and keeps newer, control and untracked books", async () => {
    const control = await setup();
    const expired = await cutDay(control, "2026-09-20", ["old-a", "old-b"]);
    const pendingExpired = await cutDay(control, "2026-09-24", ["old-c"]);
    const boundary = await cutDay(control, "2026-09-28", ["edge"]);
    const recent = await cutDay(control, "2026-10-27", ["new"]);
    const untracked = await books.create("tiktok-th-2026-09-01");
    if (!untracked.ok) throw new Error(untracked.error.message);
    const queue = expired.day.engine.jobs.queue;
    const finished = queue.dequeue(process.pid, testBudget(60_000))!;
    await queue.complete(finished.id);
    const failed = queue.dequeue(process.pid, testBudget(60_000))!;
    await queue.fail(failed.id, { error: { message: "blocked by TikTok" }, allowRetry: false });

    const state = await retainTrending(control.engine, books, "2026-10-28");

    expect(state).toMatchObject({ lastDate: "2026-10-28", errors: [] });
    expect(state?.deleted.map((entry) => entry.name)).toEqual(["tiktok-th-2026-09-20", "tiktok-th-2026-09-24"]);
    for (const { day } of [expired, pendingExpired]) {
      expect(books.get(day.bookId).ok).toBe(false);
      expect(await exists(day.rootDir)).toBe(false);
    }
    for (const book of [boundary.day, recent.day, control]) {
      expect(books.get(book.bookId).ok).toBe(true);
      expect(await exists(book.rootDir)).toBe(true);
    }
    expect(books.getByName("tiktok-th-2026-09-01").ok).toBe(true);
    expect(readRuns(control.engine).map((run) => run.date)).toEqual(["2026-09-28", "2026-10-27"]);
    const history = readHistory(control.engine);
    expect(history.map((entry) => [entry.date, entry.dayBookName, entry.dayBookId])).toEqual([
      ["2026-09-20", "tiktok-th-2026-09-20", expired.day.bookId],
      ["2026-09-24", "tiktok-th-2026-09-24", pendingExpired.day.bookId],
    ]);
    expect(history.every((entry) => Date.parse(entry.deletedAt!) >= Date.parse(entry.retainedAt))).toBe(true);
    expect(history[0].videos.map((video) => [video.rank, video.videoId, video.sources])).toEqual([
      [1, "old-a", ["endless"]], [2, "old-b", ["endless"]],
    ]);
    const outcome = (jobId: number) => history[0].downloads.find((download) => download.queueJobId === jobId);
    expect(outcome(finished.id)).toMatchObject({ status: "completed" });
    expect(outcome(failed.id)).toMatchObject({ status: "failed", error: "blocked by TikTok" });
    expect(history[1].downloads).toEqual([expect.objectContaining({ videoId: "old-c", status: "pending" })]);
    expect(readRetention(control.engine)).toEqual(state);

    const rerun = await retainTrending(control.engine, books, "2026-10-28");
    expect(rerun).toMatchObject({ lastDate: "2026-10-28", deleted: [], errors: [] });
    expect(readHistory(control.engine)).toEqual(history);
    expect(readRuns(control.engine).map((run) => run.date)).toEqual(["2026-09-28", "2026-10-27"]);
  }, testBudget(90_000));

  it("keeps a renamed day book and finishes day books that are already gone", async () => {
    const control = await setup();
    const renamed = await cutDay(control, "2026-09-10", ["renamed"]);
    const interrupted = await cutDay(control, "2026-09-15", ["interrupted"]);
    const gone = await cutDay(control, "2026-09-20", ["gone"]);
    expect((await books.rename(renamed.day.bookId, "my-research-copy")).ok).toBe(true);
    await writeHistory(control.engine, {
      ...interrupted.run, dayBookName: interrupted.day.name, retainedAt: "2026-10-28T00:00:00.000Z",
      downloads: interrupted.run.downloads.map((download) => ({ ...download, status: "completed" })),
    });
    for (const { day } of [interrupted, gone]) {
      expect((await books.delete(day.bookId, { confirmName: day.name })).ok).toBe(true);
    }

    const state = await retainTrending(control.engine, books, "2026-10-28");

    expect(state?.deleted).toEqual([]);
    expect(state?.errors).toEqual(["2026-09-10: Kept book my-research-copy: it is not the tiktok-th-2026-09-10 day book"]);
    expect(books.get(renamed.day.bookId).ok).toBe(true);
    expect(readRuns(control.engine).map((run) => run.date)).toEqual(["2026-09-10"]);
    expect(readHistory(control.engine)).toEqual([
      expect.objectContaining({
        date: "2026-09-15", dayBookId: interrupted.day.bookId, retainedAt: "2026-10-28T00:00:00.000Z",
        deletedAt: expect.any(String), downloads: [expect.objectContaining({ status: "completed" })],
      }),
      expect.objectContaining({ date: "2026-09-20", dayBookId: gone.day.bookId, deletedAt: expect.any(String) }),
    ]);
  }, testBudget(90_000));

  it("deletes nothing when the retention window is invalid", async () => {
    const control = await setup({ retentionDays: 0 });
    const kept = await cutDay(control, "2026-01-01", ["kept"]);
    const refused = await retainTrending(control.engine, books, "2026-10-28");
    expect(refused).toMatchObject({ deleted: [], errors: ["Invalid retention window: 0 days"] });
    expect(books.get(kept.day.bookId).ok).toBe(true);
    expect(readRuns(control.engine).map((run) => run.date)).toEqual(["2026-01-01"]);
  }, testBudget(60_000));

  it("archives completed ranked clips before deleting and keeps the book when archiving fails", async () => {
    const control = await setup({ archiveTopClips: true });
    const { run, day } = await cutDay(control, "2026-09-26", ["clip-a", "clip-b"]);
    const finished = day.engine.jobs.queue.dequeue(process.pid, testBudget(60_000))!;
    await day.engine.jobs.queue.complete(finished.id);
    const completed = run.downloads.find((download) => download.queueJobId === finished.id)!;
    const calls: string[] = [];
    let offline = true;
    const archive: ArchiveResearchClip = async ({ day: book, download }) => {
      calls.push(`${book.bookId}:${download.artifactId}`);
      if (offline) throw new Error("archive offline");
    };

    const failedRun = await retainTrending(control.engine, books, "2026-10-28", archive);
    expect(failedRun?.errors).toEqual(["2026-09-26: archive offline"]);
    expect(books.get(day.bookId).ok).toBe(true);
    expect(readRuns(control.engine)[0].downloads.every((download) => !download.archivedAt)).toBe(true);

    offline = false;
    const archivedRun = await retainTrending(control.engine, books, "2026-10-28", archive);
    expect(archivedRun).toMatchObject({ errors: [], deleted: [{ date: "2026-09-26", name: "tiktok-th-2026-09-26" }] });
    expect(calls).toEqual([`${day.bookId}:${completed.artifactId}`, `${day.bookId}:${completed.artifactId}`]);
    expect(books.get(day.bookId).ok).toBe(false);
    const [entry] = readHistory(control.engine);
    expect(entry.downloads.find((download) => download.queueJobId === finished.id)?.archivedAt).toEqual(expect.any(String));
    expect(entry.downloads.find((download) => download.queueJobId !== finished.id)).toMatchObject({ status: "pending" });
    expect(entry.downloads.find((download) => download.queueJobId !== finished.id)?.archivedAt).toBeUndefined();

    await retainTrending(control.engine, books, "2026-10-28", archive);
    expect(calls).toHaveLength(2);
  }, testBudget(90_000));

  it("schedules retention once per cutoff date and stops retrying expired runs", async () => {
    const control = await setup({ createdAt: "2026-10-27T23:00:00.000Z" });
    const recent = await books.create("tiktok-th-2026-10-27");
    if (!recent.ok) throw new Error(recent.error.message);
    const pendingDownload = { videoId: "v", status: "pending" as const };
    await writeRun(control.engine, { date: "2026-09-01", cutAt: "2026-09-01T00:00:00.000Z", dayBookId: "expired-book", videos: [], downloads: [pendingDownload], completed: true, spend: 0, errors: [] });
    await writeRun(control.engine, { date: "2026-10-27", cutAt: "2026-10-27T00:00:00.000Z", dayBookId: recent.value.bookId, videos: [], downloads: [pendingDownload], completed: true, spend: 0, errors: [] });
    let now = new Date("2026-10-28T00:05:00.000Z");
    const enqueued: { id: string; payload: Record<string, unknown> }[] = [];
    const options = {
      engines: async () => [control.engine],
      now: () => now,
      enqueue: async (id: string, payload: Record<string, unknown>) => {
        enqueued.push({ id, payload });
        const selected = books.get(String(payload.bookId));
        if (!selected.ok) throw new Error(selected.error.message);
        return selected.value.engine.jobs.queue.enqueue({ type: String(payload.type), payload, dedupeKey: id }).job;
      },
      enqueueAndWait: async <T>(): Promise<T> => undefined as T,
    };
    const scheduler = createTrendingScheduler(options);
    await scheduler.tick();
    await scheduler.tick();
    const retention = enqueued.filter((entry) => entry.payload.type === "trending_retention");
    expect(retention).toEqual([{
      id: "trending-retention:th-daily:2026-10-28",
      payload: { type: "trending_retention", bookId: control.bookId, date: "2026-10-28" },
    }]);
    const retries = enqueued.filter((entry) => entry.payload.type === "trending_retry").map((entry) => entry.payload.date);
    expect(retries.length).toBeGreaterThan(0);
    expect(new Set(retries)).toEqual(new Set(["2026-10-27"]));

    await writeRetention(control.engine, { lastDate: "2026-10-29", lastRunAt: "2026-10-29T00:01:00.000Z", deleted: [], errors: [] });
    now = new Date("2026-10-29T00:05:00.000Z");
    await createTrendingScheduler(options).tick();
    now = new Date("2026-10-30T00:05:00.000Z");
    await createTrendingScheduler(options).tick();
    expect(enqueued.filter((entry) => entry.payload.type === "trending_retention").map((entry) => entry.id)).toEqual([
      "trending-retention:th-daily:2026-10-28", "trending-retention:th-daily:2026-10-30",
    ]);
    await scheduler.stop();
  }, testBudget(60_000));

  it("reports retention through trending_research status and stores archive_top_clips", async () => {
    root = await mkdtemp(join(tmpdir(), "trending-retention-tool-"));
    books = new BookManager({ libraryDir: root });
    const tool = trendingResearchDef(books, { now: () => new Date("2026-10-28T03:00:00.000Z"), enqueue });
    expect((await tool.handler({ op: "schedule", country: "TH", retention_days: 7, archive_top_clips: true })).isError).toBeUndefined();
    const selected = books.getByName("tiktok-th-research");
    if (!selected.ok) throw new Error(selected.error.message);
    const control = selected.value;
    expect(readSchedule(control.engine)).toMatchObject({ retentionDays: 7, archiveTopClips: true });
    const status = async () => JSON.parse((await tool.handler({ op: "status", country: "TH" })).content[0].text).schedules[0];
    expect((await status()).retention).toEqual({
      days: 7, archiveTopClips: true, nextRun: "2026-10-28T17:30:00.000Z", lastRun: null, recentDeletions: [],
    });

    const { day } = await cutDay(control, "2026-10-01", ["listed"]);
    await retainTrending(control.engine, books, "2026-10-28", async () => {});

    expect((await status()).retention).toEqual({
      days: 7, archiveTopClips: true, nextRun: "2026-10-28T17:30:00.000Z",
      lastRun: {
        lastDate: "2026-10-28", lastRunAt: expect.any(String), errors: [],
        deleted: [{ date: "2026-10-01", bookId: day.bookId, name: "tiktok-th-2026-10-01" }],
      },
      recentDeletions: [{ date: "2026-10-01", dayBookId: day.bookId, dayBookName: "tiktok-th-2026-10-01", deletedAt: expect.any(String) }],
    });
  }, testBudget(60_000));
});
