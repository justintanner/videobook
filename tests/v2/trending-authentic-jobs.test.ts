import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Engine } from "videobook-engine";
import { BookManager } from "../../server/src/book-manager.js";
import { cutTrending } from "../../server/src/jobs/trending-cut.js";
import { enqueueOptions } from "../../server/src/queue.js";
import { testBudget } from "../../server/src/test-budget.js";
import { ensureControlBook } from "../../server/src/trending/control-book.js";
import { readRuns, updateLedger, writeHistory } from "../../server/src/trending/ledger.js";
import type { Sighting, TrendingRunRecord, TrendingSchedule } from "../../server/src/trending/types.js";
import { cutAt, schedule, sighting } from "./trending-fixtures.js";

let root: string;
let books: BookManager;

afterEach(async () => {
  await books?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

const authenticSchedule: TrendingSchedule = {
  ...schedule,
  ranking: "authentic",
  sources: [{ id: "endless" }, { id: "omkar" }, { id: "tiktok-creative-center" }],
};

async function setup(override: Partial<TrendingSchedule> = {}) {
  root = await mkdtemp(join(tmpdir(), "trending-authentic-jobs-"));
  books = new BookManager({ libraryDir: root });
  return ensureControlBook(books, { ...authenticSchedule, ...override });
}

function enqueue(jobId: string, payload: Record<string, unknown>) {
  const selected = books.get(String(payload.bookId));
  if (!selected.ok) throw new Error(selected.error.message);
  return Promise.resolve(selected.value.engine.jobs.queue.enqueue(enqueueOptions(jobId, payload)).job);
}

function dayEngine(run: TrendingRunRecord): Engine {
  const selected = books.get(run.dayBookId);
  if (!selected.ok) throw new Error(selected.error.message);
  return selected.value.engine;
}

function authenticSighting(videoId: string, patch: Partial<Sighting> = {}): Sighting {
  return sighting(videoId, {
    originRegion: "TH",
    durationSeconds: 18,
    kind: "video",
    aiGenerated: false,
    isAd: false,
    coverUrl: `https://cdn.example/${videoId}.webp`,
    metrics: { views: 500_000, likes: 50_000, shares: 10_000, saves: 2_000, comments: 250 },
    ...patch,
  });
}

describe("authentic trending research cut jobs", () => {
  it("ranks by organic score, builds the day book, enqueues downloads, records ranking and funnel, and strips coverUrl", async () => {
    const control = await setup();
    await updateLedger(control.engine, "2026-10-27", (ledger) => ({
      ...ledger,
      sightings: [
        authenticSighting("high-views-modest", {
          metrics: { views: 2_000_000, likes: 20_000, shares: 1_000, saves: 200, comments: 50 },
          createdAt: "2026-10-20T00:00:00.000Z",
        }),
        authenticSighting("organic-winner", {
          metrics: { views: 600_000, likes: 90_000, shares: 24_000, saves: 4_800, comments: 600 },
          createdAt: "2026-10-27T00:00:00.000Z",
        }),
        authenticSighting("paid-ad", {
          metrics: { views: 80_000_000, likes: 40_000 },
        }),
        authenticSighting("stale-clip", {
          createdAt: "2026-08-01T00:00:00.000Z",
        }),
        authenticSighting("cc-fallback", {
          source: "tiktok-creative-center",
          metrics: { views: 9_000_000, likes: 0 },
        }),
      ],
    }));

    const run = (await cutTrending(control.engine, books, "2026-10-28", cutAt, enqueue))!;
    expect(run.completed).toBe(true);
    expect(run.ranking).toBe("authentic");
    expect(run.funnel).toEqual({
      seen: 4,
      screened: { "paid-reach": 1, stale: 1 },
      candidates: 2,
      checked: 0,
      fit: 0,
    });
    expect(run.videos.map((video) => video.videoId)).toEqual(["organic-winner", "high-views-modest"]);
    expect(run.videos.map((video) => video.rank)).toEqual([1, 2]);
    expect(run.videos.every((video) => video.fallback === false)).toBe(true);
    expect(run.videos.every((video) => !("coverUrl" in video))).toBe(true);
    expect(run.videos[0].authentic?.score).toBe(run.videos[0].authentic?.organic);
    expect(run.videos[0].authentic?.score).toBeGreaterThan(run.videos[1].authentic!.score);

    const day = dayEngine(run);
    expect(day.jobs.queue.list({ type: "download_video" })).toHaveLength(2);
    const notebook = day.notebooks.read(run.notebookId!);
    if (!notebook.ok) throw new Error(notebook.error.message);
    expect(notebook.value.cells.filter((cell) => cell.type === "video")).toHaveLength(2);
    expect(notebook.value.cells.find((cell) => cell.inputs?.workflowRole === "trending-summary")).toBeTruthy();

    const persisted = readRuns(control.engine).find((entry) => entry.date === "2026-10-28");
    expect(persisted?.ranking).toBe("authentic");
    expect(persisted?.funnel).toEqual(run.funnel);
    expect(persisted?.videos.every((video) => !("coverUrl" in video))).toBe(true);
  }, testBudget(60_000));

  it("excludes videos already ranked in earlier runs or present in history entries", async () => {
    const control = await setup();
    await updateLedger(control.engine, "2026-10-27", (ledger) => ({
      ...ledger,
      sightings: [
        authenticSighting("from-day-1", { observedAt: "2026-10-27T12:00:00.000Z" }),
        authenticSighting("from-history", { observedAt: "2026-10-27T12:00:00.000Z" }),
        authenticSighting("fresh-day-2", {
          observedAt: "2026-10-27T12:00:00.000Z",
          metrics: { views: 300_000, likes: 30_000, shares: 5_000, saves: 1_000, comments: 150 },
        }),
      ],
    }));

    const day1 = (await cutTrending(control.engine, books, "2026-10-28", cutAt, enqueue))!;
    expect(day1.videos.map((video) => video.videoId)).toContain("from-day-1");

    await writeHistory(control.engine, {
      date: "2026-10-15",
      cutAt: "2026-10-15T00:00:00.000Z",
      ranking: "authentic",
      dayBookId: "old-day-book",
      dayBookName: "tiktok-th-2026-10-15",
      retainedAt: "2026-10-20T00:00:00.000Z",
      videos: [{
        ...authenticSighting("from-history"),
        rank: 1,
        sources: ["endless"],
        fallback: false,
      }],
      downloads: [],
      spend: 0,
      errors: [],
    });

    const day2CutAt = "2026-10-29T00:00:00.000Z";
    await updateLedger(control.engine, "2026-10-28", (ledger) => ({
      ...ledger,
      sightings: [
        authenticSighting("from-day-1", { observedAt: "2026-10-28T12:00:00.000Z" }),
        authenticSighting("from-history", { observedAt: "2026-10-28T12:00:00.000Z" }),
        authenticSighting("brand-new", { observedAt: "2026-10-28T12:00:00.000Z" }),
      ],
    }));

    const day2 = (await cutTrending(control.engine, books, "2026-10-29", day2CutAt, enqueue))!;
    expect(day2.videos.map((video) => video.videoId)).toEqual(["brand-new"]);
    expect(day2.funnel).toEqual({
      seen: 1,
      screened: {},
      candidates: 1,
      checked: 0,
      fit: 0,
    });
  }, testBudget(60_000));

  it("completes with a summary-only day book and empty rank list when no clip qualifies", async () => {
    const control = await setup();
    await updateLedger(control.engine, "2026-10-27", (ledger) => ({
      ...ledger,
      sightings: [
        authenticSighting("only-ad", { isAd: true }),
        authenticSighting("only-photo", { kind: "photo" }),
        authenticSighting("only-cc", { source: "tiktok-creative-center" }),
      ],
    }));

    const run = (await cutTrending(control.engine, books, "2026-10-28", cutAt, enqueue))!;
    expect(run.completed).toBe(true);
    expect(run.ranking).toBe("authentic");
    expect(run.videos).toEqual([]);
    expect(run.downloads).toEqual([]);
    expect(run.funnel).toEqual({
      seen: 2,
      screened: { promoted: 1, photo: 1 },
      candidates: 0,
      checked: 0,
      fit: 0,
    });

    const day = dayEngine(run);
    expect(day.jobs.queue.list({ type: "download_video" })).toHaveLength(0);
    const notebook = day.notebooks.read(run.notebookId!);
    if (!notebook.ok) throw new Error(notebook.error.message);
    expect(notebook.value.cells).toHaveLength(1);
    expect(notebook.value.cells[0].inputs?.workflowRole).toBe("trending-summary");
  }, testBudget(60_000));

  it("reuses the frozen list when re-running an interrupted or completed cut", async () => {
    const control = await setup();
    await updateLedger(control.engine, "2026-10-27", (ledger) => ({
      ...ledger,
      sightings: [
        authenticSighting("first", {
          metrics: { views: 600_000, likes: 70_000, shares: 15_000, saves: 3_000, comments: 400 },
        }),
        authenticSighting("second", {
          metrics: { views: 400_000, likes: 30_000, shares: 4_000, saves: 800, comments: 100 },
        }),
      ],
    }));

    let count = 0;
    const interrupted = async (id: string, payload: Record<string, unknown>) => {
      if (++count === 2) throw new Error("Interrupted enqueue");
      return enqueue(id, payload);
    };
    await expect(cutTrending(control.engine, books, "2026-10-28", cutAt, interrupted)).rejects.toThrow("Interrupted");

    const frozen = readRuns(control.engine)[0];
    expect(frozen.completed).toBeUndefined();
    expect(frozen.ranking).toBe("authentic");
    expect(frozen.videos.map((video) => video.videoId)).toEqual(["first", "second"]);

    await updateLedger(control.engine, "2026-10-27", (ledger) => ({
      ...ledger,
      sightings: [
        ...ledger.sightings,
        authenticSighting("late-arrival", {
          metrics: { views: 5_000_000, likes: 1_000_000, shares: 500_000, saves: 100_000, comments: 50_000 },
          createdAt: "2026-10-27T23:00:00.000Z",
        }),
      ],
    }));

    const resumed = (await cutTrending(control.engine, books, "2026-10-28", cutAt, enqueue))!;
    expect(resumed.completed).toBe(true);
    expect(resumed.ranking).toBe("authentic");
    expect(resumed.funnel).toEqual(frozen.funnel);
    expect(resumed.videos).toEqual(frozen.videos);
    expect(resumed.downloads.map((download) => download.artifactId)).toEqual(frozen.downloads.map((download) => download.artifactId));

    const repeated = (await cutTrending(control.engine, books, "2026-10-28", cutAt, enqueue))!;
    expect(repeated).toEqual(resumed);
    expect(dayEngine(resumed).jobs.queue.list({ type: "download_video" })).toHaveLength(2);
  }, testBudget(60_000));

  it("also records ranking on views and consensus runs without a funnel", async () => {
    const control = await setup({ ranking: "consensus" });
    await updateLedger(control.engine, "2026-10-27", (ledger) => ({
      ...ledger,
      sightings: [sighting("v1"), sighting("v2")],
    }));

    const run = (await cutTrending(control.engine, books, "2026-10-28", cutAt, enqueue))!;
    expect(run.ranking).toBe("consensus");
    expect(run.funnel).toBeUndefined();
  }, testBudget(60_000));

  it("rejects an invalid topN before writing a run or creating a day book", async () => {
    const control = await setup({ topN: 0 });
    await updateLedger(control.engine, "2026-10-27", (ledger) => ({
      ...ledger,
      sightings: [authenticSighting("v1")],
    }));

    await expect(cutTrending(control.engine, books, "2026-10-28", cutAt, enqueue))
      .rejects.toThrow("topN must be between 1 and 63");
    expect(readRuns(control.engine)).toEqual([]);
    expect(books.list()).toHaveLength(1);
  }, testBudget(60_000));
});
