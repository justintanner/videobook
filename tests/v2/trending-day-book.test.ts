import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEngine, type Engine } from "videobook-engine";
import { BookManager } from "../../server/src/book-manager.js";
import { buildDayBook, syncDayBookDownloads } from "../../server/src/trending/day-book.js";
import { controlBookSlug, dayBookSlug, localDate, readLedger, readRuns, readSchedule, readSourceHealth, updateLedger, writeRun, writeSchedule, writeSourceHealth } from "../../server/src/trending/ledger.js";
import { rankVideos } from "../../server/src/trending/ranking.js";
import type { RankedVideo, TrendingFunnel, TrendingRunRecord, TrendingSchedule } from "../../server/src/trending/types.js";
import { testBudget } from "../../server/src/test-budget.js";
import { cutAt, schedule, sighting } from "./trending-fixtures.js";

let root: string | undefined;
let books: BookManager | undefined;
let control: Engine | undefined;
afterEach(async () => {
  await books?.close();
  control?.close();
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe("trending persistence", () => {
  it("normalizes slugs and resolves local dates across midnight and DST", () => {
    expect(controlBookSlug("TH")).toBe("tiktok-th-research");
    expect(dayBookSlug("TH", "2026-10-28")).toBe("tiktok-th-2026-10-28");
    expect(() => dayBookSlug("TH", "2026-02-30")).toThrow();
    expect(() => controlBookSlug("../TH")).toThrow();
    expect(localDate("2026-10-27T18:00:00Z", "Asia/Bangkok")).toBe("2026-10-28");
    expect(localDate("2026-11-01T05:30:00Z", "America/New_York")).toBe("2026-11-01");
    expect(localDate("2026-11-01T06:30:00Z", "America/New_York")).toBe("2026-11-01");
  });

  it("serializes ledger and health updates and persists schedule and run records", async () => {
    root = await mkdtemp(join(tmpdir(), "trending-ledger-"));
    control = createEngine({ rootDir: root, initialBookName: "tiktok-th-research", durableWrites: false });
    await control.ready;
    const engine = control;
    await writeSchedule(engine, schedule);
    await Promise.all(["one", "two"].map((id) => updateLedger(engine, "2026-10-28", (ledger) => ({
      ...ledger, sightings: [...ledger.sightings, sighting(id)], completedSlots: [...ledger.completedSlots, id],
    }))));
    await Promise.all(["endless", "second"].map((source) => writeSourceHealth(engine, source, { lastOk: cutAt })));
    const run = { date: "2026-10-28", cutAt, dayBookId: "day", videos: [], downloads: [], spend: 0, errors: [] };
    await writeRun(engine, run);
    await writeRun(engine, { ...run, errors: ["retry"] });
    engine.close();
    control = createEngine({ rootDir: root, durableWrites: false });
    await control.ready;
    expect(readSchedule(control)).toEqual(schedule);
    expect(readLedger(control, "2026-10-28").completedSlots).toEqual(["one", "two"]);
    expect(readLedger(control, "2026-10-29").sightings).toEqual([]);
    expect(Object.keys(readSourceHealth(control))).toEqual(["endless", "second"]);
    expect(readRuns(control)).toEqual([{ ...run, errors: ["retry"] }]);
  }, testBudget(60_000));

  it("builds ten rows and updates them in place, preserving user cells and download state", async () => {
    root = await mkdtemp(join(tmpdir(), "trending-day-"));
    books = new BookManager({ libraryDir: root });
    const videos = rankVideos(Array.from({ length: 10 }, (_, index) => sighting(String(index), { metrics: { views: 1000 - index, likes: index } })), schedule, { cutAt });
    let creates = 0;
    const options = {
      cutAt,
      createVideoArtifact: async (rank: number, _video: typeof videos[number], engine: Engine): Promise<string> => {
        creates += 1;
        const result = await engine.artifacts.create({ kind: "video", label: `Rank ${rank}` });
        if (!result.ok) throw new Error(result.error.message);
        return result.value.artifactId;
      },
    };
    const first = await buildDayBook(books, schedule, "2026-10-28", videos, options);
    const selected = books.getByName("tiktok-th-2026-10-28");
    if (!selected.ok) throw new Error(selected.error.message);
    const engine = selected.value.engine;
    const read = engine.notebooks.read(first.notebookId);
    if (!read.ok) throw new Error(read.error.message);
    expect(read.value.name).toBe("Top 10 · 2026-10-28");
    expect(read.value.description).toContain("method: views");
    expect(read.value.fixture?.trending).toMatchObject({ version: 1, scheduleId: schedule.scheduleId, date: "2026-10-28", cutAt });
    expect(read.value.cells).toHaveLength(21);
    const summary = read.value.cells.find((cell) => cell.inputs?.workflowRole === "trending-summary");
    expect(summary?.slot).toEqual({ row: 0, column: 0 });
    expect(summary?.prompt).toContain("Contributing sources: endless");
    for (const row of first.ranks) {
      const video = read.value.cells.find((cell) => cell.id === row.videoCellId)!;
      const notes = read.value.cells.find((cell) => cell.id === row.notesCellId)!;
      expect(video.slot).toEqual({ row: row.rank, column: 0 });
      expect(notes.slot).toEqual({ row: row.rank, column: 1 });
      expect(video.inputs?.research).toMatchObject({ rank: row.rank, sources: ["endless"], fallback: false });
      expect(notes.inputs?.research).toEqual(video.inputs?.research);
      expect(notes.prompt).toContain("A video");
    }
    const user = engine.notebooks.createCell({ type: "prompt", prompt: "My notes", slot: { row: 1, column: 2 } });
    read.value.cells.push(user);
    const firstVideo = read.value.cells.find((cell) => cell.id === first.ranks[0].videoCellId)!;
    firstVideo.inputs = { ...firstVideo.inputs, state: "completed" };
    const written = await engine.notebooks.write(read.value);
    expect(written.ok).toBe(true);
    const [second, third] = await Promise.all([
      buildDayBook(books, schedule, "2026-10-28", videos, options),
      buildDayBook(books, schedule, "2026-10-28", videos, options),
    ]);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(creates).toBe(10);
    const repeated = engine.notebooks.read(first.notebookId);
    if (!repeated.ok) throw new Error(repeated.error.message);
    expect(repeated.value.cells).toHaveLength(22);
    expect(repeated.value.cells.find((cell) => cell.id === user.id)?.prompt).toBe("My notes");
    expect(repeated.value.cells.find((cell) => cell.id === firstVideo.id)?.inputs?.state).toBe("completed");
    const changed = videos.map((video, index) => index ? video : { ...video, videoId: "replacement", caption: "Updated caption" });
    const updated = await buildDayBook(books, schedule, "2026-10-28", changed, options);
    expect(updated.ranks[0].videoCellId).toBe(first.ranks[0].videoCellId);
    expect(updated.ranks[0].artifactId).not.toBe(first.ranks[0].artifactId);
    expect(creates).toBe(11);
    const reduced = await buildDayBook(books, schedule, "2026-10-28", changed.slice(0, 2), options);
    expect(reduced.ranks).toEqual(updated.ranks.slice(0, 2));
    const reducedRead = engine.notebooks.read(first.notebookId);
    if (!reducedRead.ok) throw new Error(reducedRead.error.message);
    expect(reducedRead.value.cells).toHaveLength(6);
    expect(reducedRead.value.cells.find((cell) => cell.id === firstVideo.id)?.inputs?.state).toBe("pending");
    expect(reducedRead.value.cells.find((cell) => cell.id === first.ranks[0].notesCellId)?.prompt).toContain("Updated caption");
  }, testBudget(90_000));

  it("renders authentic summary columns, escaped why, funnel line, notes and provenance", async () => {
    root = await mkdtemp(join(tmpdir(), "trending-day-authentic-"));
    books = new BookManager({ libraryDir: root });
    const authenticSchedule: TrendingSchedule = { ...schedule, ranking: "authentic" };
    const funnel: TrendingFunnel = {
      seen: 30,
      screened: { "paid-reach": 5, duration: 10, stale: 4, photo: 1 },
      candidates: 10,
      checked: 10,
      fit: 2,
    };
    const videos: RankedVideo[] = [
      {
        ...sighting("clip-1", {
          author: { handle: "streetchef" },
          caption: "Roti master in Chiang Mai",
          durationSeconds: 22,
          metrics: { views: 500_000, likes: 50_000, shares: 10_000, comments: 250, saves: 2_000 },
        }),
        rank: 1,
        sources: ["endless"],
        fallback: false,
        authentic: {
          score: 0.85,
          organic: 0.86,
          verdict: {
            kind: "candid",
            fit: 9,
            why: "Street vendor | flips roti\nin night market",
            cover: true,
          },
        },
      },
      {
        ...sighting("clip-2", {
          author: { handle: "bkkdog" },
          caption: "Dog on scooter",
          metrics: { views: 200_000, likes: 12_000 },
        }),
        rank: 2,
        sources: ["endless", "omkar"],
        fallback: false,
        authentic: {
          score: 0.56,
          organic: 0.5,
          verdict: {
            kind: "candid",
            fit: 7,
            why: "Dog rides scooter calmly",
            cover: false,
          },
        },
      },
    ];
    const result = await buildDayBook(books, authenticSchedule, "2026-10-28", videos, {
      cutAt,
      ranking: "authentic",
      funnel,
      createVideoArtifact: async (rank, _video, engine) => {
        const created = await engine.artifacts.create({ kind: "video", label: `Rank ${rank}` });
        if (!created.ok) throw new Error(created.error.message);
        return created.value.artifactId;
      },
    });
    const selected = books.get(result.bookId);
    if (!selected.ok) throw new Error(selected.error.message);
    const engine = selected.value.engine;
    const read = engine.notebooks.read(result.notebookId);
    if (!read.ok) throw new Error(read.error.message);
    const summaryPrompt = read.value.cells.find((cell) => cell.inputs?.workflowRole === "trending-summary")!.prompt!;
    const summaryLines = summaryPrompt.split("\n");
    expect(summaryLines[1]).toContain("Method: authentic;");
    expect(summaryLines[3]).toBe("Funnel: 30 seen; 20 dropped (duration: 10, paid-reach: 5, photo: 1, stale: 4); 10 checked; 2 fit the brief.");
    expect(summaryPrompt).not.toContain("AI check did not run");
    expect(summaryLines[5]).toBe("| Rank | Handle | Views | Likes | Posted | Sources | Download status | Fallback | Score | Shares | Why |");
    const rows = summaryLines.filter((line) => /^\| \d/.test(line));
    expect(rows).toHaveLength(2);
    const row1Cols = rows[0].split(" | ");
    expect(row1Cols).toHaveLength(11);
    expect(row1Cols[6]).toBe("pending");
    expect(row1Cols[8]).toBe("0.85");
    expect(row1Cols[9]).toBe("2.00%");
    expect(row1Cols[10]).toBe("Street vendor \\| flips roti in night market |");
    const row2Cols = rows[1].split(" | ");
    expect(row2Cols).toHaveLength(11);
    expect(row2Cols[6]).toBe("pending");
    expect(row2Cols[8]).toBe("0.56");
    expect(row2Cols[9]).toBe("");
    expect(row2Cols[10]).toBe("Dog rides scooter calmly |");

    const firstVideoCell = read.value.cells.find((cell) => cell.id === result.ranks[0].videoCellId)!;
    const firstNotesCell = read.value.cells.find((cell) => cell.id === result.ranks[0].notesCellId)!;
    const secondNotesCell = read.value.cells.find((cell) => cell.id === result.ranks[1].notesCellId)!;
    expect(firstVideoCell.inputs?.research).toMatchObject({ authentic: videos[0].authentic });
    expect(firstNotesCell.inputs?.research).toEqual(firstVideoCell.inputs?.research);
    expect(firstNotesCell.prompt).toContain("Verdict: candid, fit 9/10, cover seen — Street vendor | flips roti\nin night market");
    expect(firstNotesCell.prompt).toContain("Score: 0.85 (organic: 0.86)");
    expect(firstNotesCell.prompt).toContain("Rates: likes 10.00%, shares 2.00%, comments 0.05%, saves 0.40%");
    expect(firstNotesCell.prompt).toContain("Duration: 22s");
    expect(secondNotesCell.prompt).toContain("Verdict: candid, fit 7/10, cover not seen — Dog rides scooter calmly");
    expect(secondNotesCell.prompt).toContain("Score: 0.56 (organic: 0.50)");
    expect(secondNotesCell.prompt).toContain("Rates: likes 6.00%, shares unknown, comments unknown, saves unknown");
    expect(secondNotesCell.prompt).toContain("Duration: unknown");

    const run: TrendingRunRecord = {
      date: "2026-10-28",
      cutAt,
      ranking: "authentic",
      funnel,
      dayBookId: result.bookId,
      notebookId: result.notebookId,
      videos,
      downloads: [
        { videoId: "clip-1", artifactId: result.ranks[0].artifactId, status: "completed" },
        { videoId: "clip-2", artifactId: result.ranks[1].artifactId, status: "failed", error: "network" },
      ],
      spend: 0,
      errors: [],
    };
    await syncDayBookDownloads(engine, authenticSchedule, run);
    const synced = engine.notebooks.read(result.notebookId);
    if (!synced.ok) throw new Error(synced.error.message);
    const syncedSummary = synced.value.cells.find((cell) => cell.inputs?.workflowRole === "trending-summary")!.prompt!;
    const syncedRows = syncedSummary.split("\n").filter((line) => /^\| \d/.test(line));
    expect(syncedRows.map((line) => line.split(" | ")[6])).toEqual(["completed", "failed"]);
    expect(syncedRows[0].split(" | ")[10]).toBe("Street vendor \\| flips roti in night market |");
    expect(syncedSummary).toContain("Funnel: 30 seen; 20 dropped (duration: 10, paid-reach: 5, photo: 1, stale: 4); 10 checked; 2 fit the brief.");
  }, testBudget(60_000));

  it("notes when the AI check did not run and renders funnel-only empty authentic runs", async () => {
    root = await mkdtemp(join(tmpdir(), "trending-day-no-verdict-"));
    books = new BookManager({ libraryDir: root });
    const authenticSchedule: TrendingSchedule = { ...schedule, ranking: "authentic" };
    const numbersOnlyVideos: RankedVideo[] = [
      {
        ...sighting("organic-only", {
          durationSeconds: 18,
          metrics: { views: 500_000, likes: 50_000, shares: 10_000, comments: 250, saves: 2_000 },
        }),
        rank: 1,
        sources: ["endless"],
        fallback: false,
        authentic: { score: 0.72, organic: 0.72 },
      },
    ];
    const numbersOnly = await buildDayBook(books, authenticSchedule, "2026-10-28", numbersOnlyVideos, {
      cutAt,
      ranking: "authentic",
      funnel: { seen: 4, screened: { "paid-reach": 1, stale: 1 }, candidates: 2, checked: 0, fit: 0 },
      createVideoArtifact: async (rank, _video, engine) => {
        const created = await engine.artifacts.create({ kind: "video", label: `Rank ${rank}` });
        if (!created.ok) throw new Error(created.error.message);
        return created.value.artifactId;
      },
    });
    const day1 = books.get(numbersOnly.bookId);
    if (!day1.ok) throw new Error(day1.error.message);
    const nb1 = day1.value.engine.notebooks.read(numbersOnly.notebookId);
    if (!nb1.ok) throw new Error(nb1.error.message);
    const summary1 = nb1.value.cells.find((cell) => cell.inputs?.workflowRole === "trending-summary")!.prompt!;
    expect(summary1).toContain("Funnel: 4 seen; 2 dropped (paid-reach: 1, stale: 1); 0 checked; 0 fit the brief. AI check did not run; ranked on numbers.");
    const row1Cols = summary1.split("\n").find((line) => /^\| 1 \|/.test(line))!.split(" | ");
    expect(row1Cols).toHaveLength(11);
    expect(row1Cols[6]).toBe("pending");
    expect(row1Cols[8]).toBe("0.72");
    expect(row1Cols[9]).toBe("2.00%");
    expect(row1Cols[10]).toBe(" |");
    const notes1 = nb1.value.cells.find((cell) => cell.id === numbersOnly.ranks[0].notesCellId)!.prompt!;
    expect(notes1).toContain("Verdict: none (AI check did not run)");
    expect(notes1).toContain("Score: 0.72 (organic: 0.72)");

    const empty = await buildDayBook(books, authenticSchedule, "2026-10-29", [], {
      cutAt: "2026-10-29T00:00:00.000Z",
      ranking: "authentic",
      funnel: { seen: 2, screened: { promoted: 1, photo: 1 }, candidates: 0, checked: 0, fit: 0 },
      createVideoArtifact: async () => {
        throw new Error("Should not create artifacts");
      },
    });
    const day2 = books.get(empty.bookId);
    if (!day2.ok) throw new Error(day2.error.message);
    const nb2 = day2.value.engine.notebooks.read(empty.notebookId);
    if (!nb2.ok) throw new Error(nb2.error.message);
    const summary2 = nb2.value.cells.find((cell) => cell.inputs?.workflowRole === "trending-summary")!.prompt!;
    expect(summary2).toContain("Funnel: 2 seen; 2 dropped (photo: 1, promoted: 1); 0 checked; 0 fit the brief.");
    expect(summary2).not.toContain("AI check did not run");
    expect(summary2).toContain("| Rank | Handle | Views | Likes | Posted | Sources | Download status | Fallback |");
    expect(summary2).not.toContain("| Score |");
  }, testBudget(60_000));

  it("keeps non-authentic runs byte-identical under a schedule switched to authentic", async () => {
    root = await mkdtemp(join(tmpdir(), "trending-day-legacy-"));
    books = new BookManager({ libraryDir: root });
    const legacyVideos = rankVideos(
      [
        sighting("v1", {
          durationSeconds: 20,
          metrics: { views: 1000, likes: 100, shares: 50, comments: 10, saves: 5 },
        }),
      ],
      schedule,
      { cutAt },
    );
    const result = await buildDayBook(books, schedule, "2026-10-28", legacyVideos, {
      cutAt,
      ranking: "views",
      createVideoArtifact: async (rank, _video, engine) => {
        const created = await engine.artifacts.create({ kind: "video", label: `Rank ${rank}` });
        if (!created.ok) throw new Error(created.error.message);
        return created.value.artifactId;
      },
    });
    const selected = books.get(result.bookId);
    if (!selected.ok) throw new Error(selected.error.message);
    const engine = selected.value.engine;
    const before = engine.notebooks.read(result.notebookId);
    if (!before.ok) throw new Error(before.error.message);
    const expectedSummary = [
      "# Top 10 research",
      `Method: views; trending window: 24 hours; cutoff: ${cutAt} (Asia/Bangkok, 07:00).`,
      "Contributing sources: endless.",
      "",
      "| Rank | Handle | Views | Likes | Posted | Sources | Download status | Fallback |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      "| 1 | author | 1000 | 100 | 2026-10-26T00:00:00.000Z | endless | pending | no |",
    ].join("\n");
    const expectedNotes = [
      "# Rank 1: author",
      "A video",
      "Author: {\"handle\":\"author\"}",
      "Metrics: {\"views\":1000,\"likes\":100,\"shares\":50,\"comments\":10,\"saves\":5}",
      "Posted: 2026-10-26T00:00:00.000Z",
      "URL: https://www.tiktok.com/@author/video/v1",
      "Sources: endless",
      "Music: null",
    ].join("\n\n");
    const summaryBefore = before.value.cells.find((cell) => cell.inputs?.workflowRole === "trending-summary")!.prompt!;
    const notesBefore = before.value.cells.find((cell) => cell.id === result.ranks[0].notesCellId)!.prompt!;
    const videoInputsBefore = before.value.cells.find((cell) => cell.id === result.ranks[0].videoCellId)!.inputs!;
    const notesInputsBefore = before.value.cells.find((cell) => cell.id === result.ranks[0].notesCellId)!.inputs!;
    expect(summaryBefore).toBe(expectedSummary);
    expect(notesBefore).toBe(expectedNotes);
    expect("authentic" in (videoInputsBefore.research as Record<string, unknown>)).toBe(false);
    expect("authentic" in (notesInputsBefore.research as Record<string, unknown>)).toBe(false);

    const switchedSchedule: TrendingSchedule = { ...schedule, ranking: "authentic" };
    const revisionsBefore = engine.history.revisions(1000).length;
    await syncDayBookDownloads(engine, switchedSchedule, {
      date: "2026-10-28",
      cutAt,
      ranking: "views",
      dayBookId: result.bookId,
      notebookId: result.notebookId,
      videos: legacyVideos,
      downloads: [{ videoId: "v1", artifactId: result.ranks[0].artifactId, status: "pending" }],
      spend: 0,
      errors: [],
    });
    const afterViewsSync = engine.notebooks.read(result.notebookId);
    if (!afterViewsSync.ok) throw new Error(afterViewsSync.error.message);
    expect(afterViewsSync.value.cells.find((cell) => cell.inputs?.workflowRole === "trending-summary")!.prompt).toBe(expectedSummary);
    expect(afterViewsSync.value.cells.find((cell) => cell.id === result.ranks[0].notesCellId)!.prompt).toBe(expectedNotes);
    expect(afterViewsSync.value.cells.find((cell) => cell.id === result.ranks[0].videoCellId)!.inputs).toEqual(videoInputsBefore);
    expect(afterViewsSync.value.cells.find((cell) => cell.id === result.ranks[0].notesCellId)!.inputs).toEqual(notesInputsBefore);
    expect(engine.history.revisions(1000).length).toBe(revisionsBefore);

    await syncDayBookDownloads(engine, switchedSchedule, {
      date: "2026-10-28",
      cutAt,
      ranking: "consensus",
      dayBookId: result.bookId,
      notebookId: result.notebookId,
      videos: legacyVideos,
      downloads: [{ videoId: "v1", artifactId: result.ranks[0].artifactId, status: "pending" }],
      spend: 0,
      errors: [],
    });
    const afterConsensusSync = engine.notebooks.read(result.notebookId);
    if (!afterConsensusSync.ok) throw new Error(afterConsensusSync.error.message);
    expect(afterConsensusSync.value.cells.find((cell) => cell.inputs?.workflowRole === "trending-summary")!.prompt)
      .toBe(expectedSummary.replace("Method: views;", "Method: consensus;"));

    await syncDayBookDownloads(engine, switchedSchedule, {
      date: "2026-10-28",
      cutAt,
      dayBookId: result.bookId,
      notebookId: result.notebookId,
      videos: legacyVideos,
      downloads: [{ videoId: "v1", artifactId: result.ranks[0].artifactId, status: "pending" }],
      spend: 0,
      errors: [],
    });
    const afterPreEpicSync = engine.notebooks.read(result.notebookId);
    if (!afterPreEpicSync.ok) throw new Error(afterPreEpicSync.error.message);
    expect(afterPreEpicSync.value.cells.find((cell) => cell.inputs?.workflowRole === "trending-summary")!.prompt)
      .toBe(expectedSummary.replace("Method: views;", "Method: authentic;"));
    expect(afterPreEpicSync.value.cells.find((cell) => cell.id === result.ranks[0].notesCellId)!.prompt).toBe(expectedNotes);
    expect(afterPreEpicSync.value.cells.find((cell) => cell.id === result.ranks[0].videoCellId)!.inputs).toEqual(videoInputsBefore);
  }, testBudget(60_000));
});
