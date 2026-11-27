import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Engine } from "videobook-engine";
import { withBookContext } from "../../server/src/book-context.js";
import { BookManager } from "../../server/src/book-manager.js";
import { cutTrending, registerTrendingCutJob } from "../../server/src/jobs/trending-cut.js";
import { configureProviderEndpoints } from "../../server/src/media/endpoints.js";
import { enqueueOptions, queue, setEngineRoot } from "../../server/src/queue.js";
import { testBudget } from "../../server/src/test-budget.js";
import { ensureControlBook } from "../../server/src/trending/control-book.js";
import { readRuns, updateLedger, writeHistory, writeSchedule } from "../../server/src/trending/ledger.js";
import type { Sighting, TrendingRunRecord, TrendingSchedule } from "../../server/src/trending/types.js";
import { cutAt, schedule, sighting } from "./trending-fixtures.js";
import { closeServer, completedResponse, postTextOf, startServer, type CapturedRequest } from "./trending-judge-fixtures.js";

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

describe("AI checks during authentic cuts", () => {
  let server: Server;
  let baseURL: string;
  let restoreEndpoints: () => void;
  let holdResponses: boolean;
  const requests: string[] = [];
  const fits = new Map<string, number>();
  const options = { enqueue, coverPolicy: { allowHttp: true, allowPrivateHosts: true } };
  const date = "2026-10-28";
  const nextDate = "2026-10-29";
  const nextCut = "2026-10-29T00:00:00.000Z";

  beforeEach(async () => {
    vi.stubEnv("OPENAI_API_KEY", "offline-openai-key");
    fits.clear();
    requests.length = 0;
    holdResponses = false;
    const local = await startServer(async (request, response) => {
      if (request.url === "/cover.png") {
        response.writeHead(200, { "content-type": "image/png" }).end(Buffer.from([137, 80, 78, 71]));
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const post: CapturedRequest = JSON.parse(Buffer.concat(chunks).toString());
      const id = /^caption: (.+)$/m.exec(postTextOf(post))?.[1] ?? "";
      requests.push(id);
      if (holdResponses) return;
      const fit = fits.get(id);
      const text = fit === undefined ? "invalid JSON" : JSON.stringify({ kind: "candid", fit, why: id });
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(completedResponse(text)));
    });
    server = local.server;
    baseURL = local.baseURL;
    restoreEndpoints = configureProviderEndpoints({ openaiBaseURL: baseURL + "/v1" });
  });

  afterEach(async () => {
    restoreEndpoints();
    vi.unstubAllEnvs();
    await closeServer(server);
  });

  async function seed(engine: Engine, ids: string[]) {
    await updateLedger(engine, "2026-10-27", (ledger) => ({
      ...ledger,
      sightings: ids.map((id) => authenticSighting(id, { caption: id, coverUrl: baseURL + "/cover.png" })),
    }));
  }

  it("freezes a fit-led selection and usage before downloads, including partial check failures", async () => {
    const control = await setup({ criteria: { judgeLimit: 4 } });
    await seed(control.engine, ["a-good", "b-low", "c-best", "d-fails", "e-unchecked"]);
    fits.set("a-good", 7);
    fits.set("b-low", 5);
    fits.set("c-best", 10);
    const interrupted = { ...options, enqueue: async () => { throw new Error("Interrupted download"); } };
    await expect(withBookContext(control, () => cutTrending(control.engine, books, date, cutAt, interrupted)))
      .rejects.toThrow("Interrupted download");
    const [frozen] = readRuns(control.engine);
    expect(frozen.completed).toBeUndefined();
    expect(frozen.videos.map((video) => video.videoId)).toEqual(["c-best", "a-good"]);
    expect(frozen.videos[0].authentic?.verdict).toMatchObject({ cover: true, fit: 10 });
    expect(frozen.funnel).toMatchObject({ seen: 5, candidates: 5, checked: 4, fit: 2 });
    expect([...requests].sort()).toEqual(["a-good", "b-low", "c-best", "d-fails"]);
    expect(control.engine.usage.recent(10).filter((row) => row.provider === "openai")).toHaveLength(4);

    const run = (await cutTrending(control.engine, books, date, cutAt, options))!;
    expect(run.completed).toBe(true);
    expect(run.videos).toEqual(frozen.videos);
    expect(run.downloads.map((download) => download.videoId)).toEqual(["c-best", "a-good"]);
    expect(dayEngine(run).jobs.queue.list({ type: "download_video" })).toHaveLength(2);
    await cutTrending(control.engine, books, date, cutAt, options);
    expect(requests).toHaveLength(4);
  }, testBudget(60_000));

  it("selects a previously checked runner-up on the next day without a new request", async () => {
    const control = await setup({ topN: 1 });
    await seed(control.engine, ["winner", "runner-up"]);
    fits.set("winner", 10);
    fits.set("runner-up", 8);
    const first = (await cutTrending(control.engine, books, date, cutAt, options))!;
    expect(first.videos[0].videoId).toBe("winner");
    expect(requests).toHaveLength(2);
    const second = (await cutTrending(control.engine, books, nextDate, nextCut, options))!;
    expect(second.videos[0]).toMatchObject({ videoId: "runner-up", authentic: { verdict: { fit: 8 } } });
    expect(second.funnel).toMatchObject({ checked: 0, fit: 1 });
    expect(requests).toHaveLength(2);
  }, testBudget(60_000));

  it.each(["missing key", "zero limit"])("ranks by numbers even with cached verdicts for %s", async (disabled) => {
    const control = await setup({ topN: 1 });
    await seed(control.engine, ["first", "second"]);
    fits.set("first", 10);
    fits.set("second", 2);
    await cutTrending(control.engine, books, date, cutAt, options);
    expect(requests).toHaveLength(2);
    if (disabled === "missing key") vi.stubEnv("OPENAI_API_KEY", "");
    else await writeSchedule(control.engine, { ...authenticSchedule, criteria: { judgeLimit: 0 } });
    const next = (await cutTrending(control.engine, books, nextDate, nextCut, options))!;
    expect(next.videos.map((video) => video.videoId)).toEqual(["second"]);
    expect(next.videos[0].authentic?.verdict).toBeUndefined();
    expect(next.videos[0].authentic?.score).toBe(next.videos[0].authentic?.organic);
    expect(next.funnel?.checked).toBe(0);
    expect(requests).toHaveLength(2);
  }, testBudget(60_000));

  it("completes on numbers and explains the fallback when every check fails", async () => {
    const control = await setup();
    await seed(control.engine, ["first", "second"]);
    const run = (await cutTrending(control.engine, books, date, cutAt, options))!;
    expect(run).toMatchObject({ completed: true, funnel: { checked: 2, fit: 0 } });
    expect(run.videos.map((video) => video.videoId)).toEqual(["first", "second"]);
    expect(run.videos.every((video) => video.authentic?.score === video.authentic?.organic)).toBe(true);
    const notebook = dayEngine(run).notebooks.read(run.notebookId!);
    if (!notebook.ok) throw new Error(notebook.error.message);
    expect(notebook.value.cells.find((cell) => cell.inputs?.workflowRole === "trending-summary")?.prompt)
      .toContain("AI check did not run; ranked on numbers");
  }, testBudget(60_000));

  it("validates the schedule before requesting checks", async () => {
    const control = await setup({ topN: 0 });
    await seed(control.engine, ["candidate"]);
    await expect(cutTrending(control.engine, books, date, cutAt, options)).rejects.toThrow("topN");
    expect(requests).toEqual([]);
    expect(readRuns(control.engine)).toEqual([]);
  });

  it("cancels in-flight checks when the cut job stops and leaves the run unfrozen", async () => {
    const control = await setup();
    await seed(control.engine, ["a", "b", "c", "d", "e"]);
    await setEngineRoot(control.rootDir, control.engine);
    registerTrendingCutJob(books);
    holdResponses = true;
    try {
      const job = await queue.enqueue("abort-cut", { type: "trending_cut", bookId: control.bookId, date, cutAt });
      await expect.poll(() => requests.length, { timeout: testBudget(10_000) }).toBe(4);
      await queue.stop();
      expect(control.engine.jobs.queue.get(job.id)?.state).toBe("aborted");
      expect(readRuns(control.engine)).toEqual([]);
      expect(requests).toHaveLength(4);
    } finally {
      await queue.stop();
    }
  }, testBudget(60_000));
});
