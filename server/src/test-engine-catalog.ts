import { cpSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { v7 as uuidv7 } from "uuid";
import { createEngine } from "videobook-engine";

const testEngines = new Map<string, ReturnType<typeof createEngine>>();
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TEST_BOOK_COMMIT_MESSAGE = "Initialize Videobook book";
const TEST_BOOK_COMMIT_AUTHOR = "Videobook <videobook@localhost>";

type SqlRow = Record<string, unknown>;

interface CatalogStatement {
  all: (...args: unknown[]) => SqlRow[];
  get: (...args: unknown[]) => SqlRow | undefined;
  run: (...args: unknown[]) => unknown;
}

interface CatalogStatusEntry {
  table_name: string;
  status: string;
}

interface CatalogDb {
  exec: (sql: string) => void;
  prepare: (sql: string) => CatalogStatement;
  doltLog: () => Array<{ message: string }>;
  doltStatus: () => CatalogStatusEntry[];
}

interface CatalogTable {
  table: string;
  columns: Set<string>;
}

let testBookTemplateRoot: string | undefined;
let testBookTemplateTables: CatalogTable[] | undefined;

function quoteIdent(name: string): string {
  if (!IDENTIFIER.test(name)) {
    throw new Error(`Unexpected catalog identifier ${name}`);
  }
  return `"${name}"`;
}

function textCell(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Catalog row is missing ${key}`);
  }
  return value;
}

function catalogDatabase(engine: ReturnType<typeof createEngine>): CatalogDb {
  const opened = engine as unknown as { context: { store: { db: CatalogDb } } };
  return opened.context.store.db;
}

export function testCatalogCommitMessages(engine: ReturnType<typeof createEngine>): string[] {
  return catalogDatabase(engine).doltLog().map((entry) => entry.message);
}

function ensureTestBookTemplate(): string {
  if (testBookTemplateRoot) return testBookTemplateRoot;
  const root = mkdtempSync(join(tmpdir(), "videobook-test-book-"));
  const engine = createEngine({
    durableWrites: false,
    rootDir: root,
    initialBookName: "test-book",
  });
  void engine.ready.catch(() => undefined);
  engine.close();
  testBookTemplateRoot = root;
  return root;
}

function catalogTables(db: CatalogDb): CatalogTable[] {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'dolt_%'",
    )
    .all();
  return tables.map((row) => {
    const table = textCell(row, "name");
    const info = db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all();
    return {
      table,
      columns: new Set(info.map((column) => textCell(column, "name"))),
    };
  });
}

function templateIdentityTables(db: CatalogDb): CatalogTable[] {
  testBookTemplateTables ??= catalogTables(db).filter(({ table, columns }) =>
    ["book_id", "sequence_id", "track_id"].some((column) => columns.has(column))
    && db.prepare(`SELECT 1 AS present FROM ${quoteIdent(table)} LIMIT 1`).get() !== undefined);
  return testBookTemplateTables;
}

function replaceColumn(
  db: CatalogDb,
  tables: readonly CatalogTable[],
  column: string,
  from: string,
  to: string,
): void {
  for (const table of tables) {
    if (!table.columns.has(column)) continue;
    db.prepare(
      `UPDATE ${quoteIdent(table.table)} SET ${quoteIdent(column)} = ? WHERE ${quoteIdent(column)} = ?`,
    ).run(to, from);
  }
}

function rewriteTrackIds(db: CatalogDb, tables: readonly CatalogTable[]): void {
  const tracks = tables.find((table) => table.table === "sequence_tracks");
  if (!tracks?.columns.has("track_id")) return;
  const rows = db.prepare("SELECT track_id FROM sequence_tracks").all();
  for (const row of rows) {
    replaceColumn(db, tables, "track_id", textCell(row, "track_id"), uuidv7());
  }
}

function rewriteSingleId(
  db: CatalogDb,
  tables: readonly CatalogTable[],
  table: string,
  column: string,
): void {
  const rows = db.prepare(`SELECT ${quoteIdent(column)} FROM ${quoteIdent(table)}`).all();
  if (rows.length !== 1) {
    throw new Error(`Test catalog clone expected one ${table} row, found ${rows.length}`);
  }
  const row = rows[0];
  if (!row) throw new Error(`Test catalog clone expected one ${table} row, found 0`);
  replaceColumn(db, tables, column, textCell(row, column), uuidv7());
}

function amendClonedBookIdentity(db: CatalogDb): void {
  const staged = new Set<string>();
  for (const entry of db.doltStatus()) {
    if (entry.status === "ignored" || staged.has(entry.table_name)) continue;
    if (!IDENTIFIER.test(entry.table_name)) {
      throw new Error(`Unexpected catalog identifier ${entry.table_name}`);
    }
    staged.add(entry.table_name);
  }
  if (staged.size === 0) {
    throw new Error("Test catalog clone did not change its book identity");
  }
  db.prepare(`SELECT dolt_add(${[...staged].map(() => "?").join(", ")}) AS result`)
    .get(...staged);
  const amended = db
    .prepare("SELECT dolt_commit('--amend', '-m', ?, '--author', ?) AS hash")
    .get(TEST_BOOK_COMMIT_MESSAGE, TEST_BOOK_COMMIT_AUTHOR);
  if (typeof amended?.hash !== "string" || amended.hash.length === 0) {
    throw new Error("Test catalog clone did not amend its book identity");
  }
  const remaining = db
    .doltStatus()
    .filter((entry) => entry.status !== "ignored")
    .map((entry) => entry.table_name);
  if (remaining.length > 0) {
    throw new Error(`Test catalog clone left uncommitted tables: ${remaining.join(", ")}`);
  }
}

function assignFreshBookIdentity(engine: ReturnType<typeof createEngine>): void {
  const db = catalogDatabase(engine);
  const tables = templateIdentityTables(db);
  const createdAt = Date.now();
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN");
  try {
    rewriteTrackIds(db, tables);
    rewriteSingleId(db, tables, "sequences", "sequence_id");
    rewriteSingleId(db, tables, "book", "book_id");
    db.prepare("UPDATE book SET created_at = ?").run(createdAt);
    db.prepare("UPDATE sequences SET created_at = ?").run(createdAt);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
  amendClonedBookIdentity(db);
}

export function createEngineForTest(rootDir: string) {
  const normalizedRoot = resolve(rootDir);
  const existing = testEngines.get(normalizedRoot);
  if (existing) return existing;
  const databasePath = join(normalizedRoot, "data", "videobook.db");
  const existed = existsSync(databasePath);
  if (!existed) {
    cpSync(ensureTestBookTemplate(), normalizedRoot, { recursive: true });
  }
  const engine = createEngine({
    durableWrites: false,
    rootDir: normalizedRoot,
    initialBookName: "test-book",
  });
  if (!existed) {
    try {
      assignFreshBookIdentity(engine);
    } catch (error) {
      engine.close();
      throw error;
    }
  }
  testEngines.set(normalizedRoot, engine);
  return engine;
}

export function closeEngineForTest(
  rootDir: string,
  engine: ReturnType<typeof createEngine>,
): void {
  const normalizedRoot = resolve(rootDir);
  if (testEngines.get(normalizedRoot) === engine) {
    testEngines.delete(normalizedRoot);
  }
  engine.close();
}
