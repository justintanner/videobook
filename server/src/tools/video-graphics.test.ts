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
import { buildRoutableTools } from "../chat-router.js";
import { createEngineForTest } from "../engine.js";
import { FFMPEG, probeVideo } from "../ffmpeg.js";
import type { GraphicsDocument, GraphicsTextLayer } from "../graphics/model.js";
import { registerMediaProbe } from "../notebook-media-ops.js";
import { toolSpendsMoney } from "../paid-tools.js";
import { createTestClient } from "../test-client.js";
import { recordHandle } from "../watermark-config.js";
import { getAllToolDefs } from "./index.js";
import { VIDEO_EDITING_TOOL_CONTRACTS } from "./video-editing-command-contract.js";

const execFileAsync = promisify(execFile);
const THAI_TITLE = "ติดไฟแดงยังไงให้เท่ได้ขนาดนี้";
const TIKTOK_SOURCE = {
  origin: "download",
  source_url: "https://www.tiktok.com/@pomkondeena/video/7432100000000000000",
  webpage_url: "https://www.tiktok.com/@pomkondeena/video/7432100000000000000",
  platform: "TikTok",
  uploader: "pomkondeena",
};

type TextContent = Array<{ type: string; text: string }>;
type Starter = { id: string; name: string; document: GraphicsDocument };
type Read = {
  asset_id: string;
  address: string | null;
  label: string | null;
  source: { width: number; height: number; duration_seconds: number; fps: number; source_hash: string };
  saved: boolean;
  revision: string;
  updated_at: string | null;
  document: GraphicsDocument;
  fill: { handle: string | null; profile_url: string | null; credit: string | null };
  starters: Starter[];
  images: Record<string, { label: string | null; url: string | null; width: number | null; height: number | null }>;
};
type Saved = { asset_id: string; status: string; saved: boolean; revision: string; updated_at: string; document: GraphicsDocument };
type Rendered = Read & { render: unknown; burned: unknown };
type Failure = { status: string; message: string; revision?: string; edit?: { code: string; index: number | null; op: string | null }; issues?: string[]; layer_id?: string };

function textLayers(document: GraphicsDocument): GraphicsTextLayer[] {
  return document.layers.filter((layer): layer is GraphicsTextLayer => layer.kind === "text");
}

function slotText(document: GraphicsDocument, slot: string): string | undefined {
  return textLayers(document).flatMap((layer) => layer.items).find((item) => item.slot === slot)?.text;
}

