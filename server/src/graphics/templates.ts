import { randomUUID } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import type { Engine } from "videobook-engine";
import { findPrimaryMediaFile } from "videobook-engine";
import type { BookManager, ManagedBook } from "../book-manager.js";
import { resolveBookReference } from "../media-library.js";
import { withNotebookMutation } from "../notebook-mutations.js";
import { queue } from "../queue.js";
import type { WatermarkPlatform } from "../watermark-platform.js";
import { WATERMARK_PLATFORM_LABELS, WATERMARK_PLATFORMS } from "../watermark-platform.js";
import { GraphicsServiceError } from "./errors.js";
import type { GraphicsDocument } from "./model.js";
import { MAX_GRAPHICS_NAME_LENGTH, parseGraphicsDocument } from "./model.js";
import { clearGraphicsSlots } from "./slots.js";
import { DEFAULT_GRAPHICS_STARTER_ID, GRAPHICS_STARTERS } from "./starters.js";

const TEMPLATES_KEY = "graphics.templates.v1";
export const MAX_GRAPHICS_TEMPLATES = 50;
const COPY_TIMEOUT_MS = 15 * 60_000;

export type GraphicsTemplate = { id: string; name: string; document: GraphicsDocument; updatedAt: string };
type GraphicsTemplateWatermarks = Partial<Record<WatermarkPlatform, string>>;

export type GraphicsTemplateStore = {
  templates: GraphicsTemplate[];
  defaultId: string | null;
  watermark: GraphicsTemplateWatermarks;
};

type CopiedTemplate = { id: string; name: string; sourceId: string };
type SkippedTemplate = { id: string; name: string; reason: "name_taken" };
type CopiedImage = { sourceId: string; assetId: string };

export type GraphicsTemplateCopy = {
  fromBookId: string;
  fromBookName: string;
  copied: CopiedTemplate[];
  skipped: SkippedTemplate[];
  images: CopiedImage[];
  missingImages: string[];
};

type CopyTemplatesInput = { books: BookManager; fromBook: string; templateIds?: readonly string[] };
type SaveTemplateInput = { name?: string; templateId?: string; document: GraphicsDocument };
type SaveWatermarkInput = { name?: string; document: GraphicsDocument };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function storedTemplate(value: unknown): GraphicsTemplate | null {
  const entry = record(value);
  if (!entry || typeof entry.id !== "string" || typeof entry.name !== "string" || typeof entry.updatedAt !== "string") return null;
  const parsed = parseGraphicsDocument(entry.document);
  return parsed.ok ? { id: entry.id, name: entry.name, document: parsed.document, updatedAt: entry.updatedAt } : null;
}

function uniqueTemplates(values: unknown): GraphicsTemplate[] {
  const templates = (Array.isArray(values) ? values : []).flatMap((value) => storedTemplate(value) ?? []);
  return templates.filter((template, index) => templates.findIndex((other) => other.id === template.id) === index);
}

function isStarterId(id: string): boolean {
  return GRAPHICS_STARTERS.some((starter) => starter.id === id);
}

function storedWatermarks(value: unknown, ids: ReadonlySet<string>): GraphicsTemplateWatermarks {
  const entries = record(value) ?? {};
  return Object.fromEntries(WATERMARK_PLATFORMS.flatMap((platform) => {
    const id = entries[platform];
    return typeof id === "string" && ids.has(id) ? [[platform, id]] : [];
  }));
}

export function readGraphicsTemplates(engine: Engine): GraphicsTemplateStore {
  const stored = record(engine.settings.get<unknown>(TEMPLATES_KEY)) ?? {};
  const templates = uniqueTemplates(stored.templates);
  const ids = new Set(templates.map((template) => template.id));
  const defaultId = typeof stored.defaultId === "string" && (ids.has(stored.defaultId) || isStarterId(stored.defaultId))
    ? stored.defaultId
    : null;
  return { templates, defaultId, watermark: storedWatermarks(stored.watermark, ids) };
}

function writeTemplates(engine: Engine, store: GraphicsTemplateStore): void {
  const written = engine.settings.set(TEMPLATES_KEY, store);
  if (!written.ok) throw new Error(written.error.message);
}

