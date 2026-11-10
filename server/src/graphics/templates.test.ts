import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { Engine } from "videobook-engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ManagedBook } from "../book-manager.js";
import { BookManager } from "../book-manager.js";
import { registerAllJobHandlers } from "../jobs/index.js";
import { queue, setEngineRoot } from "../queue.js";
import { videoGraphicsDef } from "../tools/video-graphics.js";
import { GraphicsServiceError } from "./errors.js";
import type { GraphicsDocument, GraphicsLayerInput, GraphicsTextLayer } from "./model.js";
import { graphicsDocumentFromLayers } from "./model.js";
import {
  copyGraphicsTemplates,
  deleteGraphicsTemplate,
  MAX_GRAPHICS_TEMPLATES,
  readGraphicsTemplates,
  renameGraphicsTemplate,
  saveGraphicsTemplate,
  setDefaultGraphicsTemplate,
} from "./templates.js";

const TEMPLATES_KEY = "graphics.templates.v1";
const THAI_TITLE = "ติดไฟแดงยังไงให้เท่ได้ขนาดนี้";

function brandLayers(logoId: string): GraphicsLayerInput[] {
  return [
    { kind: "scrim", edge: "bottom", height: 0.45 },
    { kind: "image", name: "Logo", artifactId: logoId, position: { anchor: "top-left", x: 0, y: 0, space: "safe" }, size: 0.18 },
    {
      kind: "text",
      name: "Title",
      position: { anchor: "bottom-left", x: 0, y: 1, space: "safe" },
      align: "left",
      items: [
        { slot: "headline", text: THAI_TITLE, size: 0.08, accent: "brush" },
        { slot: "secondary", text: "How can you look this cool?", size: 0.045 },
        { text: "Follow for more", size: 0.03 },
      ],
    },
    { kind: "qr", slot: "profile", url: "https://www.tiktok.com/@pomkondeena" },
  ];
}

function plainLayers(): GraphicsLayerInput[] {
  return [{ kind: "text", name: "Clean", items: [{ slot: "headline", text: "Typed", size: 0.07 }] }];
}

function titleItems(document: GraphicsDocument) {
  return document.layers.filter((layer): layer is GraphicsTextLayer => layer.kind === "text").flatMap((layer) => layer.items);
}

async function failure(promise: Promise<unknown>): Promise<GraphicsServiceError> {
  const error = await promise.then(() => null, (cause: unknown) => cause);
  expect(error).toBeInstanceOf(GraphicsServiceError);
  return error as GraphicsServiceError;
}

async function image(engine: Engine, label: string, color: string): Promise<string> {
  const created = await engine.artifacts.create("image", label);
  if (!created.ok) throw new Error(created.error.message);
  const bytes = await sharp({ create: { width: 40, height: 20, channels: 4, background: color } }).png().toBuffer();
  const written = await engine.files.write(created.value.artifactId, "original.png", bytes);
  if (!written.ok) throw new Error(written.error.message);
  const original = await engine.metadata.artifacts.write(created.value.artifactId, "original", { origin: "upload", width: 40, height: 20 });
  if (!original.ok) throw new Error(original.error.message);
  return created.value.artifactId;
}

async function pngHash(engine: Engine, artifactId: string): Promise<string | undefined> {
  const manifest = await engine.files.manifest(artifactId);
  if (!manifest.ok) throw new Error(manifest.error.message);
  return manifest.value.files.find((file) => file.name === "original.png")?.objectHash;
}

function imageCount(engine: Engine): number {
  return engine.artifacts.list().filter((artifact) => artifact.kind === "image").length;
}

function clearTemplates(engine: Engine): void {
  engine.settings.delete(TEMPLATES_KEY);
}

