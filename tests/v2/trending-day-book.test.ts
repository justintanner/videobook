import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEngine, type Engine } from "videobook-engine";
import { BookManager } from "../../server/src/book-manager.js";
import { buildDayBook } from "../../server/src/trending/day-book.js";
import { controlBookSlug, dayBookSlug, localDate, readLedger, readRuns, readSchedule, readSourceHealth, updateLedger, writeRun, writeSchedule, writeSourceHealth } from "../../server/src/trending/ledger.js";
import { rankVideos } from "../../server/src/trending/ranking.js";
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
});
