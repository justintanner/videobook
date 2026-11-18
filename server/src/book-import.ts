import { randomUUID } from "node:crypto";
import type { Engine } from "videobook-engine";

const BOOK_IMPORT_KEY = "application.import_id.v1";

export function bookImportId(engine: Engine): string | null {
  const value = engine.settings.get<unknown>(BOOK_IMPORT_KEY);
  return typeof value === "string" ? value : null;
}

export function markBookImported(engine: Engine): void {
  const saved = engine.settings.set(BOOK_IMPORT_KEY, randomUUID());
  if (!saved.ok) throw new Error(saved.error.message);
}
