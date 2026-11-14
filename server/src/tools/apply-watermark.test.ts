import { createEngineForTest } from "../engine.js";
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { COMMON_VIDEO_FIXTURES, copyVideoFixture } from "../test-media-fixtures.js";
import { readWatermarkConfig } from "../watermark-config.js";
import { graphicsDocumentFromLayers } from "../graphics/model.js";
import { saveGraphicsTemplate, setWatermarkGraphicsTemplate } from "../graphics/templates.js";
import { watermarkLayerInputs } from "../graphics/watermark-profile.js";
import type { BurnWatermarkPayload } from "../jobs/burn-watermark.js";
import { watermarkPayloadDocument } from "../jobs/burn-watermark.js";
import { LIGHTNING_WATERMARK_PROFILE } from "../lightning-defaults.js";
import { pauseBookQueueForTests } from "../queue.js";
import { withBookContext } from "../book-context.js";
import { applyWatermarkDef } from "./apply-watermark.js";
import type { Engine } from "videobook-engine";
import type { Client } from "@modelcontextprotocol/client";
import { testBudget } from "../test-budget.js";

type TextContent = Array<{ type: string; text: string }>;

const ORIENTATIONS = ["landscape", "portrait", "square"] as const;

type ApplyResult = {
  asset_id: string;
  card_asset_id: string;
  handle: string | null;
  url: string;
  include_qr: boolean;
  include_handle: boolean;
  opacity?: number;
  qr_opacity: number;
  handle_opacity: number;
  scale: number;
  requested_position: string;
  include_platform_icon: boolean;
  include_handle_border: boolean;
  handle_padding: number;
  handle_padding_y: number;
  handle_rounding: number;
  qr_start_seconds: number | null;
  qr_end_seconds: number | null;
  handle_start_seconds: number | null;
  handle_end_seconds: number | null;
  fade_seconds: number;
  mode: string;
  status?: string;
  job_id?: number;
  operation_id?: string;
  positions?: Record<(typeof ORIENTATIONS)[number], string>;
  position?: string | null;
  qr_asset_id?: string | null;
  handle_asset_id?: string | null;
  handle_position?: string | null;
  handle_vertical_percent: number;
  placement_source: string;
  template_id?: string | null;
};

