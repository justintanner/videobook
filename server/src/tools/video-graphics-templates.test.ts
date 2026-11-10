import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Client } from "@modelcontextprotocol/client";
import sharp from "sharp";
import type { Engine } from "videobook-engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEngineForTest } from "../engine.js";
import { FFMPEG, probeVideo } from "../ffmpeg.js";
import type { GraphicsDocument, GraphicsLayer, GraphicsTextLayer } from "../graphics/model.js";
import { registerMediaProbe } from "../notebook-media-ops.js";
import { toolSpendsMoney } from "../paid-tools.js";
import { createTestClient } from "../test-client.js";

const execFileAsync = promisify(execFile);
const THAI_TITLE = "ติดไฟแดงยังไงให้เท่ได้ขนาดนี้";
const ENGLISH_LINE = "How can you look this cool?";
const TIKTOK_SOURCE = {
  origin: "download",
  source_url: "https://www.tiktok.com/@pomkondeena/video/7432100000000000000",
  webpage_url: "https://www.tiktok.com/@pomkondeena/video/7432100000000000000",
  platform: "TikTok",
  uploader: "pomkondeena",
};

type TextContent = Array<{ type: string; text: string }>;
type SavedTemplate = { id: string; name: string; updated_at: string; document: GraphicsDocument; missing_layer_ids: string[] };
type Read = {
  saved: boolean;
  revision: string;
  document: GraphicsDocument;
  templates: SavedTemplate[];
  default_template_id: string;
  starters: Array<{ id: string; document: GraphicsDocument }>;
  images: Record<string, { url: string | null }>;
  source: { source_hash: string };
};
type Saved = { revision: string; document: GraphicsDocument };
type TemplateList = { templates: Array<{ id: string; name: string; updated_at: string }>; default_template_id: string };
type TemplateResult = TemplateList & { status: string; template: { id: string; name: string; updated_at: string } };
type Failure = { status: string; message: string; revision?: string; layer_id?: string; template_id?: string };

function textLayers(document: GraphicsDocument): GraphicsTextLayer[] {
  return document.layers.filter((layer): layer is GraphicsTextLayer => layer.kind === "text");
}

function slotText(document: GraphicsDocument, slot: string): string | undefined {
  return textLayers(document).flatMap((layer) => layer.items).find((item) => item.slot === slot)?.text;
}

function layout(document: GraphicsDocument): unknown[] {
  return document.layers.map((layer: GraphicsLayer) => {
    const { id: _id, ...rest } = layer;
    return layer.kind === "text" ? { ...rest, items: layer.items.map(({ id: _item, text: _text, ...item }) => item) } : rest;
  });
}

