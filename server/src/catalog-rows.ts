import type { Engine } from "videobook-engine";

export type CatalogRow = ReturnType<Engine["history"]["diff"]>[number];

function* rootRevisions(engine: Engine, logCount: number): Generator<string> {
  yield `HEAD~${logCount - 1}`;
  const oldest = engine.history.revisions(Number.MAX_SAFE_INTEGER).at(-1);
  if (oldest) yield `${oldest.hash}~1`;
}

export function currentCatalogRows(engine: Engine, table: string): CatalogRow[] {
  const integrity = engine.catalogIntegrity();
  const expected = integrity.tableRowCounts[table] ?? 0;
  for (const root of rootRevisions(engine, integrity.logCount)) {
    const rows = engine.history.diff(root, "WORKING", table)
      .filter((row) => row.diff_type !== "removed");
    if (rows.length === expected) return rows;
  }
  throw new Error(`Could not read the ${table} table of this book`);
}
