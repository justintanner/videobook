import { createEngineForTest } from "../engine.js";
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { findVideoFile } from "videobook-engine";
import { createTestClient } from "../test-client.js";
import { probeVideo, runFfmpeg } from "../ffmpeg.js";
import { COMMON_VIDEO_FIXTURES, copyVideoFixture } from "../test-media-fixtures.js";
import { readWatermarkConfig } from "../watermark-config.js";
import { watermarkOsgScale } from "../remotion/osg-spec.js";
import { videoProxyMetadataMatches } from "../video-proxy.js";
import type { Engine } from "videobook-engine";
import type { Client } from "@modelcontextprotocol/client";

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
};

type PixelRegion = { left: number; top: number; width: number; height: number };

/** Mean absolute channel difference between two videos' frame `n` inside `region`. */
async function frameRegionDifference(
  workDir: string,
  originalPath: string,
  candidatePath: string,
  frameIndex: number,
  region: PixelRegion,
): Promise<number> {
  const pixels = await Promise.all([originalPath, candidatePath].map(async (input, i) => {
    const framePath = join(workDir, `frame-${frameIndex}-${i}-${Date.now()}.png`);
    await runFfmpeg([
      "-y",
      "-i", input,
      "-vf", `select='eq(n,${frameIndex})'`,
      "-fps_mode", "passthrough",
      "-frames:v", "1",
      framePath,
    ]);
    const { data } = await sharp(framePath)
      .extract(region)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return data;
  }));
  let total = 0;
  for (let i = 0; i < pixels[0].length; i += 1) {
    total += Math.abs(pixels[0][i] - pixels[1][i]);
  }
  return total / pixels[0].length;
}

/**
 * A burn must leave no render-time overlay behind: the forced reprocess drops
 * the per-orientation render settings outright, and any that survive must
 * not point at a badge.
 */