describe("graphics templates", () => {
  let books: BookManager;
  let source: ManagedBook;
  let target: ManagedBook;
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videobook-graphics-templates-"));
    books = new BookManager({ libraryDir: join(tempDir, "books"), objectPrefix: "test-objects", catalogBackupName: "backup" });
    await books.ready();
    const sourceCreated = await books.create("brand-source");
    const targetCreated = await books.create("daily-target");
    if (!sourceCreated.ok || !targetCreated.ok) throw new Error("Could not create test books");
    const sourceBook = books.get(sourceCreated.value.bookId);
    const targetBook = books.get(targetCreated.value.bookId);
    if (!sourceBook.ok || !targetBook.ok) throw new Error("Could not load test books");
    source = sourceBook.value;
    target = targetBook.value;
    registerAllJobHandlers(target.engine, books);
    await setEngineRoot(target.rootDir, target.engine);
  });

  afterAll(async () => {
    await queue.stop();
    await books?.close();
    if (tempDir) await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("saves a layout with its slot text emptied, keeps names unique, renames and deletes", async () => {
    const engine = target.engine;
    clearTemplates(engine);
    const logo = await image(engine, "logo", "#E11D48");
    const saved = await saveGraphicsTemplate(engine, { name: "  Brand   look ", document: graphicsDocumentFromLayers(brandLayers(logo)) });
    expect(saved).toMatchObject({ name: "Brand look", id: expect.stringMatching(/^[0-9a-f-]{36}$/u) });
    expect(titleItems(saved.document).map((item) => [item.slot, item.text])).toEqual([["headline", ""], ["secondary", ""], [null, "Follow for more"]]);
    expect(saved.document.layers.find((layer) => layer.kind === "qr")).toMatchObject({ slot: "profile", url: "" });
    expect(saved.document.layers.find((layer) => layer.kind === "image")).toMatchObject({ artifactId: logo, size: 0.18 });
    expect(readGraphicsTemplates(engine)).toEqual({ templates: [saved], defaultId: null, watermark: {} });
    expect(JSON.stringify(engine.settings.get(TEMPLATES_KEY))).not.toMatch(/objectHash/u);

    expect((await failure(saveGraphicsTemplate(engine, { name: "brand LOOK", document: saved.document }))).message).toMatch(/already exists/u);
    expect((await failure(saveGraphicsTemplate(engine, { name: "Lower third", document: saved.document }))).message).toMatch(/starter/u);
    expect((await failure(saveGraphicsTemplate(engine, { name: "   ", document: saved.document }))).message).toMatch(/needs a name/u);
    expect((await failure(saveGraphicsTemplate(engine, { name: "x".repeat(81), document: saved.document }))).message).toMatch(/80 characters/u);
    expect((await failure(saveGraphicsTemplate(engine, { templateId: "missing", document: saved.document }))).code).toBe("not_found");

    const over = await saveGraphicsTemplate(engine, { templateId: saved.id, document: graphicsDocumentFromLayers(plainLayers()) });
    expect(over).toMatchObject({ id: saved.id, name: "Brand look" });
    expect(titleItems(over.document).map((item) => item.text)).toEqual([""]);
    const second = await saveGraphicsTemplate(engine, { name: "Promo", document: saved.document });
    expect((await failure(renameGraphicsTemplate(engine, second.id, "BRAND LOOK"))).message).toMatch(/already exists/u);
    const renamed = await renameGraphicsTemplate(engine, second.id, "Promo night");
    expect(renamed).toMatchObject({ id: second.id, name: "Promo night", document: second.document });
    expect((await failure(renameGraphicsTemplate(engine, "missing", "Name"))).code).toBe("not_found");

    expect(await deleteGraphicsTemplate(engine, saved.id)).toMatchObject({ id: saved.id });
    expect(readGraphicsTemplates(engine).templates.map((template) => template.name)).toEqual(["Promo night"]);
    expect((await failure(deleteGraphicsTemplate(engine, saved.id))).code).toBe("not_found");
  });

  it("sets a saved template or a starter as the book default and forgets a deleted default", async () => {
    const engine = target.engine;
    clearTemplates(engine);
    const brand = await saveGraphicsTemplate(engine, { name: "Brand", document: graphicsDocumentFromLayers(plainLayers()) });
    expect(await setDefaultGraphicsTemplate(engine, brand.id)).toBe(brand.id);
    expect(readGraphicsTemplates(engine).defaultId).toBe(brand.id);
    expect(await setDefaultGraphicsTemplate(engine, "lower-third")).toBe("lower-third");
    expect(await setDefaultGraphicsTemplate(engine, "tiktok-title")).toBeNull();
    expect((await failure(setDefaultGraphicsTemplate(engine, "nope"))).code).toBe("not_found");
    expect(readGraphicsTemplates(engine).defaultId).toBeNull();

    await setDefaultGraphicsTemplate(engine, brand.id);
    const stored = engine.settings.get<Record<string, unknown>>(TEMPLATES_KEY);
    engine.settings.set(TEMPLATES_KEY, { ...stored, watermark: { tiktok: brand.id, x: "gone", mastodon: brand.id } });
    expect(readGraphicsTemplates(engine).watermark).toEqual({ tiktok: brand.id });
    await deleteGraphicsTemplate(engine, brand.id);
    expect(readGraphicsTemplates(engine)).toEqual({ templates: [], defaultId: null, watermark: {} });
  });

  it("skips stored entries that are not valid templates", () => {
    const engine = target.engine;
    const valid = { id: "a", name: "Kept", document: graphicsDocumentFromLayers(plainLayers()), updatedAt: "2026-11-10T00:00:00.000Z" };
    engine.settings.set(TEMPLATES_KEY, {
      templates: [{ id: 1 }, valid, { ...valid, name: "Duplicate id" }, { ...valid, id: "b", document: { version: 2 } }],
      defaultId: "b",
    });
    expect(readGraphicsTemplates(engine)).toEqual({ templates: [valid], defaultId: null, watermark: {} });
    clearTemplates(engine);
  });

  it(`holds at most ${MAX_GRAPHICS_TEMPLATES} templates in a book`, async () => {
    const engine = target.engine;
    clearTemplates(engine);
    const document = graphicsDocumentFromLayers(plainLayers());
    const saved = [];
    for (let index = 0; index < MAX_GRAPHICS_TEMPLATES; index += 1) saved.push(await saveGraphicsTemplate(engine, { name: `Look ${index + 1}`, document }));
    expect((await failure(saveGraphicsTemplate(engine, { name: "One more", document }))).message).toMatch(/at most 50 templates/u);
    expect(await saveGraphicsTemplate(engine, { templateId: saved[0].id, document })).toMatchObject({ id: saved[0].id });
    clearTemplates(engine);
  });

  it("copies templates from another book with the images they use, skipping names already taken", async () => {
    clearTemplates(source.engine);
    clearTemplates(target.engine);
    const logo = await image(source.engine, "brand logo", "#22C55E");
    const brand = await saveGraphicsTemplate(source.engine, { name: "Brand", document: graphicsDocumentFromLayers(brandLayers(logo)) });
    const clean = await saveGraphicsTemplate(source.engine, { name: "Clean", document: graphicsDocumentFromLayers(plainLayers()) });
    await setDefaultGraphicsTemplate(source.engine, brand.id);
    source.engine.settings.set(TEMPLATES_KEY, { ...source.engine.settings.get<Record<string, unknown>>(TEMPLATES_KEY), watermark: { tiktok: brand.id } });
    const local = await saveGraphicsTemplate(target.engine, { name: "clean", document: graphicsDocumentFromLayers([{ kind: "scrim" }]) });
    const imagesBefore = imageCount(target.engine);

    const copy = await copyGraphicsTemplates(target.engine, { books, fromBook: "brand-source" });
    expect(copy).toMatchObject({ fromBookId: source.bookId, fromBookName: "brand-source", missingImages: [] });
    expect(copy.copied).toEqual([{ id: expect.any(String), name: "Brand", sourceId: brand.id }]);
    expect(copy.skipped).toEqual([{ id: clean.id, name: "Clean", reason: "name_taken" }]);
    expect(copy.images).toEqual([{ sourceId: logo, assetId: expect.any(String) }]);
    const copiedLogo = copy.images[0].assetId;
    expect(copiedLogo).not.toBe(logo);
    expect(target.engine.artifacts.get(copiedLogo)).toMatchObject({ ok: true, value: { kind: "image", label: "brand logo" } });
    expect(await pngHash(target.engine, copiedLogo)).toBe(await pngHash(source.engine, logo));
    expect(imageCount(target.engine)).toBe(imagesBefore + 1);

    const store = readGraphicsTemplates(target.engine);
    const copied = store.templates.find((template) => template.id === copy.copied[0].id);
    expect(store.templates.map((template) => template.name)).toEqual(["clean", "Brand"]);
    expect(copied?.document.layers.find((layer) => layer.kind === "image")).toMatchObject({ artifactId: copiedLogo });
    expect(copied?.document.layers.map((layer) => layer.name)).toEqual(brand.document.layers.map((layer) => layer.name));
    expect(store.defaultId).toBe(copied?.id);
    expect(store.watermark).toEqual({ tiktok: copied?.id });
    expect(store.templates[0]).toEqual(local);

    const again = await copyGraphicsTemplates(target.engine, { books, fromBook: source.bookId });
    expect(again.copied).toEqual([]);
    expect(again.skipped.map((skipped) => skipped.name)).toEqual(["Brand", "Clean"]);
    expect(imageCount(target.engine)).toBe(imagesBefore + 1);
  });

  it("keeps a layer whose image is gone in the source and reports it missing, and refuses a copy it cannot do", async () => {
    clearTemplates(source.engine);
    clearTemplates(target.engine);
    const logo = await image(source.engine, "old logo", "#3B82F6");
    const old = await saveGraphicsTemplate(source.engine, { name: "Old brand", document: graphicsDocumentFromLayers(brandLayers(logo)) });
    const kept = await saveGraphicsTemplate(source.engine, { name: "Kept", document: graphicsDocumentFromLayers(plainLayers()) });
    const deleted = await source.engine.artifacts.delete(logo, { deleteOwnedMedia: true });
    expect(deleted.ok).toBe(true);
    const imagesBefore = imageCount(target.engine);

    const copy = await copyGraphicsTemplates(target.engine, { books, fromBook: source.bookId, templateIds: [old.id] });
    expect(copy).toMatchObject({ images: [], missingImages: [logo], skipped: [] });
    expect(copy.copied.map((template) => template.name)).toEqual(["Old brand"]);
    const copied = readGraphicsTemplates(target.engine).templates[0];
    expect(copied.document.layers.find((layer) => layer.kind === "image")).toMatchObject({ artifactId: logo });
    expect(imageCount(target.engine)).toBe(imagesBefore);

    expect(await failure(copyGraphicsTemplates(target.engine, { books, fromBook: target.bookId }))).toMatchObject({ code: "invalid", message: expect.stringMatching(/already in this book/u) });
    expect((await failure(copyGraphicsTemplates(target.engine, { books, fromBook: "no-such-book" }))).code).toBe("not_found");
    expect(await failure(copyGraphicsTemplates(target.engine, { books, fromBook: source.bookId, templateIds: ["missing"] }))).toMatchObject({ code: "not_found", details: { template_id: "missing" } });

    const document = graphicsDocumentFromLayers(plainLayers());
    for (let index = readGraphicsTemplates(target.engine).templates.length; index < MAX_GRAPHICS_TEMPLATES; index += 1) {
      await saveGraphicsTemplate(target.engine, { name: `Filler ${index}`, document });
    }
    expect((await failure(copyGraphicsTemplates(target.engine, { books, fromBook: source.bookId, templateIds: [kept.id] }))).message).toMatch(/at most 50/u);
    clearTemplates(target.engine);
  });

  it("answers copy_templates through video_graphics without a video", async () => {
    clearTemplates(source.engine);
    clearTemplates(target.engine);
    const promo = await saveGraphicsTemplate(source.engine, { name: "Promo", document: graphicsDocumentFromLayers(plainLayers()) });
    const tool = videoGraphicsDef(target.engine, books);
    const result = await tool.handler({ book_id: target.bookId, op: "copy_templates", from_book: "brand-source" });
    expect(result.isError, result.content[0].text).toBeFalsy();
    const body = JSON.parse(result.content[0].text) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: "copied",
      from_book_id: source.bookId,
      from_book_name: "brand-source",
      copied: [{ name: "Promo", source_id: promo.id }],
      skipped: [],
      images: [],
      missing_images: [],
      templates: [{ name: "Promo" }],
      default_template_id: "tiktok-title",
    });
    const missing = await videoGraphicsDef(target.engine).handler({ book_id: target.bookId, op: "copy_templates", from_book: "brand-source" });
    expect(missing.isError).toBe(true);
    expect(JSON.parse(missing.content[0].text)).toMatchObject({ status: "invalid", message: expect.stringMatching(/book library/u) });
    clearTemplates(target.engine);
  });
});