function withTemplates<T>(engine: Engine, change: () => Promise<T>): Promise<T> {
  return withNotebookMutation(`graphics-templates:${engine.book.get().bookId}`, change);
}

function sameName(left: string, right: string): boolean {
  return left.toLocaleLowerCase() === right.toLocaleLowerCase();
}

function templateName(value: string | undefined): string {
  const name = typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
  if (!name) throw new GraphicsServiceError("invalid", "A template needs a name.");
  if (name.length > MAX_GRAPHICS_NAME_LENGTH) {
    throw new GraphicsServiceError("invalid", `Template names are limited to ${MAX_GRAPHICS_NAME_LENGTH} characters.`);
  }
  return name;
}

function nameTaken(store: GraphicsTemplateStore, name: string, exceptId: string | null): string | null {
  const starter = GRAPHICS_STARTERS.find((candidate) => sameName(candidate.name, name));
  if (starter) return `${starter.name} is the name of a starter. Choose another name.`;
  const template = store.templates.find((candidate) => candidate.id !== exceptId && sameName(candidate.name, name));
  return template ? `A template named ${template.name} already exists. Choose another name, or save over it.` : null;
}

function requireFreeName(store: GraphicsTemplateStore, name: string, exceptId: string | null): void {
  const taken = nameTaken(store, name, exceptId);
  if (taken) throw new GraphicsServiceError("invalid", taken);
}

function requireTemplate(store: GraphicsTemplateStore, templateId: string): GraphicsTemplate {
  const template = store.templates.find((candidate) => candidate.id === templateId);
  if (!template) throw new GraphicsServiceError("not_found", `Template ${templateId} is not saved in this book.`, { template_id: templateId });
  return template;
}

function requireRoom(count: number): void {
  if (count > MAX_GRAPHICS_TEMPLATES) {
    throw new GraphicsServiceError("invalid", `A book holds at most ${MAX_GRAPHICS_TEMPLATES} templates. Delete one first.`);
  }
}

function templateDocument(document: GraphicsDocument): GraphicsDocument {
  const parsed = parseGraphicsDocument(clearGraphicsSlots(document));
  if (!parsed.ok) throw new GraphicsServiceError("invalid", parsed.error, { issues: parsed.issues });
  return parsed.document;
}

function replaced(store: GraphicsTemplateStore, template: GraphicsTemplate): GraphicsTemplate[] {
  return store.templates.map((candidate) => (candidate.id === template.id ? template : candidate));
}

export function graphicsTemplateImageIds(document: GraphicsDocument): string[] {
  return [...new Set(document.layers.flatMap((layer) => (layer.kind === "image" ? [layer.artifactId] : [])))];
}

export async function saveGraphicsTemplate(engine: Engine, input: SaveTemplateInput): Promise<GraphicsTemplate> {
  return withTemplates(engine, async () => {
    const store = readGraphicsTemplates(engine);
    const existing = input.templateId === undefined ? null : requireTemplate(store, input.templateId);
    const name = input.name === undefined && existing ? existing.name : templateName(input.name);
    requireFreeName(store, name, existing?.id ?? null);
    if (!existing) requireRoom(store.templates.length + 1);
    const template = { id: existing?.id ?? randomUUID(), name, document: templateDocument(input.document), updatedAt: new Date().toISOString() };
    writeTemplates(engine, { ...store, templates: existing ? replaced(store, template) : [...store.templates, template] });
    return template;
  });
}

export async function renameGraphicsTemplate(engine: Engine, templateId: string, name: string | undefined): Promise<GraphicsTemplate> {
  return withTemplates(engine, async () => {
    const store = readGraphicsTemplates(engine);
    const existing = requireTemplate(store, templateId);
    const nextName = templateName(name);
    requireFreeName(store, nextName, existing.id);
    const template = { ...existing, name: nextName, updatedAt: new Date().toISOString() };
    writeTemplates(engine, { ...store, templates: replaced(store, template) });
    return template;
  });
}

function withoutTemplate(watermark: GraphicsTemplateWatermarks, templateId: string): GraphicsTemplateWatermarks {
  return Object.fromEntries(Object.entries(watermark).filter(([, id]) => id !== templateId));
}