async function expectOverlayCleared(fs: Engine, assetId: string): Promise<void> {
  for (const orient of ORIENTATIONS) {
    const meta = await fs.metadata.artifacts.read<Record<string, unknown>>(assetId, `${orient}.render`);
    if (!meta.ok) continue;
    expect(meta.value.osgAssetId ?? null).toBeNull();
  }
}

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
    expect(parsed.handle_padding_y).toBe(32);
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
    expect(cardMeta.value.handle_padding_y).toBe(32);
    expect(cardMeta.value.handle_rounding).toBe(100);
    expect(cardMeta.value.height).toBe(88);

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

  it("burns a saved TikTok alias into real video and rebuilds playback", async () => {
    const assetId = await createRealVideoAsset();
    await client.callTool({
      name: "create_watermark_card",
      arguments: { book_id: bookId, platform: "tiktok", handle: "@creator.name", save_default: true },
    });
    const originalPath = join(tempDir, "before-tiktok.mp4");
    await copyVideoFixture(COMMON_VIDEO_FIXTURES.watermark, originalPath);
    const result = await apply({ asset_id: assetId, platform: "tiktok", include_qr: false });
    expect(result).toMatchObject({
      status: "completed", platform: "tiktok", handle: "creator.name",
      url: "https://www.tiktok.com/@creator.name", include_platform_icon: true,
    });
    const after = await fs.files.manifest(assetId);
    if (!after.ok) throw new Error(after.error.message);
    const source = findVideoFile(after.value.files)!;
    const proxy = after.value.files.find((file) => file.name === "proxy.mp4");
    const metadata = await fs.metadata.artifacts.read<Record<string, unknown>>(assetId, "proxy");
    expect(metadata.ok && proxy && videoProxyMetadataMatches(metadata.value, source, proxy)).toBe(true);
    expect(await frameRegionDifference(tempDir, originalPath, join(after.value.path, source.name), 5, {
      left: 40, top: 0, width: 240, height: 48,
    })).toBeGreaterThan(0.4);
    await expectOverlayCleared(fs, assetId);
  }, 120_000);

  it("records handles and defaults to the saved handle", async () => {
    const assetId = await createRealVideoAsset();
    await apply({ asset_id: assetId, handle: "alice", save_default: true, mode: "overlay" });

    const config = await readWatermarkConfig(fs);
    expect(config.savedHandle).toBe("alice");
    expect(config.recent[0]).toBe("alice");

    const parsed = await apply({ asset_id: assetId, mode: "overlay" });
    expect(parsed.handle).toBe("alice");
  });

  it("burns separate QR and floating handle watermarks by default and clears overlay settings", async () => {
    const assetId = await createRealVideoAsset();

    // Seed dormant overlay settings to prove burn clears them (the state a
    // prior metadata-only apply left behind).
    await apply({ asset_id: assetId, handle: "someone", mode: "overlay" });

    const before = await fs.files.manifest(assetId);
    if (!before.ok) throw new Error(before.error.message);
    const beforeHash = findVideoFile(before.value.files)!.objectHash;

    const parsed = await apply({
      asset_id: assetId,
      handle: "someone",
      position: "top-center",
      handle_vertical_percent: 62,
      include_platform_icon: false,
      include_handle_border: false,
      handle_padding: 64,
      handle_rounding: 25,
      qr_opacity: 0.35,
      handle_opacity: 0.7,
      qr_start_seconds: 0.1,
      qr_end_seconds: 0.6,
      handle_start_seconds: 0.2,
      handle_end_seconds: 0.8,
    });
    expect(parsed.mode).toBe("burn");
    expect(parsed.status).toBe("completed");
    expect(parsed.operation_id).toMatch(/^burn-watermark-/);
    expect(parsed.fade_seconds).toBe(0.5);
    expect(parsed.position).toBe("top-center");
    expect(parsed.placement_source).toBe("explicit");
    expect(parsed.include_qr).toBe(true);
    expect(parsed).not.toHaveProperty("opacity");
    expect(parsed.qr_opacity).toBe(0.35);
    expect(parsed.handle_opacity).toBe(0.7);
    expect(parsed.include_platform_icon).toBe(false);
    expect(parsed.include_handle_border).toBe(false);
    expect(parsed.handle_padding).toBe(64);
    expect(parsed.handle_padding_y).toBe(32);
    expect(parsed.handle_rounding).toBe(25);
    expect(parsed.qr_start_seconds).toBe(0.1);
    expect(parsed.qr_end_seconds).toBe(0.6);
    expect(parsed.handle_start_seconds).toBe(0.2);
    expect(parsed.handle_end_seconds).toBe(0.8);
    expect(parsed.qr_asset_id).toBe(parsed.card_asset_id);
    expect(parsed.handle_asset_id).not.toBe(parsed.qr_asset_id);
    expect(parsed.handle_position).toBe("center");
    expect(parsed.handle_vertical_percent).toBe(62);

    const qrMeta = await fs.metadata.artifacts.read<Record<string, unknown>>(
      parsed.qr_asset_id!,
      "original",
    );
    const handleMeta = await fs.metadata.artifacts.read<Record<string, unknown>>(
      parsed.handle_asset_id!,
      "original",
    );
    if (!qrMeta.ok) throw new Error(qrMeta.error.message);
    if (!handleMeta.ok) throw new Error(handleMeta.error.message);
    expect(qrMeta.value.layout).toBe("qr-v1");
    expect(qrMeta.value.include_handle).toBe(false);
    expect(handleMeta.value.layout).toBe("handle-v5");
    expect(handleMeta.value.include_qr).toBe(false);
    expect(handleMeta.value.include_x_icon).toBe(false);
    expect(handleMeta.value.include_handle_border).toBe(false);
    expect(handleMeta.value.handle_padding).toBe(64);
    expect(handleMeta.value.handle_padding_y).toBe(32);
    expect(handleMeta.value.handle_rounding).toBe(25);

    const after = await fs.files.manifest(assetId);
    if (!after.ok) throw new Error(after.error.message);
    const videoFile = findVideoFile(after.value.files)!;
    expect(videoFile.objectHash).not.toBe(beforeHash);
    const proxyFile = after.value.files.find((file) => file.name === "proxy.mp4");
    expect(proxyFile).toBeDefined();
    const proxyMetadata = await fs.metadata.artifacts.read<Record<string, unknown>>(assetId, "proxy");
    expect(proxyMetadata.ok && proxyFile
      ? videoProxyMetadataMatches(proxyMetadata.value, videoFile, proxyFile)
      : false).toBe(true);

    // Same frame geometry and duration, just composited pixels.
    const probe = await probeVideo(join(after.value.path, videoFile.name));
    expect(probe.width).toBe(320);
    expect(probe.height).toBe(240);
    expect(probe.duration).toBeGreaterThan(0.5);

    // The burned badge replaces the render-time overlay, so a later render
    // can't stamp the watermark twice.
    await expectOverlayCleared(fs, assetId);
  }, 120_000);

  it("burns a QR-only watermark without validating or rendering a handle", async () => {
    const assetId = await createRealVideoAsset();
    const before = await fs.files.manifest(assetId);
    if (!before.ok) throw new Error(before.error.message);
    const beforeHash = findVideoFile(before.value.files)!.objectHash;

    const parsed = await apply({
      asset_id: assetId,
      handle: "",
      url: "https://example.com/qr-only",
      include_handle: false,
      position: "bottom-right",
      qr_opacity: 0.4,
      qr_start_seconds: 0.1,
      qr_end_seconds: 0.6,
      handle_start_seconds: 0.8,
      handle_end_seconds: 0.2,
    });

    expect(parsed.handle).toBeNull();
    expect(parsed.include_qr).toBe(true);
    expect(parsed.include_handle).toBe(false);
    expect(parsed.qr_opacity).toBe(0.4);
    expect(parsed.qr_start_seconds).toBe(0.1);
    expect(parsed.qr_end_seconds).toBe(0.6);
    expect(parsed.handle_start_seconds).toBeNull();
    expect(parsed.handle_end_seconds).toBeNull();
    expect(parsed.qr_asset_id).toBe(parsed.card_asset_id);
    expect(parsed.handle_asset_id).toBeNull();
    expect(parsed.handle_position).toBeNull();

    const after = await fs.files.manifest(assetId);
    if (!after.ok) throw new Error(after.error.message);
    const videoFile = findVideoFile(after.value.files)!;
    expect(videoFile.objectHash).not.toBe(beforeHash);
    expect(after.value.files.some((file) => file.name === "proxy.mp4")).toBe(true);
  }, 120_000);

  it("fades a mid-clip QR in instead of cutting it in", async () => {
    const assetId = await createRealVideoAsset();
    const originalPath = join(tempDir, "fade-original.mp4");
    await copyVideoFixture(COMMON_VIDEO_FIXTURES.watermark, originalPath);

    // 1s, 12fps fixture: QR from 0.2s to 0.8s with 0.3s fades ramps in over
    // frames 3-5 and is fully opaque by frame 6.
    const parsed = await apply({
      asset_id: assetId,
      handle: "",
      url: "https://example.com/fade",
      include_handle: false,
      position: "bottom-right",
      qr_opacity: 1,
      qr_start_seconds: 0.2,
      qr_end_seconds: 0.8,
      fade_seconds: 0.3,
    });
    expect(parsed.fade_seconds).toBe(0.3);

    const after = await fs.files.manifest(assetId);
    if (!after.ok) throw new Error(after.error.message);
    const burnedPath = join(after.value.path, findVideoFile(after.value.files)!.name);
    // 38px badge inset 6px from the bottom-right corner of the 320x240 frame.
    const badgeRegion: PixelRegion = { left: 276, top: 196, width: 38, height: 38 };
    const [beforeStart, midFadeIn, fullyVisible] = await Promise.all([
      frameRegionDifference(tempDir, originalPath, burnedPath, 1, badgeRegion),
      frameRegionDifference(tempDir, originalPath, burnedPath, 3, badgeRegion),
      frameRegionDifference(tempDir, originalPath, burnedPath, 6, badgeRegion),
    ]);
    expect(beforeStart).toBeLessThan(8);
    expect(midFadeIn).toBeGreaterThan(beforeStart + 3);
    expect(fullyVisible).toBeGreaterThan(midFadeIn * 2);
  }, 120_000);

  it("queues the burn without waiting when wait is false", async () => {
    const assetId = await createRealVideoAsset();
    await apply({ asset_id: assetId, handle: "someone", mode: "overlay" });
    const before = await fs.files.manifest(assetId);
    if (!before.ok) throw new Error(before.error.message);
    const beforeHash = findVideoFile(before.value.files)!.objectHash;

    const parsed = await apply({
      asset_id: assetId,
      handle: "someone",
      position: "top-left",
      wait: false,
    });
    expect(parsed.mode).toBe("burn");
    expect(parsed.status).toBe("accepted");
    expect(typeof parsed.job_id).toBe("number");
    expect(parsed.operation_id).toMatch(/^burn-watermark-/);
    expect(parsed.position).toBe("top-left");
    expect(parsed.placement_source).toBe("explicit");

    const readiness = await client.callTool({
      name: "wait_for_asset_ready",
      arguments: { book_id: bookId, asset_id: assetId, timeout_seconds: 120 },
    });
    expect(readiness.isError, JSON.stringify(readiness)).toBeFalsy();

    const jobs = await client.callTool({
      name: "list_jobs",
      arguments: { book_id: bookId, limit: 50 },
    });
    const jobList = JSON.parse((jobs.content as TextContent)[0].text) as Array<{
      id: number;
      type: string;
      state: string;
      result: { corner?: string; placementSource?: string } | null;
    }>;
    const burnJob = jobList.find((job) => job.id === parsed.job_id);
    expect(burnJob?.type).toBe("burn_watermark");
    expect(burnJob?.state).toBe("done");
    expect(burnJob?.result).toMatchObject({ corner: "top-left", placementSource: "explicit" });

    const after = await fs.files.manifest(assetId);
    if (!after.ok) throw new Error(after.error.message);
    expect(findVideoFile(after.value.files)!.objectHash).not.toBe(beforeHash);
    expect(after.value.files.some((file) => file.name === "proxy.mp4")).toBe(true);
    await expectOverlayCleared(fs, assetId);
  }, 120_000);

  it("records handle placement and vertical padding on overlay cards", async () => {
    const assetId = await createRealVideoAsset();
    const parsed = await apply({
      asset_id: assetId,
      handle: "someone",
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
        qr_start_seconds: 0.8,
        qr_end_seconds: 0.2,
      },
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("qr_end_seconds");
  });

  it("saves the full TikTok timing profile and replays an explicit window", async () => {
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
      handlePaddingY: 12,
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
    const saved = await apply({ asset_id: assetId, platform: "tiktok", save_default: true, wait: false });
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
    const replay = await apply({ asset_id: assetId, platform: "tiktok", wait: false });
    expect(replay).toMatchObject({ handle_end_seconds: 0.5, qr_start_seconds: 0.2, qr_end_seconds: 0.8 });
    expect((await readWatermarkConfig(fs, "tiktok")).profile?.qrLeadSeconds).toBeNull();
    await apply({ asset_id: assetId, platform: "x", handle: "alice", save_default: true, mode: "overlay" });
    expect((await readWatermarkConfig(fs, "tiktok")).profile).toMatchObject({ qrStartSeconds: 0.2, qrEndSeconds: 0.8 });
    expect(await readWatermarkConfig(fs, "x")).toMatchObject({
      savedHandle: "alice",
      profile: { handle: "alice", handleEndSeconds: null, qrLeadSeconds: null, qrStartSeconds: null, qrEndSeconds: null },
    });
  }, 60_000);

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
