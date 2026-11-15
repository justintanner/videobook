import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEngine } from "videobook-engine";
import { closeEngineForTest, createEngineForTest } from "./engine.js";
import { testCatalogCommitMessages } from "./test-engine-catalog.js";

describe("createEngineForTest", () => {
  const roots: string[] = [];

  afterEach(() => {
    while (roots.length > 0) {
      const dir = roots.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  function freshRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), "videobook-engine-for-test-"));
    roots.push(dir);
    return dir;
  }

  it("matches a fresh catalog and gives each clone its own book, sequence, and tracks", async () => {
    const freshDir = join(freshRoot(), "fresh");
    const leftDir = freshRoot();
    const rightDir = join(freshRoot(), "book");
    const fresh = createEngine({
      durableWrites: false,
      rootDir: freshDir,
      initialBookName: "test-book",
    });
    const left = createEngineForTest(leftDir);
    const right = createEngineForTest(rightDir);
    await Promise.all([fresh.ready, left.ready, right.ready]);

    const freshIntegrity = fresh.catalogIntegrity();
    const leftIntegrity = left.catalogIntegrity();
    expect(leftIntegrity.tableRowCounts).toEqual(freshIntegrity.tableRowCounts);
    expect(leftIntegrity.doltStatus).toEqual([]);
    expect(freshIntegrity.doltStatus).toEqual([]);
    expect(testCatalogCommitMessages(left)).toEqual(testCatalogCommitMessages(fresh));
    expect(testCatalogCommitMessages(fresh)).toEqual([
      "Initialize Videobook book",
      "Initialize data repository",
    ]);
    expect(leftIntegrity.logCount).toBe(freshIntegrity.logCount);
    expect(left.book.get().name).toBe(fresh.book.get().name);

    expect(left.book.get().bookId).not.toBe(right.book.get().bookId);
    expect(left.book.get().bookId).not.toBe(fresh.book.get().bookId);
    const leftSequence = left.sequences.getPrimary();
    const rightSequence = right.sequences.getPrimary();
    const freshSequence = fresh.sequences.getPrimary();
    expect(leftSequence.sequenceId).not.toBe(rightSequence.sequenceId);
    expect(leftSequence.sequenceId).not.toBe(freshSequence.sequenceId);
    expect([...leftSequence.tracks.map((track) => track.kind)].sort()).toEqual(
      [...freshSequence.tracks.map((track) => track.kind)].sort(),
    );
    const leftTrackIds = leftSequence.tracks.map((track) => track.trackId);
    const rightTrackIds = new Set(rightSequence.tracks.map((track) => track.trackId));
    const freshTrackIds = new Set(freshSequence.tracks.map((track) => track.trackId));
    expect(new Set(leftTrackIds).size).toBe(leftTrackIds.length);
    expect(leftTrackIds.some((trackId) => rightTrackIds.has(trackId))).toBe(false);
    expect(leftTrackIds.some((trackId) => freshTrackIds.has(trackId))).toBe(false);

    const notebook = await left.notebooks.create("Main");
    expect(notebook.ok).toBe(true);
    fresh.close();
    closeEngineForTest(leftDir, left);
    closeEngineForTest(rightDir, right);
  });

  it("reopens an existing catalog without minting a new book id", async () => {
    const dir = freshRoot();
    const engine = createEngineForTest(dir);
    await engine.ready;
    const bookId = engine.book.get().bookId;
    const sequenceId = engine.sequences.getPrimary().sequenceId;
    closeEngineForTest(dir, engine);

    const reopened = createEngineForTest(dir);
    await reopened.ready;
    expect(reopened.book.get().bookId).toBe(bookId);
    expect(reopened.sequences.getPrimary().sequenceId).toBe(sequenceId);
    expect(reopened.catalogIntegrity().doltStatus).toEqual([]);
    expect(reopened.catalogIntegrity().logCount).toBe(2);
    closeEngineForTest(dir, reopened);
  });
});
