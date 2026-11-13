import { randomUUID } from "node:crypto";
import type { Engine } from "videobook-engine";
import type { GraphicsDocument } from "./model.js";
import { parseGraphicsDocument } from "./model.js";

import { graphicsFrameSchema, ORIGINAL_GRAPHICS_FRAME, type GraphicsFraming } from "./frame.js";

export type GraphicsDraft = { revision: string; updatedAt: string; document: GraphicsDocument; frame: GraphicsFraming };

function draftKey(artifactId: string): string {
  return `graphics.draft.${artifactId}`;
}

export function readGraphicsDraft(engine: Engine, artifactId: string): GraphicsDraft | null {
  const value = engine.settings.get<Record<string, unknown>>(draftKey(artifactId));
  if (!value || typeof value.revision !== "string" || typeof value.updatedAt !== "string") return null;
  const parsed = parseGraphicsDocument(value.document);
  return parsed.ok ? { revision: value.revision, updatedAt: value.updatedAt, document: parsed.document, frame: graphicsFrameSchema.parse(value.frame ?? ORIGINAL_GRAPHICS_FRAME) } : null;
}

export function writeGraphicsDraft(engine: Engine, artifactId: string, document: GraphicsDocument, frame: GraphicsFraming = readGraphicsDraft(engine, artifactId)?.frame ?? ORIGINAL_GRAPHICS_FRAME): GraphicsDraft {
  const parsed = parseGraphicsDocument(document);
  if (!parsed.ok) throw new Error(parsed.error);
  const draft: GraphicsDraft = { revision: randomUUID(), updatedAt: new Date().toISOString(), document: parsed.document, frame: graphicsFrameSchema.parse(frame) };
  const written = engine.settings.set(draftKey(artifactId), draft);
  if (!written.ok) throw new Error(written.error.message);
  return draft;
}

export function deleteGraphicsDraft(engine: Engine, artifactId: string): void {
  const deleted = engine.settings.delete(draftKey(artifactId));
  if (!deleted.ok) throw new Error(deleted.error.message);
}
