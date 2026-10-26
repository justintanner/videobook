import { randomUUID } from "node:crypto";
import type { Engine } from "videobook-engine";
import type { CaptionDocument } from "./model.js";
import { captionDocumentSchema } from "./model.js";

export interface CaptionDraft {
  revision: string;
  updatedAt: string;
  document: CaptionDocument;
}

function draftKey(artifactId: string, language: string): string {
  return `captions.draft.${artifactId}.${language}`;
}

function draftIndexKey(artifactId: string): string {
  return `captions.drafts.${artifactId}`;
}

function draftLanguages(engine: Engine, artifactId: string): string[] {
  const value = engine.settings.get<unknown>(draftIndexKey(artifactId));
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function readCaptionDraft(engine: Engine, artifactId: string, language: string): CaptionDraft | null {
  const value = engine.settings.get<Record<string, unknown>>(draftKey(artifactId, language));
  if (!value || typeof value.revision !== "string" || typeof value.updatedAt !== "string") return null;
  const parsed = captionDocumentSchema.safeParse(value.document);
  return parsed.success ? { revision: value.revision, updatedAt: value.updatedAt, document: parsed.data } : null;
}

export function writeCaptionDraft(engine: Engine, artifactId: string, language: string, document: CaptionDocument): CaptionDraft {
  const draft: CaptionDraft = { revision: randomUUID(), updatedAt: new Date().toISOString(), document: captionDocumentSchema.parse(document) };
  const written = engine.settings.set(draftKey(artifactId, language), draft);
  if (!written.ok) throw new Error(written.error.message);
  const languages = draftLanguages(engine, artifactId);
  if (!languages.includes(language)) {
    const indexed = engine.settings.set(draftIndexKey(artifactId), [...languages, language]);
    if (!indexed.ok) throw new Error(indexed.error.message);
  }
  return draft;
}

export function deleteCaptionDraft(engine: Engine, artifactId: string, language: string): void {
  engine.settings.delete(draftKey(artifactId, language));
  const remaining = draftLanguages(engine, artifactId).filter((item) => item !== language);
  if (remaining.length > 0) engine.settings.set(draftIndexKey(artifactId), remaining);
  else engine.settings.delete(draftIndexKey(artifactId));
}

export function deleteCaptionDrafts(engine: Engine, artifactId: string): void {
  for (const language of draftLanguages(engine, artifactId)) engine.settings.delete(draftKey(artifactId, language));
  engine.settings.delete(draftIndexKey(artifactId));
}
