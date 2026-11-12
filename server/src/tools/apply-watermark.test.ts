import { createEngineForTest } from "../engine.js";
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { COMMON_VIDEO_FIXTURES, copyVideoFixture } from "../test-media-fixtures.js";
import { readWatermarkConfig } from "../watermark-config.js";
import { watermarkOsgScale } from "../remotion/osg-spec.js";
import { graphicsDocumentFromLayers } from "../graphics/model.js";
import { saveGraphicsTemplate, setWatermarkGraphicsTemplate } from "../graphics/templates.js";
import { watermarkLayerInputs } from "../graphics/watermark-profile.js";
import type { BurnWatermarkPayload } from "../jobs/burn-watermark.js";
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

  it("falls back to the analyze-video corner and stores faint whole-clip settings", async () => {
    const assetId = await createRealVideoAsset();
    const analysisWrite = await fs.files.write(
      assetId,
      ".original.analysis.json",
      Buffer.from(JSON.stringify({ recommendedOsgPosition: "bottom-left" })),
    );
    if (!analysisWrite.ok) throw new Error(analysisWrite.error.message);

    const parsed = await apply({ asset_id: assetId, handle: "someone", mode: "overlay" });

    expect(parsed.placement_source).toBe("analysis");
    expect(parsed.positions).toEqual({
      landscape: "bottom-left",
      portrait: "bottom-left",
      square: "bottom-left",
    });
    expect(parsed.opacity).toBe(0.5);
    expect(parsed.handle).toBe("someone");
    expect(parsed.url).toBe("https://x.com/someone");
    expect(parsed.handle_padding).toBe(32);
    expect(parsed.handle_padding_y).toBe(28);
    expect(parsed.handle_rounding).toBe(100);

    const card = fs.artifacts.get(parsed.card_asset_id);
    expect(card.ok && card.value.kind).toBe("image");

    for (const orient of ORIENTATIONS) {
      const meta = await fs.metadata.artifacts.read<Record<string, unknown>>(assetId, `${orient}.render`);
      if (!meta.ok) throw new Error(`missing ${orient}.render`);
      expect(meta.value.osgAssetId).toBe(parsed.card_asset_id);
      expect(meta.value.osgImagePath).toBeNull();
      expect(meta.value.osgPosition).toBe("bottom-left");
      expect(meta.value.osgSize).toBe("medium");
      expect(meta.value.osgScale).toBeCloseTo(watermarkOsgScale(orient), 4);
      expect(meta.value.osgOpacity).toBe(0.5);
      expect(meta.value.osgStartSeconds).toBeNull();
      expect(meta.value.osgEndSeconds).toBeNull();
      expect(meta.value.osgTailSeconds).toBeNull();
    }
  });

  it("defaults to bottom-right when no analysis exists", async () => {
    const assetId = await createRealVideoAsset();
    const parsed = await apply({ asset_id: assetId, handle: "someone", mode: "overlay" });
    expect(parsed.placement_source).toBe("default");
    expect(parsed.positions?.landscape).toBe("bottom-right");
  });

  it("stores explicit placement, timing, and a handle-only badge", async () => {
    const assetId = await createRealVideoAsset();
    const parsed = await apply({
      asset_id: assetId,
      handle: "someone",
      include_qr: false,
      position: "middle-center",
      handle_start_seconds: 0.25,
      handle_end_seconds: 0.75,
      mode: "overlay",
    });

    expect(parsed.include_qr).toBe(false);
    expect(parsed.requested_position).toBe("middle-center");
    expect(parsed.handle_start_seconds).toBe(0.25);
    expect(parsed.handle_end_seconds).toBe(0.75);
    expect(parsed.placement_source).toBe("explicit");
    expect(parsed.positions).toEqual({
      landscape: "middle-center",
      portrait: "middle-center",
      square: "middle-center",
    });

    const cardMeta = await fs.metadata.artifacts.read<Record<string, unknown>>(
      parsed.card_asset_id,
      "original",
    );
    if (!cardMeta.ok) throw new Error(cardMeta.error.message);
    expect(cardMeta.value.layout).toBe("handle-v5");
    expect(cardMeta.value.include_qr).toBe(false);
    expect(cardMeta.value.include_x_icon).toBe(true);
    expect(cardMeta.value.include_handle_border).toBe(true);
    expect(cardMeta.value.handle_padding).toBe(32);
    expect(cardMeta.value.handle_padding_y).toBe(28);
    expect(cardMeta.value.handle_rounding).toBe(100);
    expect(cardMeta.value.height).toBe(80);

    for (const orient of ORIENTATIONS) {
      const meta = await fs.metadata.artifacts.read<Record<string, unknown>>(assetId, `${orient}.render`);
      if (!meta.ok) throw new Error(`missing ${orient}.render`);
      expect(meta.value.osgPosition).toBe("middle-center");
      expect(meta.value.osgStartSeconds).toBe(0.25);
      expect(meta.value.osgEndSeconds).toBe(0.75);
    }
  });

  it("stores a QR-only overlay without requiring a handle", async () => {
    const assetId = await createRealVideoAsset();
    const parsed = await apply({
      asset_id: assetId,
      handle: "",
      url: "https://example.com/qr-only",
      include_qr: true,
      include_handle: false,
      position: "top-right",
      handle_start_seconds: 0.8,
      handle_end_seconds: 0.2,
      mode: "overlay",
    });

    expect(parsed.handle).toBeNull();
    expect(parsed.url).toBe("https://example.com/qr-only");
    expect(parsed.include_qr).toBe(true);
    expect(parsed.include_handle).toBe(false);
    expect(parsed.handle_start_seconds).toBeNull();
    expect(parsed.handle_end_seconds).toBeNull();
    expect(parsed.positions).toEqual({
      landscape: "top-right",
      portrait: "top-right",
      square: "top-right",
    });

    const cardMeta = await fs.metadata.artifacts.read<Record<string, unknown>>(
      parsed.card_asset_id,
      "original",
    );
    if (!cardMeta.ok) throw new Error(cardMeta.error.message);
    expect(cardMeta.value.layout).toBe("qr-v1");
    expect(cardMeta.value.include_handle).toBe(false);
  });

  it("reuses the badge asset across applies and honors custom opacity/scale", async () => {
    const firstAsset = await createRealVideoAsset();
    const secondAsset = await createRealVideoAsset();

    const first = await apply({ asset_id: firstAsset, handle: "someone", mode: "overlay" });
    const second = await apply({
      asset_id: secondAsset,
      handle: "someone",
      mode: "overlay",
      qr_opacity: 0.35,
      handle_opacity: 0.35,
      scale: 1.5,
    });

    expect(second.card_asset_id).toBe(first.card_asset_id);
    expect(second.opacity).toBe(0.35);
    const meta = await fs.metadata.artifacts.read<Record<string, unknown>>(secondAsset, "portrait.render");
    if (!meta.ok) throw new Error("missing portrait.render");
    expect(meta.value.osgOpacity).toBe(0.35);
    expect(meta.value.osgScale).toBeCloseTo(watermarkOsgScale("portrait", 1.5), 4);

    const alternateAppearance = await apply({
      asset_id: firstAsset,
      handle: "someone",
      include_platform_icon: false,
      include_handle_border: false,
      mode: "overlay",
    });
    expect(alternateAppearance.card_asset_id).not.toBe(first.card_asset_id);

    const alternateGeometry = await apply({
      asset_id: firstAsset,
      handle: "someone",
      handle_padding: 64,
      handle_rounding: 25,
      mode: "overlay",
    });
    expect(alternateGeometry.card_asset_id).not.toBe(first.card_asset_id);

    // A different handle mints a fresh badge instead of reusing the old one.
    const other = await apply({ asset_id: firstAsset, handle: "other", mode: "overlay" });
    expect(other.card_asset_id).not.toBe(first.card_asset_id);
  });

  it("separates platform badge caches and keeps legacy X badges reusable", async () => {
    const assetId = await createRealVideoAsset();
    const args = { asset_id: assetId, handle: "someone", include_qr: false, mode: "overlay" };
    const x = await apply(args);
    const metadata = await fs.metadata.artifacts.read<Record<string, unknown>>(x.card_asset_id, "original");
    if (!metadata.ok) throw new Error(metadata.error.message);
    const legacy = { ...metadata.value };
    delete legacy.platform;
    delete legacy.include_platform_icon;
    expect((await fs.metadata.artifacts.write(x.card_asset_id, "original", legacy)).ok).toBe(true);
    expect((await apply(args)).card_asset_id).toBe(x.card_asset_id);
    const tiktok = await apply({ ...args, platform: "tiktok", save_default: true });
    expect(tiktok.card_asset_id).not.toBe(x.card_asset_id);
    expect(tiktok).toMatchObject({ platform: "tiktok", include_platform_icon: true });
    expect((await apply({ ...args, platform: "tiktok" })).card_asset_id).toBe(tiktok.card_asset_id);
    const withoutIcon = await apply({ ...args, platform: "tiktok", include_platform_icon: false });
    expect(withoutIcon.card_asset_id).not.toBe(tiktok.card_asset_id);
    const tiktokPixels = await fs.files.read(tiktok.card_asset_id, "original.png");
    const xPixels = await fs.files.read(x.card_asset_id, "original.png");
    expect(tiktokPixels.ok && tiktokPixels.value).not.toEqual(xPixels.ok && xPixels.value);
    expect(await readWatermarkConfig(fs, "tiktok")).toMatchObject({ savedHandle: "someone" });
    expect(await readWatermarkConfig(fs)).toMatchObject({ savedHandle: null });
  });

  it("records handles and defaults to the saved handle", async () => {
    const assetId = await createRealVideoAsset();
    await apply({ asset_id: assetId, handle: "alice", save_default: true, mode: "overlay" });

    const config = await readWatermarkConfig(fs);
    expect(config.savedHandle).toBe("alice");
    expect(config.recent[0]).toBe("alice");

    const parsed = await apply({ asset_id: assetId, mode: "overlay" });
    expect(parsed.handle).toBe("alice");
  });

  it("records handle placement and vertical padding on overlay cards", async () => {
    const assetId = await createRealVideoAsset();
    const parsed = await apply({
      asset_id: assetId,
      handle: "someone",
      include_qr: true,
      handle_position: "on-qr",
      handle_padding_y: 64,
      mode: "overlay",
    });
    expect(parsed.handle_position).toBe("on-qr");
    expect(parsed.handle_padding_y).toBe(64);
    const cardMeta = await fs.metadata.artifacts.read<Record<string, unknown>>(
      parsed.card_asset_id,
      "original",
    );
    if (!cardMeta.ok) throw new Error(cardMeta.error.message);
    expect(cardMeta.value.handle_padding_y).toBe(64);
    expect(cardMeta.value.height).toBe(644);
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
    await apply({ asset_id: assetId, platform: "x", handle: "alice", save_default: true, mode: "overlay" });
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
      handlePlacement: "center",
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
