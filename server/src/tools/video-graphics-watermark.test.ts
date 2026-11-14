import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine } from "videobook-engine";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createEngineForTest } from "../engine.js";
import { FFMPEG, probeVideo } from "../ffmpeg.js";
import type { GraphicsDocument, GraphicsLayerInput, GraphicsTextLayer } from "../graphics/model.js";
import { appendGraphicsLayers } from "../graphics/model.js";
import type { GraphicsRenderRequest } from "../graphics/render.js";
import { readGraphicsTemplates } from "../graphics/templates.js";
import { watermarkDrawnDocument } from "../graphics/watermark-burn.js";
import type { BurnWatermarkPayload } from "../jobs/burn-watermark.js";
import { watermarkPayloadDocument } from "../jobs/burn-watermark.js";
import { registerMediaProbe } from "../notebook-media-ops.js";
import { abortActiveBookJobsForTests, pauseBookQueueForTests } from "../queue.js";
import { createTestClient } from "../test-client.js";
import { readWatermarkConfig, saveWatermarkProfile } from "../watermark-config.js";

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
type Watermark = { platform: string; template_id: string | null; template_name: string | null; look: GraphicsDocument; qr: GraphicsLayerInput | null };
type Read = {
  saved: boolean;
  revision: string;
  document: GraphicsDocument;
  source: { width: number; height: number; duration_seconds: number; source_hash: string };
  fill: { handle: string | null; profile_url: string | null; credit: string | null };
  watermark: Watermark | null;
};
type Saved = { revision: string; document: GraphicsDocument };
type TemplateSaved = { status: string; template: { id: string; name: string }; watermark: { platform: string; template_id: string | null }; watermark_template_ids: Record<string, string> };
type Applied = { job_id: number; template_id: string | null; include_qr: boolean; include_handle: boolean };

function textLayers(document: GraphicsDocument): GraphicsTextLayer[] {
  return document.layers.filter((layer): layer is GraphicsTextLayer => layer.kind === "text");
}

function slotText(document: GraphicsDocument, slot: string): string | undefined {
  return textLayers(document).flatMap((layer) => layer.items).find((item) => item.slot === slot)?.text;
}