export async function deleteGraphicsTemplate(engine: Engine, templateId: string): Promise<GraphicsTemplate> {
  return withTemplates(engine, async () => {
    const store = readGraphicsTemplates(engine);
    const existing = requireTemplate(store, templateId);
    writeTemplates(engine, {
      templates: store.templates.filter((template) => template.id !== templateId),
      defaultId: store.defaultId === templateId ? null : store.defaultId,
      watermark: withoutTemplate(store.watermark, templateId),
    });
    return existing;
  });
}

export async function setDefaultGraphicsTemplate(engine: Engine, templateId: string | null): Promise<string | null> {
  return withTemplates(engine, async () => {
    const store = readGraphicsTemplates(engine);
    const defaultId = templateId === null || templateId === DEFAULT_GRAPHICS_STARTER_ID ? null : templateId;
    if (defaultId !== null && !isStarterId(defaultId)) requireTemplate(store, defaultId);
    writeTemplates(engine, { ...store, defaultId });
    return defaultId;
  });
}

export function watermarkGraphicsTemplate(engine: Engine, platform: WatermarkPlatform): GraphicsTemplate | null {
  const store = readGraphicsTemplates(engine);
  const id = store.watermark[platform];
  return id ? store.templates.find((template) => template.id === id) ?? null : null;
}

export async function setWatermarkGraphicsTemplate(engine: Engine, platform: WatermarkPlatform, templateId: string | null): Promise<string | null> {
  return withTemplates(engine, async () => {
    const store = readGraphicsTemplates(engine);
    if (templateId !== null) requireTemplate(store, templateId);
    const watermark = Object.fromEntries(Object.entries(store.watermark).filter(([key]) => key !== platform));
    writeTemplates(engine, { ...store, watermark: templateId === null ? watermark : { ...watermark, [platform]: templateId } });
    return templateId;
  });
}

function watermarkTemplateName(platform: WatermarkPlatform): string {
  return `${WATERMARK_PLATFORM_LABELS[platform]} watermark`;
}

function watermarkTarget(store: GraphicsTemplateStore, platform: WatermarkPlatform, name: string | undefined): GraphicsTemplate | null {
  const current = store.templates.find((template) => template.id === store.watermark[platform]);
  if (current || name !== undefined) return current ?? null;
  return store.templates.find((template) => sameName(template.name, watermarkTemplateName(platform))) ?? null;
}

export async function saveWatermarkGraphicsTemplate(engine: Engine, platform: WatermarkPlatform, input: SaveWatermarkInput): Promise<GraphicsTemplate> {
  return withTemplates(engine, async () => {
    const store = readGraphicsTemplates(engine);
    const existing = watermarkTarget(store, platform, input.name);
    const name = input.name === undefined ? existing?.name ?? watermarkTemplateName(platform) : templateName(input.name);
    requireFreeName(store, name, existing?.id ?? null);
    if (!existing) requireRoom(store.templates.length + 1);
    const template = { id: existing?.id ?? randomUUID(), name, document: templateDocument(input.document), updatedAt: new Date().toISOString() };
    writeTemplates(engine, {
      ...store,
      templates: existing ? replaced(store, template) : [...store.templates, template],
      watermark: { ...store.watermark, [platform]: template.id },
    });
    return template;
  });
}

async function sourceBook(books: BookManager, reference: string, targetBookId: string): Promise<ManagedBook> {
  const book = await resolveBookReference(books, reference).catch(() => null);
  if (!book) throw new GraphicsServiceError("not_found", `Book ${reference} was not found.`);
  if (book.bookId === targetBookId) {
    throw new GraphicsServiceError("invalid", "These templates are already in this book. Choose another book to copy from.");
  }
  return book;
}

function chosenTemplates(store: GraphicsTemplateStore, templateIds: readonly string[] | undefined, bookName: string): GraphicsTemplate[] {
  if (templateIds === undefined) return store.templates;
  return [...new Set(templateIds)].map((id) => {
    const template = store.templates.find((candidate) => candidate.id === id);
    if (!template) throw new GraphicsServiceError("not_found", `Template ${id} is not saved in ${bookName}.`, { template_id: id });
    return template;
  });
}