describe("video_graphics", () => {
  let client: Client;
  let engine: Engine;
  let tempDir: string;
  let clips = 0;
  const bookId = "video-graphics-book";

  async function clipBytes(width: number, height: number): Promise<Buffer> {
    clips += 1;
    const output = join(tempDir, `clip-${clips}.mp4`);
    await execFileAsync(FFMPEG, [
      "-y", "-f", "lavfi", "-i", `color=c=gray:s=${width}x${height}:r=24:d=2`,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-an", output,
    ]);
    return readFile(output);
  }

  async function video(options: { original?: Record<string, unknown>; width?: number; height?: number } = {}): Promise<string> {
    const created = await engine.artifacts.create("video", "red light");
    if (!created.ok) throw new Error(created.error.message);
    const artifactId = created.value.artifactId;
    const written = await engine.files.write(artifactId, "original.mp4", await clipBytes(options.width ?? 360, options.height ?? 640));
    if (!written.ok) throw new Error(written.error.message);
    const manifest = await engine.files.manifest(artifactId);
    if (!manifest.ok) throw new Error(manifest.error.message);
    await registerMediaProbe(engine, artifactId, "original.mp4", await probeVideo(join(manifest.value.path, "original.mp4")));
    if (options.original) {
      const original = await engine.metadata.artifacts.write(artifactId, "original", options.original);
      if (!original.ok) throw new Error(original.error.message);
    }
    return artifactId;
  }

  async function image(): Promise<string> {
    const created = await engine.artifacts.create("image", "logo");
    if (!created.ok) throw new Error(created.error.message);
    const bytes = await sharp({ create: { width: 40, height: 20, channels: 4, background: "#E11D48" } }).png().toBuffer();
    const written = await engine.files.write(created.value.artifactId, "original.png", bytes);
    if (!written.ok) throw new Error(written.error.message);
    const original = await engine.metadata.artifacts.write(created.value.artifactId, "original", { origin: "upload", width: 40, height: 20 });
    if (!original.ok) throw new Error(original.error.message);
    return created.value.artifactId;
  }

  async function call(args: Record<string, unknown>): Promise<{ error: boolean; body: unknown; text: string }> {
    const result = await client.callTool({ name: "video_graphics", arguments: { book_id: bookId, ...args } });
    const text = (result.content as TextContent)[0].text;
    try {
      return { error: result.isError === true, body: JSON.parse(text), text };
    } catch {
      return { error: result.isError === true, body: null, text };
    }
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

  const read = (assetId: string, args: Record<string, unknown> = {}) => ok<Read>({ asset_id: assetId, ...args });
  const save = (assetId: string, args: Record<string, unknown>) => ok<Saved>({ asset_id: assetId, op: "update", ...args });

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videobook-video-graphics-"));
    client = await createTestClient(tempDir);
    engine = createEngineForTest(tempDir);
    await client.callTool({ name: "create_project", arguments: { book_id: bookId } });
  });

  afterAll(async () => {
    await client?.close();
    if (tempDir) await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("reads the default look for a video without graphics and writes nothing", async () => {
    const assetId = await video();
    const first = await read(assetId);
    expect(first).toMatchObject({ asset_id: assetId, label: "red light", saved: false, updated_at: null, images: {} });
    expect(first.source).toMatchObject({ width: 360, height: 640, fps: 24 });
    expect(first.source.duration_seconds).toBeCloseTo(2, 1);
    const manifest = await engine.files.manifest(assetId);
    if (!manifest.ok) throw new Error(manifest.error.message);
    expect(first.source.source_hash).toBe(manifest.value.files.find((file) => file.name === "original.mp4")?.objectHash);
    expect(first.revision).toMatch(/^default:[0-9a-f]{32}$/u);
    expect(first.document.layers.map((layer) => layer.kind)).toEqual(["scrim", "text", "text"]);
    expect(first.document.layers.some((layer) => layer.kind === "qr")).toBe(false);
    expect(slotText(first.document, "handle")).toBe("jtbkk");
    expect(slotText(first.document, "headline")).toBe("");
    expect(slotText(first.document, "secondary")).toBe("");
    expect(first.fill).toEqual({ handle: "jtbkk", profile_url: "https://www.tiktok.com/@jtbkk", credit: null });
    expect(first.starters.map((starter) => starter.id)).toEqual(["tiktok-title", "lower-third", "headline", "credit", "watermark"]);
    expect(first.starters[0].document).toEqual(first.document);
    expect(engine.settings.get(`graphics.draft.${assetId}`)).toBeNull();
    expect((await read(assetId)).revision).toBe(first.revision);
  });

  it("fills the handle from the book's saved watermark profile and the chosen platform", async () => {
    const assetId = await video();
    await recordHandle("kondee", { saveDefault: true, platform: "tiktok" }, engine);
    try {
      const tiktok = await read(assetId);
      expect(slotText(tiktok.document, "handle")).toBe("kondee");
      expect(tiktok.fill).toMatchObject({ handle: "kondee", profile_url: "https://www.tiktok.com/@kondee" });
      const watermark = tiktok.starters.find((starter) => starter.id === "watermark")?.document;
      expect(watermark?.layers.find((layer) => layer.kind === "qr")).toMatchObject({ url: "https://www.tiktok.com/@kondee" });
    } finally {
      engine.settings.delete("application.watermark.tiktok.v1");
    }
    const x = await read(assetId, { platform: "x" });
    expect(slotText(x.document, "handle")).toBe("justinwtanner");
    expect(textLayers(x.document).at(-1)?.items[0].icon).toBe("x");
    expect(x.fill.profile_url).toBe("https://x.com/justinwtanner");
  });

  it("saves a first draft, applies edits, and answers a stale revision with the current one", async () => {
    const assetId = await video();
    const fresh = await read(assetId);
    const first = await save(assetId, { expected_revision: fresh.revision, edits: [{ op: "set_slot_text", slot: "headline", text: THAI_TITLE }] });
    expect(first).toMatchObject({ asset_id: assetId, status: "saved", saved: true });
    expect(first.revision).toMatch(/^[0-9a-f-]{36}$/u);
    expect(slotText(first.document, "headline")).toBe(THAI_TITLE);
    const reread = await read(assetId);
    expect(reread).toMatchObject({ saved: true, revision: first.revision, updated_at: first.updated_at });
    expect(reread.document).toEqual(first.document);
    const stale = await fails({ asset_id: assetId, op: "update", expected_revision: fresh.revision, edits: [{ op: "set_slot_text", slot: "secondary", text: "Late" }] });
    expect(stale).toMatchObject({ status: "conflict", revision: first.revision });
    const title = textLayers(first.document).find((layer) => layer.items.some((item) => item.slot === "headline"));
    if (!title) throw new Error("expected the title block");
    const second = await save(assetId, {
      expected_revision: first.revision,
      edits: [
        { op: "set_item", layer_id: title.id, item_id: title.items[1].id, item: { text: "How can you look this cool?" } },
        { op: "set_position", layer_id: title.id, position: { anchor: "bottom", x: 0.5 } },
        { op: "add_layer", layer: { kind: "text", name: "Credit", items: [{ text: "TikTok/@pomkondeena", icon: "camera", size: 0.03 }] } },
      ],
    });
    expect(second.revision).not.toBe(first.revision);
    expect(slotText(second.document, "secondary")).toBe("How can you look this cool?");
    expect(second.document.layers.find((layer) => layer.id === title.id)).toMatchObject({ position: { anchor: "bottom", x: 0.5, y: 1, space: "safe" } });
    expect(second.document.layers.at(-1)).toMatchObject({ kind: "text", name: "Credit", items: [{ text: "TikTok/@pomkondeena", icon: "camera" }] });
    expect(engine.settings.get(`graphics.draft.${assetId}`)).toMatchObject({ revision: second.revision });
  });

  it("saves a replacement document as given", async () => {
    const assetId = await video();
    const fresh = await read(assetId);
    const document = { ...fresh.document, layers: fresh.document.layers.filter((layer) => layer.kind !== "scrim") };
    const saved = await save(assetId, { expected_revision: fresh.revision, document });
    expect(saved.document).toEqual(document);
    expect((await read(assetId)).document.layers.map((layer) => layer.kind)).toEqual(["text", "text"]);
  });

  it("returns structured errors for bad input without saving", async () => {
    const assetId = await video();
    const fresh = await read(assetId);
    const base = { asset_id: assetId, op: "update" };
    expect(await fails({ ...base, edits: [] })).toMatchObject({ status: "invalid", message: expect.stringMatching(/expected_revision/u) });
    expect(await fails({ ...base, expected_revision: fresh.revision })).toMatchObject({ status: "invalid", message: expect.stringMatching(/exactly one/u) });
    expect(await fails({ ...base, expected_revision: fresh.revision, edits: [], document: fresh.document })).toMatchObject({ status: "invalid" });
    expect(await fails({ ...base, expected_revision: fresh.revision, edits: [{ op: "remove_layer", layer_id: "l99" }] })).toMatchObject({
      status: "invalid",
      edit: { code: "unknown_layer", index: 0, op: "remove_layer" },
    });
    const title = textLayers(fresh.document)[0];
    const tooBig = await fails({ ...base, expected_revision: fresh.revision, edits: [{ op: "set_item", layer_id: title.id, item_id: title.items[0].id, item: { size: 0.9 } }] });
    expect(tooBig).toMatchObject({ status: "invalid", edit: { code: "invalid", index: 0, op: "set_item" } });
    expect(tooBig.message).toMatch(/Text size must be between 0.01 and 0.3/u);
    const broken = await fails({ ...base, expected_revision: fresh.revision, document: { ...fresh.document, version: 2 } });
    expect(broken).toMatchObject({ status: "invalid", issues: [expect.stringMatching(/version/u)] });
    const notImage = await fails({ ...base, expected_revision: fresh.revision, edits: [{ op: "add_layer", layer: { kind: "image", artifactId: assetId } }] });
    expect(notImage).toMatchObject({ status: "invalid", layer_id: "l7" });
    expect(notImage.message).toMatch(/not an image artifact in this book/u);
    const unknownOp = await call({ ...base, expected_revision: fresh.revision, edits: [{ op: "explode", layer_id: "l1" }] });
    expect(unknownOp.error).toBe(true);
    expect(unknownOp.text).toMatch(/Input validation error/u);
    expect(await fails({ asset_id: await image() })).toMatchObject({ status: "invalid", message: expect.stringMatching(/video/u) });
    expect(await fails({ asset_id: "@z9" })).toMatchObject({ status: "error" });
    expect(engine.settings.get(`graphics.draft.${assetId}`)).toBeNull();
  });

  it("adds an image layer for an image in the book and reports how to draw it", async () => {
    const assetId = await video();
    const logo = await image();
    const fresh = await read(assetId);
    const saved = await save(assetId, {
      expected_revision: fresh.revision,
      edits: [{ op: "add_layer", layer: { kind: "image", artifactId: logo, position: { anchor: "top-left", x: 0, y: 0, space: "safe" }, size: 0.18 } }],
    });
    expect(saved.document.layers.at(-1)).toMatchObject({ kind: "image", artifactId: logo, size: 0.18 });
    const reread = await read(assetId);
    expect(Object.keys(reread.images)).toEqual([logo]);
    expect(reread.images[logo]).toMatchObject({ label: "logo", width: 40, height: 20 });
    expect(reread.images[logo].url).toMatch(new RegExp(`^/files/${engine.book.get().bookId}/${logo}/original\\.png`, "u"));
  });

  it("fills the source credit and reports the video's cell address", async () => {
    const assetId = await video({ original: TIKTOK_SOURCE });
    const notebook = await engine.notebooks.create(`Graphics ${randomUUID()}`);
    if (!notebook.ok) throw new Error(notebook.error.message);
    const cell = engine.notebooks.createCell({ type: "video", slot: { row: 1, column: 2 }, outputArtifactId: assetId });
    const written = await engine.notebooks.write({ ...notebook.value, cells: [cell] });
    if (!written.ok) throw new Error(written.error.message);
    const fresh = await read("@b3", { notebook_id: notebook.value.id });
    expect(fresh).toMatchObject({ asset_id: assetId, address: "@b3", fill: { credit: "TikTok/@pomkondeena" } });
    const lowerThird = fresh.starters.find((starter) => starter.id === "lower-third")?.document;
    expect(lowerThird && slotText(lowerThird, "credit")).toBe("TikTok/@pomkondeena");
    expect(slotText(fresh.document, "credit")).toBeUndefined();
    const applied = await save(assetId, { expected_revision: fresh.revision, edits: [{ op: "apply_template", template: lowerThird }] });
    expect(slotText(applied.document, "credit")).toBe("TikTok/@pomkondeena");
    expect(slotText(applied.document, "handle")).toBeUndefined();
  });

  it("forgets its draft with the video and stores no objectHash field", async () => {
    const assetId = await video({ original: TIKTOK_SOURCE });
    const fresh = await read(assetId);
    await save(assetId, { expected_revision: fresh.revision, edits: [{ op: "set_slot_text", slot: "headline", text: THAI_TITLE }] });
    const stored = engine.settings.get(`graphics.draft.${assetId}`);
    expect(stored).not.toBeNull();
    expect(JSON.stringify(stored)).not.toMatch(/objectHash/u);
    const forgotten = await client.callTool({ name: "delete_asset", arguments: { book_id: bookId, asset_id: assetId, forget: true } });
    expect(forgotten.isError).not.toBe(true);
    expect(engine.settings.get(`graphics.draft.${assetId}`)).toBeNull();
  });

  it("refuses a render it cannot do with a structured error and queues nothing", async () => {
    const assetId = await video();
    const fresh = await ok<Rendered>({ asset_id: assetId });
    expect(fresh).toMatchObject({ render: null, burned: null });
    const titled = await save(assetId, { expected_revision: fresh.revision, edits: [{ op: "set_slot_text", slot: "headline", text: THAI_TITLE }] });
    const render = { asset_id: assetId, op: "render", source_hash: fresh.source.source_hash, request_id: randomUUID() };
    expect(await fails({ asset_id: assetId, op: "render", expected_revision: titled.revision })).toMatchObject({
      status: "invalid",
      message: expect.stringMatching(/expected_revision, source_hash and request_id/u),
    });
    expect(await fails({ ...render, expected_revision: fresh.revision })).toMatchObject({ status: "conflict", revision: titled.revision });
    expect(await fails({ ...render, expected_revision: titled.revision, source_hash: "changed" })).toMatchObject({ status: "stale_source" });

    const hidden = await save(assetId, {
      expected_revision: titled.revision,
      document: { ...titled.document, layers: titled.document.layers.map((layer) => ({ ...layer, visible: false })) },
    });
    expect(await fails({ ...render, expected_revision: hidden.revision })).toMatchObject({ status: "invalid", message: expect.stringMatching(/nothing to draw/u) });

    const logo = await image();
    const withLogo = await save(assetId, { expected_revision: hidden.revision, edits: [{ op: "add_layer", layer: { kind: "image", artifactId: logo } }] });
    const logoLayer = withLogo.document.layers.at(-1);
    const removed = await engine.files.delete(logo, "original.png");
    expect(removed.ok).toBe(true);
    expect(await fails({ ...render, expected_revision: withLogo.revision })).toMatchObject({ status: "invalid", layer_id: logoLayer?.id });

    const created = await engine.artifacts.create("video", "still processing");
    if (!created.ok) throw new Error(created.error.message);
    const written = await engine.files.write(created.value.artifactId, "original.mp4", await clipBytes(360, 640));
    if (!written.ok) throw new Error(written.error.message);
    expect(await fails({ ...render, asset_id: created.value.artifactId, expected_revision: "any" })).toMatchObject({
      status: "not_ready",
      message: expect.stringMatching(/still processing/u),
    });
    expect(engine.jobs.queue.list({ type: "render_graphics", limit: 50 })).toEqual([]);
  });

  it("is a free, editor-only video tool behind /overlay", () => {
    const definitions = getAllToolDefs(engine);
    expect(definitions.map((definition) => definition.name)).toContain("video_graphics");
    expect(buildRoutableTools(definitions).map((tool) => tool.name)).not.toContain("video_graphics");
    expect(toolSpendsMoney("video_graphics")).toBe(false);
    expect(toolSpendsMoney("video_graphics", { op: "update" })).toBe(false);
    expect(toolSpendsMoney("video_graphics", { op: "render" })).toBe(false);
    expect(VIDEO_EDITING_TOOL_CONTRACTS.find((contract) => contract.tool === "video_graphics")).toEqual({
      tool: "video_graphics",
      exposure: "ui",
      command: "/overlay",
      purpose: "Read, save and render a video's on-screen graphics layers",
    });
    expect(VIDEO_EDITING_TOOL_CONTRACTS.find((contract) => contract.tool === "set_video_overlay")).toMatchObject({ exposure: "internal" });
  });
});