describe("apply_watermark tool", () => {
  let client: Client;
  let fs: Engine;
  let tempDir: string;
  let originalEnv: NodeJS.ProcessEnv;
  const bookId = "watermark-apply-proj";

  beforeEach(async () => {
    originalEnv = { ...process.env };
    // No vision key and no X token: placement must degrade gracefully and the
    // authenticated-handle lookup must stay null.
    delete process.env.OPENAI_API_KEY;
    delete process.env.X_ACCESS_TOKEN;
    tempDir = await mkdtemp(join(tmpdir(), "videocity-apply-watermark-"));
    client = await createTestClient(tempDir);
    fs = createEngineForTest(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: bookId },
    });
  });

  afterEach(async () => {
    await client?.close();
    process.env = originalEnv;
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function createRealVideoAsset(): Promise<string> {
    const created = await fs.artifacts.create("vid", "real-clip");
    if (!created.ok) throw new Error(created.error.message);
    const tmpPath = join(tempDir, `src-${Date.now()}.mp4`);
    await copyVideoFixture(COMMON_VIDEO_FIXTURES.watermark, tmpPath);
    const write = await fs.files.writeFromPath(created.value.artifactId, "original.mp4", tmpPath);
    if (!write.ok) throw new Error(write.error.message);
    return created.value.artifactId;
  }

  async function queuedPayload(jobId: number | undefined): Promise<BurnWatermarkPayload> {
    const job = fs.jobs.queue.get(jobId ?? -1);
    expect(job?.state).toBe("queued");
    return job?.payload as unknown as BurnWatermarkPayload;
  }

  async function apply(args: Record<string, unknown>): Promise<ApplyResult> {
    const result = await client.callTool({
      name: "apply_watermark",
      arguments: { book_id: bookId, platform: "x", ...args },
    });
    expect(result.isError).toBeFalsy();
    return JSON.parse((result.content as TextContent)[0].text) as ApplyResult;
  }

  it("rejects overlay mode without changing the video or settings", async () => {
    const assetId = await createRealVideoAsset();
    const before = await fs.files.manifest(assetId);
    const result = await client.callTool({ name: "apply_watermark", arguments: { book_id: bookId, asset_id: assetId, mode: "overlay" } });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("mode");
    expect(await fs.files.manifest(assetId)).toEqual(before);
    for (const orientation of ORIENTATIONS) expect((await fs.metadata.artifacts.read(assetId, `${orientation}.render`)).ok).toBe(false);
  });

  it("burns when a stored profile still names overlay mode", async () => {
    await pauseBookQueueForTests(fs.book.get().bookId);
    expect(fs.settings.set("application.watermark.v1", { profile: { mode: "overlay", handle: "alice" } }).ok).toBe(true);
    const assetId = await createRealVideoAsset();
    const parsed = await apply({ asset_id: assetId, wait: false, save_default: true });
    expect(parsed.mode).toBe("burn");
    expect(await queuedPayload(parsed.job_id)).toMatchObject({ type: "burn_watermark", assetId, handle: "alice" });
    expect((await readWatermarkConfig(fs, "x")).profile?.mode).toBe("burn");
  });

  it("accepts above-title without a QR and ignores pill appearance and window arguments", async () => {
    await pauseBookQueueForTests(fs.book.get().bookId);
    const assetId = await createRealVideoAsset();
    const result = await apply({ asset_id: assetId, platform: "tiktok", handle_position: "above-title", handle_start_seconds: 20, handle_end_seconds: 21, handle_opacity: 0.1, handle_vertical_percent: 80, handle_padding: 90, wait: false });
    expect(result.handle_position).toBe("above-title");
    const payload = await queuedPayload(result.job_id);
    const document = await watermarkPayloadDocument(fs, payload, 1, { width: 1080, height: 1920 }, "bottom-right", null);
    const blocks = document.layers.filter(layer => layer.kind === "text");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ plate: null, opacity: 1, timing: { start: null, end: null }, position: { anchor: "bottom-left" } });
    expect(blocks[0].items.map(item => item.slot)).toEqual(["handle", "headline", "secondary"]);
  });

  it("upgrades a stored old default, preserves restyled profiles, and remembers an explicit center", async () => {
    await pauseBookQueueForTests(fs.book.get().bookId);
    const assetId = await createRealVideoAsset();
    const legacy = { ...LIGHTNING_WATERMARK_PROFILE, handlePlacement: "center" };
    expect(fs.settings.set("application.watermark.tiktok.v1", { profile: legacy }).ok).toBe(true);
    expect((await apply({ asset_id: assetId, platform: "tiktok", wait: false })).handle_position).toBe("above-title");
    expect(fs.settings.set("application.watermark.tiktok.v1", { profile: { ...legacy, handlePaddingX: 30 } }).ok).toBe(true);
    expect((await apply({ asset_id: assetId, platform: "tiktok", wait: false })).handle_position).toBe("center");
    await apply({ asset_id: assetId, platform: "tiktok", handle_position: "center", handle_padding: 15, save_default: true, wait: false });
    expect((await apply({ asset_id: assetId, platform: "tiktok", wait: false })).handle_position).toBe("center");
  });

  it("rejects non-video targets", async () => {
    const created = await fs.artifacts.create("img", "still");
    if (!created.ok) throw new Error(created.error.message);
    const result = await client.callTool({
      name: "apply_watermark",
      arguments: { book_id: bookId, asset_id: created.value.artifactId },
    });
    expect(result.isError).toBe(true);
  });

  it("rejects an empty QR timing window independently", async () => {
    const assetId = await createRealVideoAsset();
    const result = await client.callTool({
      name: "apply_watermark",
      arguments: {
        book_id: bookId,
        asset_id: assetId,
        include_qr: true,
        qr_start_seconds: 0.8,
        qr_end_seconds: 0.2,
      },
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("qr_end_seconds");
  });

  it("saves the full TikTok timing profile and replays an explicit window", async () => {
    await pauseBookQueueForTests(fs.book.get().bookId);
    const fresh = await client.callTool({ name: "get_watermark_config", arguments: { book_id: bookId } });
    expect(fresh.isError).toBeFalsy();
    const config = JSON.parse((fresh.content as TextContent)[0].text) as { profile: Record<string, unknown> };
    expect(config.profile).toMatchObject({
      platform: "tiktok",
      handle: "jtbkk",
      profileUrl: "https://www.tiktok.com/@jtbkk",
      includePlatformIcon: true,
      includeHandleBorder: true,
      handlePaddingX: 15,
      handlePaddingY: 28,
      handleRounding: 56,
      scale: 1,
      mode: "burn",
      handleVerticalPercent: 10,
      handleStartSeconds: 0,
      handleEndSeconds: 3,
      handleOpacity: 0.28,
      qrLeadSeconds: 2.3,
      qrOpacity: 0.37,
      fadeSeconds: 0.3,
    });
    const assetId = await createRealVideoAsset();
    const saved = await apply({ asset_id: assetId, platform: "tiktok", include_qr: true, save_default: true, wait: false });
    expect(saved).toMatchObject({ handle_end_seconds: 1, qr_start_seconds: 0, qr_end_seconds: 1, mode: "burn" });
    expect((await readWatermarkConfig(fs, "tiktok")).profile).toMatchObject({
      handle: "jtbkk",
      profileUrl: "https://www.tiktok.com/@jtbkk",
      handleEndSeconds: 3,
      qrLeadSeconds: 2.3,
      qrStartSeconds: null,
      qrEndSeconds: null,
      handleOpacity: 0.28,
      qrOpacity: 0.37,
    });
    await apply({
      asset_id: assetId,
      platform: "tiktok",
      include_qr: true,
      save_default: true,
      wait: false,
      handle_end_seconds: 0.5,
      qr_start_seconds: 0.2,
      qr_end_seconds: 0.8,
    });
    expect((await readWatermarkConfig(fs, "tiktok")).profile).toMatchObject({
      handleEndSeconds: 0.5,
      qrLeadSeconds: null,
      qrStartSeconds: 0.2,
      qrEndSeconds: 0.8,
    });
    const replay = await apply({ asset_id: assetId, platform: "tiktok", include_qr: true, wait: false });
    expect(replay).toMatchObject({ handle_end_seconds: 0.5, qr_start_seconds: 0.2, qr_end_seconds: 0.8 });
    expect((await readWatermarkConfig(fs, "tiktok")).profile?.qrLeadSeconds).toBeNull();
    await apply({ asset_id: assetId, platform: "x", handle: "alice", save_default: true, wait: false });
    expect((await readWatermarkConfig(fs, "tiktok")).profile).toMatchObject({ qrStartSeconds: 0.2, qrEndSeconds: 0.8 });
    expect(await readWatermarkConfig(fs, "x")).toMatchObject({
      savedHandle: "alice",
      profile: { handle: "alice", handleEndSeconds: null, qrLeadSeconds: null, qrStartSeconds: null, qrEndSeconds: null },
    });
  }, testBudget(60_000));

  it("keeps a burned video untranscribed only when the caller declines its transcript", async () => {
    await pauseBookQueueForTests(fs.book.get().bookId);
    const assetId = await createRealVideoAsset();
    const plain = await apply({ asset_id: assetId, platform: "tiktok", wait: false });
    expect(await queuedPayload(plain.job_id)).not.toHaveProperty("transcribe");
    const finishing = applyWatermarkDef(fs, { transcribe: false });
    const engineBookId = fs.book.get().bookId;
    const result = await withBookContext({ bookId: engineBookId, engine: fs }, () =>
      finishing.handler({ book_id: engineBookId, asset_id: assetId, platform: "tiktok", wait: false }));
    expect(result.isError).toBeFalsy();
    const declined = JSON.parse((result.content as TextContent)[0].text) as ApplyResult;
    expect(await queuedPayload(declined.job_id)).toMatchObject({ type: "burn_watermark", assetId, platform: "tiktok", transcribe: false });
  });

  it("queues a TikTok burn of the handle alone by default without minting badge images", async () => {
    await pauseBookQueueForTests(fs.book.get().bookId);
    const assetId = await createRealVideoAsset();
    const images = () => fs.artifacts.list().filter((artifact) => artifact.kind === "image").length;
    const imagesBefore = images();
    const parsed = await apply({ asset_id: assetId, platform: "tiktok", wait: false });
    expect(parsed).toMatchObject({
      mode: "burn",
      status: "accepted",
      include_qr: false,
      include_handle: true,
      handle: "jtbkk",
      position: null,
      placement_source: "fixed",
      card_asset_id: null,
      qr_asset_id: null,
      handle_asset_id: null,
      template_id: null,
      handle_end_seconds: 1,
      qr_start_seconds: null,
    });
    expect(images()).toBe(imagesBefore);
    expect(await queuedPayload(parsed.job_id)).toMatchObject({
      type: "burn_watermark",
      assetId,
      platform: "tiktok",
      handle: "jtbkk",
      url: "https://www.tiktok.com/@jtbkk",
      includeQr: false,
      includeHandle: true,
      includePlatformIcon: true,
      includeHandleBorder: true,
      handlePaddingX: 15,
      handlePaddingY: 28,
      handleRounding: 56,
      handleVerticalPercent: 10,
      handlePlacement: "above-title",
      handleOpacity: 0.28,
      fadeSeconds: 0.3,
      handleStartSeconds: 0,
      handleEndSeconds: 1,
      template: null,
      credit: null,
      patches: [],
    });
  });

  it("queues the saved watermark template with its credit source and only the parameters the caller set", async () => {
    await pauseBookQueueForTests(fs.book.get().bookId);
    const assetId = await createRealVideoAsset();
    const sourceId = await createRealVideoAsset();
    const original = await fs.metadata.artifacts.write(sourceId, "original", {
      platform: "tiktok",
      uploader: "pomkondeena",
      webpage_url: "https://www.tiktok.com/@pomkondeena/video/7",
    });
    expect(original.ok).toBe(true);
    const template = await saveGraphicsTemplate(fs, {
      name: "Brand",
      document: graphicsDocumentFromLayers([
        { kind: "text", name: "Credit", items: [{ text: "credit", slot: "credit", icon: "camera" }] },
        ...watermarkLayerInputs(LIGHTNING_WATERMARK_PROFILE, { width: 320, height: 240 }, { includeQr: true }),
      ]),
    });
    await setWatermarkGraphicsTemplate(fs, "tiktok", template.id);

    const templated = await apply({ asset_id: assetId, platform: "tiktok", source_asset_id: sourceId, qr_opacity: 0.8, wait: false });
    expect(templated).toMatchObject({ include_qr: true, include_handle: true, template_id: template.id, position: null, placement_source: "template", qr_opacity: 0.8 });
    expect(await queuedPayload(templated.job_id)).toMatchObject({
      includeQr: true,
      includeHandle: true,
      credit: "TikTok/@pomkondeena",
      patches: ["qrOpacity"],
      template: { id: template.id, document: template.document },
    });

    const placed = await apply({ asset_id: assetId, platform: "tiktok", position: "top-left", handle_opacity: 0.4, handle_end_seconds: 0.5, wait: false });
    expect(placed).toMatchObject({ include_qr: true, position: "top-left", placement_source: "explicit" });
    const placedPayload = await queuedPayload(placed.job_id);
    expect(placedPayload).toMatchObject({ corner: "top-left", credit: null, patches: ["position", "handleOpacity", "handleTiming"] });

    const withoutQr = await apply({ asset_id: assetId, platform: "tiktok", include_qr: false, include_handle: false, wait: false });
    expect(withoutQr).toMatchObject({ include_qr: false, include_handle: false, position: null, placement_source: "fixed", template_id: template.id });

    await setWatermarkGraphicsTemplate(fs, "tiktok", null);
    const cleared = await apply({ asset_id: assetId, platform: "tiktok", wait: false });
    expect(cleared).toMatchObject({ include_qr: false, template_id: null });
    expect((await queuedPayload(cleared.job_id)).template).toBeNull();
  });

  it("hands a reused card to the burn in place of the QR code", async () => {
    await pauseBookQueueForTests(fs.book.get().bookId);
    const assetId = await createRealVideoAsset();
    const card = await fs.artifacts.create("img", "card");
    if (!card.ok) throw new Error(card.error.message);
    const cardId = card.value.artifactId;
    const parsed = await apply({
      asset_id: assetId,
      card_asset_id: cardId,
      include_qr: true,
      include_handle: false,
      handle: "",
      url: "https://example.com/card",
      position: "bottom-left",
      wait: false,
    });
    expect(parsed).toMatchObject({ card_asset_id: cardId, qr_asset_id: cardId, handle_asset_id: null, position: "bottom-left", placement_source: "explicit" });
    expect(await queuedPayload(parsed.job_id)).toMatchObject({ cardAssetId: cardId, includeQr: true, includeHandle: false, corner: "bottom-left", url: "https://example.com/card" });
    const video = await client.callTool({ name: "apply_watermark", arguments: { book_id: bookId, asset_id: assetId, source_asset_id: cardId, wait: false } });
    expect(video.isError).toBe(true);
  });

  it("rejects a watermark with neither QR nor handle", async () => {
    const assetId = await createRealVideoAsset();
    const result = await client.callTool({
      name: "apply_watermark",
      arguments: {
        book_id: bookId,
        asset_id: assetId,
        include_qr: false,
        include_handle: false,
      },
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("include_qr or include_handle");
  });
});
