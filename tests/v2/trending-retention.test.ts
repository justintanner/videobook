import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UsageInput } from "videobook-engine";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chunkKey, indexKey, transcriptJsonKey, transcriptTextKey, type ArchiveIndex } from "../../server/src/archive-b2.js";
import { getArchiveStore } from "../../server/src/archive-store.js";
import { scopedBookEngine } from "../../server/src/book-context.js";
import { BookManager, type ManagedBook } from "../../server/src/book-manager.js";
import { runFfmpeg } from "../../server/src/ffmpeg.js";
import { configureProviderEndpoints } from "../../server/src/media/endpoints.js";
import { enqueueOptions, setEngineRoot } from "../../server/src/queue.js";
import { registerArchiveClipJob } from "../../server/src/jobs/archive-clip.js";
import { cutTrending } from "../../server/src/jobs/trending-cut.js";
import { retainTrending, type ArchiveResearchClip } from "../../server/src/jobs/trending-retention.js";
import { bookUsageDef } from "../../server/src/tools/book-usage.js";
import { trendingResearchDef } from "../../server/src/tools/trending-research.js";
import { ensureControlBook } from "../../server/src/trending/control-book.js";
import {
  localDate, pruneLedgers, readHistory, readRetention, readRuns, readSchedule, updateLedger, writeHistory, writeRetention,
  writeRun, writeSchedule,
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
    expect(refused).toMatchObject({ deleted: [], prunedLedgers: [], errors: ["Invalid retention window: 0 days"] });
    expect(books.get(kept.day.bookId).ok).toBe(true);
    expect(readRuns(control.engine).map((run) => run.date)).toEqual(["2026-01-01"]);
    expect(control.engine.settings.get("trending.ledger.2025-12-31")).not.toBeNull();
  }, testBudget(60_000));

  it("prunes sighting ledgers older than the retention window and keeps every date the day's cut reads", async () => {
    const control = await setup();
    const dates = ["2026-09-01", "2026-09-27", "2026-09-28", "2026-10-19", "2026-10-20", "2026-10-27"];
    for (const date of dates) {
      const observedAt = `${date}T05:00:00.000Z`;
      await updateLedger(control.engine, date, (ledger) => ({
        ...ledger, sightings: [sighting(`cc-${date}`, { source: "tiktok-creative-center", observedAt, createdAt: observedAt })],
      }));
    }
    const stored = () => dates.filter((date) => control.engine.settings.get(`trending.ledger.${date}`) !== null);

    const state = await retainTrending(control.engine, books, "2026-10-28");
    expect(state).toMatchObject({ prunedLedgers: ["2026-09-01", "2026-09-27"], errors: [] });
    expect(stored()).toEqual(["2026-09-28", "2026-10-19", "2026-10-20", "2026-10-27"]);
    expect(readRetention(control.engine)).toEqual(state);
    expect((await retainTrending(control.engine, books, "2026-10-28"))?.prunedLedgers).toEqual([]);
    expect(stored()).toEqual(["2026-09-28", "2026-10-19", "2026-10-20", "2026-10-27"]);

    await writeSchedule(control.engine, { ...readSchedule(control.engine)!, retentionDays: 1 });
    expect((await retainTrending(control.engine, books, "2026-10-28"))?.prunedLedgers).toEqual(["2026-09-28", "2026-10-19"]);
    expect(stored()).toEqual(["2026-10-20", "2026-10-27"]);
    const run = (await cutTrending(control.engine, books, "2026-10-28", "2026-10-28T00:00:00.000Z", enqueue))!;
    expect(run.videos.map((video) => [video.videoId, video.fallback])).toEqual([["cc-2026-10-27", false], ["cc-2026-10-20", true]]);
  }, testBudget(90_000));

  it("prunes ledgers only after the ledger writes queued before it", async () => {
    const control = await setup();
    const expired = updateLedger(control.engine, "2026-09-01", (ledger) => ({ ...ledger, completedSlots: ["2026-09-01T00:00:00.000Z"] }));
    const pruned = pruneLedgers(control.engine, "2026-09-28");
    const kept = updateLedger(control.engine, "2026-09-28", (ledger) => ledger);
    await Promise.all([expired, kept]);
    expect(await pruned).toEqual(["2026-09-01"]);
    expect(control.engine.settings.get("trending.ledger.2026-09-01")).toBeNull();
    expect(control.engine.settings.get("trending.ledger.2026-09-28")).not.toBeNull();
    expect(await pruneLedgers(control.engine, "2026-09-28")).toEqual([]);
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

  it("copies the day book's archive usage into the control book and counts only completed cost as history spend", async () => {
    const control = await setup({ archiveTopClips: true });
    const { run, day } = await cutDay(control, "2026-09-26", ["clip"]);
    const finished = day.engine.jobs.queue.dequeue(process.pid, testBudget(60_000))!;
    await day.engine.jobs.queue.complete(finished.id);
    const request = { provider: "elevenlabs", model: "scribe_v2", activity: "analysis", operation: "archive_clip", artifactId: run.downloads[0].artifactId! } as const;
    const rows: UsageInput[] = [
      { ...request, id: "archive-completed", status: "completed", basis: "estimated", costUsd: 0.0123, units: 41, unit: "second" },
      { ...request, id: "archive-pending", status: "pending", basis: "estimated", costUsd: 0.5 },
      { ...request, id: "archive-failed", status: "failed", basis: "unknown" },
      { ...request, id: "other-operation", operation: "tag_asset", status: "completed", basis: "estimated", costUsd: 0.2 },
    ];
    const archive: ArchiveResearchClip = async ({ day: book }) => {
      for (const row of rows) {
        const recorded = book.engine.usage.record(row);
        if (!recorded.ok) throw new Error(recorded.error.message);
      }
    };

    expect(await retainTrending(control.engine, books, "2026-10-28", archive)).toMatchObject({
      errors: [], deleted: [{ date: "2026-09-26", bookId: day.bookId }],
    });

    expect(books.get(day.bookId).ok).toBe(false);
    const kept = control.engine.usage.recent().sort((left, right) => left.id.localeCompare(right.id));
    expect(kept).toEqual([
      expect.objectContaining({ id: "archive-completed", status: "completed", basis: "estimated", costUsd: 0.0123, units: 41, unit: "second" }),
      expect.objectContaining({ id: "archive-failed", status: "failed", basis: "unknown", costUsd: null }),
      expect.objectContaining({ id: "archive-pending", status: "pending", basis: "estimated", costUsd: 0.5 }),
    ]);
    expect(kept.every((row) => row.provider === "elevenlabs" && row.model === "scribe_v2" && row.activity === "analysis"
      && row.operation === "archive_clip" && row.artifactId === null)).toBe(true);
    const usage = JSON.parse((await bookUsageDef(control.engine).handler({ book_id: control.bookId })).content[0]!.text);
    expect(usage.totals).toMatchObject({ count: 3, estimatedUsd: 0.0123, reportedUsd: 0, pendingCount: 1, pendingUsd: 0.5, unpriced: 1 });
    const [entry] = readHistory(control.engine);
    expect(entry).toMatchObject({ date: "2026-09-26", dayBookId: day.bookId, deletedAt: expect.any(String), spend: 0.0123 });
    expect(entry.spend).toBe(usage.totals.estimatedUsd + usage.totals.reportedUsd);
  }, testBudget(60_000));

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

    await writeRetention(control.engine, { lastDate: "2026-10-29", lastRunAt: "2026-10-29T00:01:00.000Z", deleted: [], prunedLedgers: [], errors: [] });
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
        deleted: [{ date: "2026-10-01", bookId: day.bookId, name: "tiktok-th-2026-10-01" }], prunedLedgers: ["2026-09-30"],
      },
      recentDeletions: [{ date: "2026-10-01", dayBookId: day.bookId, dayBookName: "tiktok-th-2026-10-01", deletedAt: expect.any(String), spend: 0 }],
    });
  }, testBudget(60_000));

  describe("through the real archive_clip job", () => {
    const speech = {
      language_code: "eng", language_probability: 0.98, text: "Hello there (laughter)", channel_index: 0,
      transcription_id: "stub-transcription", audio_duration_secs: 1,
      words: [
        { text: "Hello", start: 0.1, end: 0.4, type: "word", speaker_id: "speaker_0" },
        { text: " ", start: 0.4, end: 0.45, type: "spacing", speaker_id: "speaker_0" },
        { text: "there", start: 0.45, end: 0.7, type: "word", speaker_id: "speaker_0" },
        { text: " ", start: 0.7, end: 0.75, type: "spacing", speaker_id: "speaker_1" },
        { text: "(laughter)", start: 0.75, end: 1, type: "audio_event", speaker_id: "speaker_1" },
      ],
    };
    let requests: { method: string; url: string; contentType: string; body: Buffer }[];
    let scratch: string;
    let restoreEndpoints: () => void;
    const stub = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requests.push({
          method: request.method ?? "", url: request.url ?? "", contentType: String(request.headers["content-type"] ?? ""),
          body: Buffer.concat(chunks),
        });
        if (request.url !== "/v1/speech-to-text") {
          response.statusCode = 404;
          response.end();
          return;
        }
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(speech));
      });
    });

    beforeAll(() => new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve)));
    afterAll(() => new Promise<void>((resolve) => stub.close(() => resolve())));
    beforeEach(async () => {
      requests = [];
      scratch = await mkdtemp(join(tmpdir(), "trending-archive-"));
      vi.stubEnv("ELEVENLABS_API_KEY", "offline-elevenlabs-key");
      vi.stubEnv("VIDEOBOOK_ARCHIVE_DIR", join(scratch, "archive"));
      restoreEndpoints = configureProviderEndpoints({
        elevenlabsBaseURL: `http://127.0.0.1:${(stub.address() as AddressInfo).port}`,
      });
    });
    afterEach(async () => {
      restoreEndpoints();
      vi.unstubAllEnvs();
      await rm(scratch, { recursive: true, force: true });
    });

    async function archiveClip(input: string[]) {
      const control = await setup({ archiveTopClips: true });
      const { run, day } = await cutDay(control, "2026-09-26", ["clip"]);
      const [download] = run.downloads;
      const media = join(scratch, "clip.mp4");
      await runFfmpeg(["-y", ...input, media]);
      const saved = await day.engine.files.writeFromPath(download.artifactId!, "original.mp4", media);
      if (!saved.ok) throw new Error(saved.error.message);
      const job = day.engine.jobs.queue.dequeue(process.pid, testBudget(60_000))!;
      await day.engine.jobs.queue.complete(job.id);
      await setEngineRoot(day.rootDir, day.engine);
      registerArchiveClipJob(scopedBookEngine);

      expect(await retainTrending(control.engine, books, "2026-10-28")).toMatchObject({
        errors: [], deleted: [{ date: "2026-09-26", bookId: day.bookId, name: "tiktok-th-2026-09-26" }],
      });
      expect(books.get(day.bookId).ok).toBe(false);
      expect(await exists(day.rootDir)).toBe(false);
      expect(readHistory(control.engine)[0].downloads[0]).toMatchObject({ status: "completed", archivedAt: expect.any(String) });
      const store = getArchiveStore();
      const bytes = await readFile(media);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const index = (await store.getJson<ArchiveIndex>(indexKey(store, sha256)))!;
      expect(store.kind).toBe("local");
      expect(index).toMatchObject({
        title: "TikTok TH 2026-09-26 #1 author", people: [], ingests: [expect.any(String)],
        topics: [{ label: "tiktok-th-trending", source: "manual" }],
        sources: [{ kind: "asset", book_id: day.bookId, asset_id: download.artifactId }],
      });
      expect(Buffer.from((await store.getBytes(index.media.key))!)).toEqual(bytes);
      return { control, store, sha256, index };
    }

    it("archives a completed silent clip into the local archive without transcribing it, then deletes the day book", async () => {
      const { index } = await archiveClip(["-f", "lavfi", "-i", "color=c=blue:s=64x64:d=0.1", "-c:v", "libx264"]);
      expect(index.transcript).toMatchObject({ chunk_count: 0 });
      expect(requests).toEqual([]);
    }, testBudget(90_000));

    it("transcribes a clip with audio through the ElevenLabs endpoint override with the archiver's settings", async () => {
      const { control, store, sha256, index } = await archiveClip([
        "-f", "lavfi", "-i", "color=c=blue:s=64x64:d=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
        "-c:v", "libx264", "-c:a", "aac", "-shortest",
      ]);

      expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual(["POST /v1/speech-to-text"]);
      const form = await new Response(new Uint8Array(requests[0].body), { headers: { "content-type": requests[0].contentType } }).formData();
      expect(Object.fromEntries([...form].filter(([, value]) => typeof value === "string"))).toEqual({
        model_id: "scribe_v2", tag_audio_events: "true", diarize: "true",
      });
      const file = form.get("file") as File;
      expect(file.type).toBe("audio/mpeg");
      expect(file.size).toBeGreaterThan(0);
      expect(index.transcript).toEqual({
        json_key: transcriptJsonKey(store, sha256), text_key: transcriptTextKey(store, sha256), chunk_count: 1, provider: "elevenlabs",
      });
      expect(index.duration).toBeGreaterThan(0);
      expect(await store.getJson(chunkKey(store, sha256, 0))).toEqual(speech);
      expect(await store.getJson(transcriptJsonKey(store, sha256))).toEqual({
        ...speech, transcription_id: null, audio_duration_secs: index.duration,
      });
      expect(await store.getText(transcriptTextKey(store, sha256))).toBe(speech.text);

      const usage = JSON.parse((await bookUsageDef(control.engine).handler({ book_id: control.bookId })).content[0]!.text);
      expect(usage.recent).toEqual([expect.objectContaining({
        provider: "elevenlabs", model: "scribe_v2", activity: "analysis", status: "completed", operation: "archive_clip", artifactId: null,
      })]);
      expect(usage.groups).toEqual([expect.objectContaining({ activity: "analysis", provider: "elevenlabs", model: "scribe_v2", count: 1 })]);
      expect(readHistory(control.engine)[0].spend).toBe(usage.totals.estimatedUsd + usage.totals.reportedUsd);
    }, testBudget(90_000));
  });
});