describe("video_graphics watermark mode", () => {
  let client: Client;
  let engine: Engine;
  let tempDir: string;
  let clips = 0;
  const bookId = "video-graphics-watermark-book";

  async function video(original?: Record<string, unknown>): Promise<string> {
    clips += 1;
    const output = join(tempDir, `clip-${clips}.mp4`);
    await execFileAsync(FFMPEG, [
      "-y", "-f", "lavfi", "-i", "color=c=gray:s=360x640:r=24:d=4",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-an", output,
    ]);
    const created = await engine.artifacts.create("video", "red light");
    if (!created.ok) throw new Error(created.error.message);
    const artifactId = created.value.artifactId;
    const written = await engine.files.write(artifactId, "original.mp4", await readFile(output));
    if (!written.ok) throw new Error(written.error.message);
    const manifest = await engine.files.manifest(artifactId);
    if (!manifest.ok) throw new Error(manifest.error.message);
    await registerMediaProbe(engine, artifactId, "original.mp4", await probeVideo(join(manifest.value.path, "original.mp4")));
    if (original) {
      const stored = await engine.metadata.artifacts.write(artifactId, "original", original);
      if (!stored.ok) throw new Error(stored.error.message);
    }
    return artifactId;
  }

  async function call(name: string, args: Record<string, unknown>): Promise<{ error: boolean; text: string }> {
    const result = await client.callTool({ name, arguments: { book_id: bookId, ...args } });
    return { error: result.isError === true, text: (result.content as TextContent)[0].text };
  }

  async function ok<T>(args: Record<string, unknown>, name = "video_graphics"): Promise<T> {
    const result = await call(name, args);
    if (result.error) throw new Error(result.text);
    return JSON.parse(result.text) as T;
  }

  async function fails(args: Record<string, unknown>): Promise<{ status: string; message: string }> {
    const result = await call("video_graphics", args);
    expect(result.error, result.text).toBe(true);
    return JSON.parse(result.text) as { status: string; message: string };
  }

  const read = (assetId: string, args: Record<string, unknown> = {}) => ok<Read>({ asset_id: assetId, watermark: true, ...args });

  async function burnedByApply(assetId: string, args: Record<string, unknown> = {}): Promise<{ applied: Applied; document: GraphicsDocument }> {
    const applied = await ok<Applied>({ asset_id: assetId, wait: false, ...args }, "apply_watermark");
    const job = engine.jobs.queue.get(applied.job_id);
    expect(job?.state).toBe("queued");
    const payload = job?.payload as unknown as BurnWatermarkPayload;
    const probe = await probeVideo(payload.videoPath);
    const document = await watermarkPayloadDocument(engine, payload, probe.videoDuration, { width: probe.width, height: probe.height }, payload.corner, null);
    return { applied, document };
  }

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videobook-graphics-watermark-"));
    client = await createTestClient(tempDir);
    engine = createEngineForTest(tempDir);
    await client.callTool({ name: "create_project", arguments: { book_id: bookId } });
    await pauseBookQueueForTests(engine.book.get().bookId);
  });

  afterEach(async () => {
    await abortActiveBookJobsForTests("watermark mode queues jobs it never runs");
  });

  afterAll(async () => {
    await client?.close();
    if (tempDir) await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("opens a video without graphics on the platform's watermark and writes nothing", async () => {
    const assetId = await video();
    const tiktok = await read(assetId);
    expect(tiktok).toMatchObject({ saved: false, watermark: { platform: "tiktok", template_id: null, template_name: null } });
    expect(tiktok.revision).toMatch(/^default:[0-9a-f]{32}$/u);
    expect(tiktok.document.layers.map((layer) => layer.kind)).toEqual(["scrim", "text"]);
    expect(tiktok.document.layers.some((layer) => layer.kind === "qr")).toBe(false);
    expect(slotText(tiktok.document, "handle")).toBe("jtbkk");
    expect(slotText(tiktok.document, "headline")).toBe("");
    expect(tiktok.watermark?.look).toEqual(tiktok.document);
    expect(tiktok.watermark?.qr).toMatchObject({ kind: "qr", slot: "profile", url: "https://www.tiktok.com/@jtbkk", style: "tile" });
    expect((await ok<Read>({ asset_id: assetId })).watermark).toBeNull();

    const x = await read(assetId, { platform: "x" });
    expect(x.document.layers.map((layer) => layer.kind)).toEqual(["text"]);
    expect(textLayers(x.document)[0].items[0]).toMatchObject({ slot: "handle", text: "justinwtanner", icon: "x" });
    expect(x.revision).not.toBe(tiktok.revision);
    expect(engine.settings.get(`graphics.draft.${assetId}`)).toBeNull();
  });

  it("draws exactly what apply_watermark burns with no options on TikTok and X", async () => {
    const assetId = await video();
    for (const platform of ["tiktok", "x"] as const) {
      const look = await read(assetId, { platform });
      const { applied, document } = await burnedByApply(assetId, { platform });
      expect(applied).toMatchObject({ include_qr: false, include_handle: true, template_id: null });
      expect(watermarkDrawnDocument(look.document)).toEqual(document);
    }
  });

  it("follows the profile's saved absolute timing like apply_watermark", async () => {
    const assetId = await video();
    await saveWatermarkProfile({ qrStartSeconds: 1, qrEndSeconds: 3, handleStartSeconds: 0.5, handleEndSeconds: 2.5 }, "x", engine);
    try {
      const look = await read(assetId, { platform: "x" });
      expect(textLayers(look.document)[0].timing).toMatchObject({ start: 0.5, end: 2.5 });
      expect(watermarkDrawnDocument(look.document)).toEqual((await burnedByApply(assetId, { platform: "x" })).document);
    } finally {
      engine.settings.delete("application.watermark.v1");
    }
  });

  it("saves the graphics as the platform's watermark that apply_watermark burns, over the same template each time", async () => {
    const assetId = await video();
    const fresh = await read(assetId);
    const qr = fresh.watermark?.qr;
    if (!qr) throw new Error("expected the profile QR layer");
    const credit: GraphicsLayerInput = { kind: "text", name: "Credit", items: [{ text: "", slot: "credit", icon: "camera", size: 0.03 }] };
    const follow: GraphicsLayerInput = { kind: "text", name: "Follow", items: [{ text: "Follow for more", size: 0.03 }] };
    const edited = await ok<Saved>({
      asset_id: assetId,
      watermark: true,
      op: "update",
      expected_revision: fresh.revision,
      document: appendGraphicsLayers(fresh.document, [qr, credit, follow]),
    });
    const titled = await ok<Saved>({ asset_id: assetId, watermark: true, op: "update", expected_revision: edited.revision, edits: [{ op: "set_slot_text", slot: "headline", text: THAI_TITLE }] });

    const plain = await ok<TemplateSaved>({ asset_id: assetId, watermark: true, op: "save_template", expected_revision: titled.revision, name: "Look" });
    expect(plain).toMatchObject({ template: { name: "Look" }, watermark_template_ids: {} });
    const saved = await ok<TemplateSaved>({ asset_id: assetId, op: "save_watermark", expected_revision: titled.revision });
    expect(saved).toMatchObject({ status: "saved", template: { name: "TikTok watermark" }, watermark: { platform: "tiktok", template_id: saved.template.id } });
    expect(saved.watermark_template_ids).toEqual({ tiktok: saved.template.id });
    const stored = readGraphicsTemplates(engine).templates.find((template) => template.id === saved.template.id);
    expect(stored && slotText(stored.document, "headline")).toBe("");
    expect(stored && slotText(stored.document, "handle")).toBe("");
    expect(stored?.document.layers.map((layer) => layer.name)).toEqual(["Shade", "Title", "QR code", "Credit", "Follow"]);

    const downloaded = await video(TIKTOK_SOURCE);
    const look = await read(downloaded);
    expect(look.watermark).toMatchObject({ template_id: saved.template.id, template_name: "TikTok watermark" });
    expect(slotText(look.document, "credit")).toBe("TikTok/@pomkondeena");
    expect(slotText(look.document, "headline")).toBe("");
    const { applied, document } = await burnedByApply(downloaded);
    expect(applied).toMatchObject({ include_qr: true, include_handle: true, template_id: saved.template.id });
    expect(watermarkDrawnDocument(look.document)).toEqual(document);
    expect(document.layers.map((layer) => layer.name)).toEqual(["Shade", "Title", "QR code", "Credit", "Follow"]);

    const again = await ok<TemplateSaved>({ asset_id: assetId, op: "save_watermark", expected_revision: titled.revision });
    expect(again.template.id).toBe(saved.template.id);
    await ok({ op: "rename_template", template_id: saved.template.id, name: "Brand" });
    expect((await ok<TemplateSaved>({ asset_id: assetId, op: "save_watermark", expected_revision: titled.revision })).template).toMatchObject({ id: saved.template.id, name: "Brand" });
    expect(readGraphicsTemplates(engine).templates.map((template) => template.name)).toEqual(["Look", "Brand"]);

    const cleared = await ok<TemplateSaved>({ op: "set_watermark_template", template_id: null });
    const resetLook = await read(await video());
    expect(textLayers(resetLook.document).map(layer => layer.items.map(item => item.slot))).toEqual([["handle", "headline", "secondary"]]);
    expect(textLayers(resetLook.document)[0]).toMatchObject({ plate: null, position: { anchor: "bottom-left" } });
    expect(cleared).toMatchObject({ watermark: { platform: "tiktok", template_id: null }, watermark_template_ids: {} });
    expect((await burnedByApply(downloaded)).applied).toMatchObject({ include_qr: false, template_id: null });
    expect(await fails({ op: "set_watermark_template", template_id: "tiktok-title" })).toMatchObject({ status: "not_found" });
    const restored = await ok<TemplateSaved>({ op: "set_watermark_template", template_id: saved.template.id });
    expect(restored.watermark_template_ids).toEqual({ tiktok: saved.template.id });
    await ok({ op: "set_watermark_template", template_id: null });
  });

  it("remembers the handle and QR link drawn in a saved watermark", async () => {
    const assetId = await video();
    const fresh = await read(assetId, { platform: "x" });
    const qr = fresh.watermark?.qr;
    if (!qr) throw new Error("expected the profile QR layer");
    const withQr = await ok<Saved>({ asset_id: assetId, watermark: true, platform: "x", op: "update", expected_revision: fresh.revision, document: appendGraphicsLayers(fresh.document, [qr]) });
    const qrLayer = withQr.document.layers.find((layer) => layer.kind === "qr");
    const edited = await ok<Saved>({
      asset_id: assetId,
      watermark: true,
      platform: "x",
      op: "update",
      expected_revision: withQr.revision,
      edits: [
        { op: "set_slot_text", slot: "handle", text: "@newname" },
        { op: "set_qr", layer_id: qrLayer?.id, qr: { url: "https://example.com/links" } },
      ],
    });
    const saved = await ok<TemplateSaved>({ asset_id: assetId, platform: "x", op: "save_watermark", expected_revision: edited.revision, name: "X brand" });
    expect(saved.template.name).toBe("X brand");
    try {
      const config = await readWatermarkConfig(engine, "x");
      expect(config.savedHandle).toBe("newname");
      expect(config.profile?.profileUrl).toBe("https://example.com/links");
      const other = await read(await video(), { platform: "x" });
      expect(slotText(other.document, "handle")).toBe("newname");
      expect(other.document.layers.find((layer) => layer.kind === "qr")).toMatchObject({ url: "https://example.com/links" });
    } finally {
      engine.settings.delete("application.watermark.v1");
      await ok({ platform: "x", op: "set_watermark_template", template_id: null });
    }
  });

  it("renders a watermark with the shade only behind a typed title, as its own request", async () => {
    const assetId = await video();
    const fresh = await read(assetId);
    const render = { asset_id: assetId, watermark: true, op: "render", output: "replace", source_hash: fresh.source.source_hash };
    const plain = await ok<{ render: { request_id: string; status: string } }>({ ...render, expected_revision: fresh.revision, request_id: randomUUID() });
    expect(plain.render.status).toBe("queued");
    const plainRequest = engine.settings.get<GraphicsRenderRequest>(`graphics.request.${plain.render.request_id}`);
    expect(plainRequest?.document.layers.map((layer) => layer.kind)).toEqual(["text"]);

    const titled = await ok<Saved>({ asset_id: assetId, watermark: true, op: "update", expected_revision: fresh.revision, edits: [{ op: "set_slot_text", slot: "headline", text: THAI_TITLE }] });
    const requestId = randomUUID();
    const shaded = await ok<{ render: { request_id: string } }>({ ...render, expected_revision: titled.revision, request_id: requestId });
    expect(engine.settings.get<GraphicsRenderRequest>(`graphics.request.${shaded.render.request_id}`)?.document.layers.map((layer) => layer.kind)).toEqual(["scrim", "text"]);
    expect(await fails({ ...render, watermark: false, expected_revision: titled.revision, request_id: requestId })).toMatchObject({
      status: "invalid",
      message: expect.stringMatching(/different render/u),
    });
  });
});
