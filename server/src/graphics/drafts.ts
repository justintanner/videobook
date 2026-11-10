import { randomUUID } from "node:crypto";
import type { Engine } from "videobook-engine";
import type { GraphicsDocument } from "./model.js";
import { parseGraphicsDocument } from "./model.js";

export type GraphicsDraft = { revision: string; updatedAt: string; document: GraphicsDocument };

function draftKey(artifactId: string): string {
  return `graphics.draft.${artifactId}`;
}

export function readGraphicsDraft(engine: Engine, artifactId: string): GraphicsDraft | null {
  const value = engine.settings.get<Record<string, unknown>>(draftKey(artifactId));
  if (!value || typeof value.revision !== "string" || typeof value.updatedAt !== "string") return null;
  const parsed = parseGraphicsDocument(value.document);
  return parsed.ok ? { revision: value.revision, updatedAt: value.updatedAt, document: parsed.document } : null;
}

export function writeGraphicsDraft(engine: Engine, artifactId: string, document: GraphicsDocument): GraphicsDraft {
  const parsed = parseGraphicsDocument(document);
  if (!parsed.ok) throw new Error(parsed.error);
  const draft: GraphicsDraft = { revision: randomUUID(), updatedAt: new Date().toISOString(), document: parsed.document };
  const written = engine.settings.set(draftKey(artifactId), draft);
  if (!written.ok) throw new Error(written.error.message);
  return draft;
}

export function deleteGraphicsDraft(engine: Engine, artifactId: string): void {
  const deleted = engine.settings.delete(draftKey(artifactId));
  if (!deleted.ok) throw new Error(deleted.error.message);
}