describe("video_graphics templates", () => {
  let client: Client;
  let engine: Engine;
  let tempDir: string;
  let clips = 0;
  const bookId = "video-graphics-templates-book";

  async function video(original?: Record<string, unknown>): Promise<string> {
    clips += 1;
    const path = join(tempDir, `clip-${clips}.mp4`);
    await execFileAsync(FFMPEG, ["-y", "-f", "lavfi", "-i", "color=c=gray:s=360x640:r=24:d=2", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-an", path]);
    const created = await engine.artifacts.create("video", `clip ${clips}`);
    if (!created.ok) throw new Error(created.error.message);
    const artifactId = created.value.artifactId;
    const written = await engine.files.write(artifactId, "original.mp4", await readFile(path));
    if (!written.ok) throw new Error(written.error.message);
    const manifest = await engine.files.manifest(artifactId);
    if (!manifest.ok) throw new Error(manifest.error.message);
    await registerMediaProbe(engine, artifactId, "original.mp4", await probeVideo(join(manifest.value.path, "original.mp4")));
    if (original) {
      const written = await engine.metadata.artifacts.write(artifactId, "original", original);
      if (!written.ok) throw new Error(written.error.message);
    }
    return artifactId;
  }

  async function image(): Promise<string> {
    const created = await engine.artifacts.create("image", "logo");
    if (!created.ok) throw new Error(created.error.message);
    const bytes = await sharp({ create: { width: 40, height: 20, channels: 4, background: "#E11D48" } }).png().toBuffer();
    const written = await engine.files.write(created.value.artifactId, "original.png", bytes);
    if (!written.ok) throw new Error(written.error.message);
    await engine.metadata.artifacts.write(created.value.artifactId, "original", { origin: "upload", width: 40, height: 20 });
    return created.value.artifactId;
  }

  async function call(args: Record<string, unknown>): Promise<{ error: boolean; body: unknown; text: string }> {
    const result = await client.callTool({ name: "video_graphics", arguments: { book_id: bookId, ...args } });
    const text = (result.content as TextContent)[0].text;
    return { error: result.isError === true, body: JSON.parse(text) as unknown, text };
  }

  async function ok<T>(args: Record<string, unknown>): Promise<T> {
    const result = await call(args);
    if (result.error) throw new Error(result.text);
    return result.body as T;
  }

  async function fails(args: Record<string, unknown>): Promise<Failure> {
    const result = await call(args);
    expect(result.error, result.text).toBe(true);
    return result.body as Failure;
  }

  const read = (assetId: string) => ok<Read>({ asset_id: assetId });
  const update = (assetId: string, args: Record<string, unknown>) => ok<Saved>({ asset_id: assetId, op: "update", ...args });
  const template = (args: Record<string, unknown>) => ok<TemplateResult>(args);

  async function clearTemplates(): Promise<void> {
    const listed = await ok<TemplateList>({ op: "set_default_template", template_id: null });
    for (const saved of listed.templates) await template({ op: "delete_template", template_id: saved.id });
  }

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videobook-video-graphics-templates-"));
    client = await createTestClient(tempDir);
    engine = createEngineForTest(tempDir);
    await client.callTool({ name: "create_project", arguments: { book_id: bookId } });
  });

  afterAll(async () => {
    await client?.close();
    if (tempDir) await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("saves a layout as a template that applies to another video and keeps that video's typed text by slot", async () => {
    await clearTemplates();
    const first = await video();
    const fresh = await read(first);
    expect(fresh).toMatchObject({ templates: [], default_template_id: "tiktok-title" });
    const title = textLayers(fresh.document).find((layer) => layer.items.some((item) => item.slot === "headline"));
    if (!title) throw new Error("expected the title block");
    const designed = await update(first, {
      expected_revision: fresh.revision,
      edits: [
        { op: "set_slot_text", slot: "headline", text: THAI_TITLE },
        { op: "set_slot_text", slot: "secondary", text: ENGLISH_LINE },
        { op: "set_position", layer_id: title.id, position: { anchor: "top-left", x: 0, y: 0 } },
        { op: "add_layer", layer: { kind: "text", name: "Follow", items: [{ text: "Follow for more", size: 0.03 }] } },
      ],
    });
    const saved = await template({ asset_id: first, op: "save_template", name: "Brand look", expected_revision: designed.revision });
    expect(saved).toMatchObject({ status: "saved", template: { name: "Brand look" }, default_template_id: "tiktok-title" });
    expect(saved.templates).toEqual([saved.template]);
    expect((await read(first)).revision).toBe(designed.revision);

    const second = await video();
    const other = await read(second);
    const listed = other.templates.find((candidate) => candidate.id === saved.template.id);
    if (!listed) throw new Error("expected the saved template in get");
    expect(listed).toMatchObject({ name: "Brand look", missing_layer_ids: [] });
    expect(slotText(listed.document, "headline")).toBe("");
    expect(slotText(listed.document, "secondary")).toBe("");
    expect(slotText(listed.document, "handle")).toBe("jtbkk");
    expect(textLayers(listed.document).at(-1)?.items[0].text).toBe("Follow for more");

    const typed = await update(second, { expected_revision: other.revision, edits: [{ op: "set_slot_text", slot: "headline", text: "Typed on the second video" }] });
    const applied = await update(second, { expected_revision: typed.revision, edits: [{ op: "apply_template", template: listed.document }] });
    expect(slotText(applied.document, "headline")).toBe("Typed on the second video");
    expect(slotText(applied.document, "secondary")).toBe("");
    expect(layout(applied.document)).toEqual(layout(listed.document));
    expect(textLayers(applied.document).find((layer) => layer.items.some((item) => item.slot === "headline"))?.position)
      .toEqual({ anchor: "top-left", x: 0, y: 0, space: "safe" });

    expect(await fails({ asset_id: first, op: "save_template", name: "brand look", expected_revision: designed.revision })).toMatchObject({ status: "invalid", message: expect.stringMatching(/already exists/u) });
    expect(await fails({ asset_id: first, op: "save_template", name: "Late", expected_revision: other.revision })).toMatchObject({ status: "conflict", revision: designed.revision });
    expect(await fails({ op: "save_template", name: "No video" })).toMatchObject({ status: "invalid", message: expect.stringMatching(/asset_id/u) });
    const over = await template({ asset_id: second, op: "save_template", template_id: saved.template.id });
    expect(over).toMatchObject({ template: { id: saved.template.id, name: "Brand look" } });
  });

  it("starts a video without graphics from the book's default template with its known slots filled", async () => {
    await clearTemplates();
    const designer = await video();
    const fresh = await read(designer);
    const lowerThird = fresh.starters.find((starter) => starter.id === "lower-third")?.document;
    const applied = await update(designer, { expected_revision: fresh.revision, edits: [{ op: "apply_template", template: lowerThird }] });
    const saved = await template({ asset_id: designer, op: "save_template", name: "Credit look", expected_revision: applied.revision });

    const downloaded = await video(TIKTOK_SOURCE);
    const before = await read(downloaded);
    expect(before.document.layers.map((layer) => layer.kind)).toEqual(["scrim", "text", "text"]);
    const defaulted = await template({ op: "set_default_template", template_id: saved.template.id });
    expect(defaulted).toMatchObject({ status: "saved", default_template_id: saved.template.id });

    const after = await read(downloaded);
    expect(after).toMatchObject({ saved: false, default_template_id: saved.template.id });
    expect(after.revision).toMatch(/^default:[0-9a-f]{32}$/u);
    expect(after.revision).not.toBe(before.revision);
    const listed = (await read(designer)).templates.find((candidate) => candidate.id === saved.template.id);
    expect(listed && layout(after.document)).toEqual(listed && layout(listed.document));
    expect(slotText(after.document, "credit")).toBe("TikTok/@pomkondeena");
    expect(slotText(after.document, "headline")).toBe("");
    expect(engine.settings.get(`graphics.draft.${downloaded}`)).toBeNull();
    expect(await fails({ asset_id: downloaded, op: "update", expected_revision: before.revision, edits: [] })).toMatchObject({ status: "conflict", revision: after.revision });
    const edited = await update(downloaded, { expected_revision: after.revision, edits: [{ op: "set_slot_text", slot: "headline", text: THAI_TITLE }] });
    expect(slotText(edited.document, "credit")).toBe("TikTok/@pomkondeena");

    expect(await template({ op: "set_default_template", template_id: "headline" })).toMatchObject({ default_template_id: "headline" });
    const starterDefault = await read(await video());
    expect(starterDefault.document).toEqual(starterDefault.starters.find((starter) => starter.id === "headline")?.document);
    expect(await template({ op: "set_default_template", template_id: null })).toMatchObject({ default_template_id: "tiktok-title" });
    expect((await read(await video())).document.layers.map((layer) => layer.kind)).toEqual(["scrim", "text", "text"]);
    expect(await fails({ op: "set_default_template" })).toMatchObject({ status: "invalid", message: expect.stringMatching(/template_id/u) });
    expect(await fails({ op: "set_default_template", template_id: "missing" })).toMatchObject({ status: "not_found", template_id: "missing" });
  });

  it("keeps a template valid when an image it uses is deleted and reports that layer as missing", async () => {
    await clearTemplates();
    const designer = await video();
    const logo = await image();
    const fresh = await read(designer);
    const withLogo = await update(designer, { expected_revision: fresh.revision, edits: [{ op: "add_layer", layer: { kind: "image", name: "Logo", artifactId: logo } }] });
    const logoLayer = withLogo.document.layers.at(-1);
    const saved = await template({ asset_id: designer, op: "save_template", name: "With logo", expected_revision: withLogo.revision });
    const listed = (await read(designer)).templates[0];
    expect(listed).toMatchObject({ id: saved.template.id, missing_layer_ids: [] });

    const deleted = await client.callTool({ name: "delete_asset", arguments: { book_id: bookId, asset_id: logo } });
    expect(deleted.isError, (deleted.content as TextContent)[0].text).not.toBe(true);
    const target = await video();
    const later = await read(target);
    const kept = later.templates.find((candidate) => candidate.id === saved.template.id);
    expect(kept).toMatchObject({ name: "With logo", missing_layer_ids: [logoLayer?.id] });
    expect(kept?.document.layers.find((layer) => layer.kind === "image")).toMatchObject({ artifactId: logo });
    expect(later.images[logo]).toBeUndefined();

    const applied = await update(target, { expected_revision: later.revision, edits: [{ op: "apply_template", template: kept?.document }] });
    const missingLayer = applied.document.layers.find((layer) => layer.kind === "image");
    expect(missingLayer).toMatchObject({ artifactId: logo });
    const render = await fails({ asset_id: target, op: "render", expected_revision: applied.revision, source_hash: later.source.source_hash, request_id: randomUUID() });
    expect(render).toMatchObject({ status: "invalid", layer_id: missingLayer?.id });
    expect(await fails({ asset_id: target, op: "update", expected_revision: applied.revision, edits: [{ op: "add_layer", layer: { kind: "image", artifactId: randomUUID() } }] }))
      .toMatchObject({ status: "invalid", message: expect.stringMatching(/not an image artifact in this book/u) });
  });

  it("renames and deletes templates, and a deleted default falls back to the built-in look", async () => {
    await clearTemplates();
    const designer = await video();
    const fresh = await read(designer);
    const saved = await template({ asset_id: designer, op: "save_template", name: "Night", expected_revision: fresh.revision });
    const renamed = await template({ op: "rename_template", template_id: saved.template.id, name: "Night out" });
    expect(renamed).toMatchObject({ status: "renamed", template: { id: saved.template.id, name: "Night out" }, templates: [{ name: "Night out" }] });
    expect(await fails({ op: "rename_template", name: "Nameless" })).toMatchObject({ status: "invalid", message: expect.stringMatching(/template_id/u) });
    expect(await fails({ op: "rename_template", template_id: saved.template.id, name: "Credit" })).toMatchObject({ status: "invalid", message: expect.stringMatching(/starter/u) });
    await template({ op: "set_default_template", template_id: saved.template.id });
    const removed = await template({ op: "delete_template", template_id: saved.template.id });
    expect(removed).toMatchObject({ status: "deleted", template: { id: saved.template.id }, templates: [], default_template_id: "tiktok-title" });
    expect(await fails({ op: "delete_template", template_id: saved.template.id })).toMatchObject({ status: "not_found" });
    expect(await fails({ op: "copy_templates" })).toMatchObject({ status: "invalid", message: expect.stringMatching(/from_book/u) });
    expect((await read(designer)).templates).toEqual([]);
  });

  it("never spends money on template operations", () => {
    for (const op of ["save_template", "rename_template", "delete_template", "set_default_template", "copy_templates"]) {
      expect(toolSpendsMoney("video_graphics", { op })).toBe(false);
    }
  });
});