function splitByName(store: GraphicsTemplateStore, chosen: readonly GraphicsTemplate[]): { fresh: GraphicsTemplate[]; skipped: SkippedTemplate[] } {
  return chosen.reduce<{ fresh: GraphicsTemplate[]; skipped: SkippedTemplate[] }>((split, template) => {
    const taken = nameTaken({ ...store, templates: [...store.templates, ...split.fresh] }, template.name, null);
    return taken
      ? { ...split, skipped: [...split.skipped, { id: template.id, name: template.name, reason: "name_taken" }] }
      : { ...split, fresh: [...split.fresh, template] };
  }, { fresh: [], skipped: [] });
}

async function hasImageFile(engine: Engine, artifactId: string): Promise<boolean> {
  const artifact = engine.artifacts.get(artifactId);
  if (!artifact.ok || artifact.value.kind !== "image") return false;
  const manifest = await engine.files.manifest(artifactId);
  return manifest.ok && findPrimaryMediaFile(manifest.value.files, "image") !== null;
}

async function copyImage(source: ManagedBook, sourceId: string, targetBookId: string): Promise<string> {
  const copied = await queue.enqueueAndWait<{ targetArtifactId: string }>(
    `copy-library-asset-${uuidv7()}`,
    { type: "copy_library_asset", bookId: targetBookId, sourceBookId: source.bookId, sourceArtifactId: sourceId, targetBookId },
    COPY_TIMEOUT_MS,
  );
  return copied.targetArtifactId;
}

async function copyImages(source: ManagedBook, imageIds: readonly string[], targetBookId: string): Promise<{ images: CopiedImage[]; missing: string[] }> {
  const images: CopiedImage[] = [];
  const missing: string[] = [];
  for (const sourceId of imageIds) {
    if (await hasImageFile(source.engine, sourceId)) images.push({ sourceId, assetId: await copyImage(source, sourceId, targetBookId) });
    else missing.push(sourceId);
  }
  return { images, missing };
}

function remapImages(document: GraphicsDocument, images: readonly CopiedImage[]): GraphicsDocument {
  const ids = new Map(images.map((image) => [image.sourceId, image.assetId]));
  return {
    ...document,
    layers: document.layers.map((layer) => (layer.kind === "image" ? { ...layer, artifactId: ids.get(layer.artifactId) ?? layer.artifactId } : layer)),
  };
}

function carried(sourceId: string | null | undefined, copies: ReadonlyMap<string, string>): string | null {
  return sourceId ? copies.get(sourceId) ?? null : null;
}

function carriedWatermarks(source: GraphicsTemplateWatermarks, copies: ReadonlyMap<string, string>): GraphicsTemplateWatermarks {
  return Object.fromEntries(Object.entries(source).flatMap(([platform, id]) => {
    const copy = carried(id, copies);
    return copy ? [[platform, copy]] : [];
  }));
}

export async function copyGraphicsTemplates(engine: Engine, input: CopyTemplatesInput): Promise<GraphicsTemplateCopy> {
  const targetBookId = engine.book.get().bookId;
  const source = await sourceBook(input.books, input.fromBook, targetBookId);
  const sourceStore = readGraphicsTemplates(source.engine);
  const chosen = chosenTemplates(sourceStore, input.templateIds, source.name);
  return withTemplates(engine, async () => {
    const store = readGraphicsTemplates(engine);
    const { fresh, skipped } = splitByName(store, chosen);
    requireRoom(store.templates.length + fresh.length);
    const { images, missing } = await copyImages(source, [...new Set(fresh.flatMap((template) => graphicsTemplateImageIds(template.document)))], targetBookId);
    const updatedAt = new Date().toISOString();
    const copies = fresh.map((template) => ({
      sourceId: template.id,
      template: { id: randomUUID(), name: template.name, document: remapImages(template.document, images), updatedAt },
    }));
    const bySource = new Map(copies.map((copy) => [copy.sourceId, copy.template.id]));
    writeTemplates(engine, {
      templates: [...store.templates, ...copies.map((copy) => copy.template)],
      defaultId: store.defaultId ?? carried(sourceStore.defaultId, bySource),
      watermark: { ...carriedWatermarks(sourceStore.watermark, bySource), ...store.watermark },
    });
    return {
      fromBookId: source.bookId,
      fromBookName: source.name,
      copied: copies.map((copy) => ({ id: copy.template.id, name: copy.template.name, sourceId: copy.sourceId })),
      skipped,
      images,
      missingImages: missing,
    };
  });
}
