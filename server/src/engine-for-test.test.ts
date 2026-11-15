import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEngine } from "videobook-engine";
import type { Engine } from "videobook-engine";
import { v7 as uuidv7 } from "uuid";
import { closeEngineForTest, createEngineForTest } from "./engine.js";
import { testCatalogCommitMessages } from "./test-engine-catalog.js";

type Row = Record<string, unknown>;
interface TestCatalog {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...values: unknown[]): Row[];
    get(...values: unknown[]): Row | undefined;
    run(...values: unknown[]): unknown;
  };
  doltStatus(): Array<{ table_name: string; status: string }>;
  doltLog(): Array<{ message: string; committer: string; committer_email: string }>;
}

function catalog(engine: Engine): TestCatalog {
  return (engine as unknown as { context: { store: { db: TestCatalog } } }).context.store.db;
}

function tableNames(db: TestCatalog): string[] {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'dolt_%'")
    .all().map(({ name }) => {
      if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error("Invalid test table name");
      }
      return name;
    });
}

function previousCloneIdentity(engine: Engine): void {
  const db = catalog(engine);
  const tables = tableNames(db).map((name) => ({
    name,
    columns: db.prepare(`PRAGMA table_info("${name}")`).all().map((row) => row.name),
  }));
  const replace = (column: string, from: unknown): void => {
    const to = uuidv7();
    for (const table of tables) {
      if (table.columns.includes(column)) {
        db.prepare(`UPDATE "${table.name}" SET "${column}" = ? WHERE "${column}" = ?`).run(to, from);
      }
    }
  };
  const createdAt = Date.now();
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    for (const row of db.prepare("SELECT track_id FROM sequence_tracks").all()) replace("track_id", row.track_id);
    for (const row of db.prepare("SELECT sequence_id FROM sequences").all()) replace("sequence_id", row.sequence_id);
    for (const row of db.prepare("SELECT book_id FROM book").all()) replace("book_id", row.book_id);
    db.prepare("UPDATE book SET created_at = ?").run(createdAt);
    db.prepare("UPDATE sequences SET created_at = ?").run(createdAt);
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
  const staged = new Set<string>();
  for (const entry of db.doltStatus()) {
    if (entry.status === "ignored" || staged.has(entry.table_name)) continue;
    staged.add(entry.table_name);
    db.prepare("SELECT dolt_add(?) AS result").get(entry.table_name);
  }
  db.prepare("SELECT dolt_commit('--amend', '-m', ?, '--author', ?) AS hash")
    .get("Initialize Videobook book", "Videobook <videobook@localhost>");
}

function catalogRows(engine: Engine): Record<string, unknown> {
  const book = engine.book.get();
  const sequence = engine.sequences.getPrimary();
  const ids = new Map([
    [book.bookId, "<book>"],
    [sequence.sequenceId, "<sequence>"],
    ...sequence.tracks.map((track): [string, string] => [track.trackId, `<track:${track.kind}>`]),
  ]);
  const normalize = (value: unknown, key = ""): unknown => {
    if (key.endsWith("_at") && value !== null) return "<timestamp>";
    if (typeof value === "string") return ids.get(value) ?? value;
    if (Array.isArray(value)) return value.map((entry) => normalize(entry));
    if (value !== null && typeof value === "object") {
      const record = value as Row;
      return Object.fromEntries(Object.entries(record).map(([name, entry]) => [
        name,
        normalize(entry, name === "value_json" && typeof record.key === "string" ? record.key : name),
      ]));
    }
    return value;
  };
  const db = catalog(engine);
  return Object.fromEntries(tableNames(db).map((name) => [
    name,
    db.prepare(`SELECT * FROM "${name}"`).all().map((row) => JSON.stringify(normalize(row))).sort(),
  ]));
}

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

  it("matches every catalog row and commit author from the previous clone path", async () => {
    const templateDir = freshRoot();
    const previousDir = freshRoot();
    const optimizedDir = freshRoot();
    const template = createEngine({ rootDir: templateDir, initialBookName: "test-book", durableWrites: false });
    await template.ready;
    template.close();
    cpSync(templateDir, previousDir, { recursive: true });
    const previous = createEngine({ rootDir: previousDir, initialBookName: "test-book", durableWrites: false });
    previousCloneIdentity(previous);
    const optimized = createEngineForTest(optimizedDir);
    try {
      await Promise.all([previous.ready, optimized.ready]);
      expect(catalogRows(optimized)).toEqual(catalogRows(previous));
      const commits = (engine: Engine) => catalog(engine).doltLog().map(({ message, committer, committer_email }) =>
        ({ message, committer, committer_email }));
      expect(commits(optimized)).toEqual(commits(previous));
      expect(catalog(optimized).doltStatus()).toEqual([]);
      expect(catalog(previous).doltStatus()).toEqual([]);
      expect(catalog(optimized).prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(optimized.book.get().bookId).not.toBe(previous.book.get().bookId);
    } finally {
      previous.close();
      closeEngineForTest(optimizedDir, optimized);
    }
  });
});
