import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Client } from "@modelcontextprotocol/client";
import jsQRImport from "jsqr";
import sharp from "sharp";
import type { Engine } from "videobook-engine";
import { findVideoFile } from "videobook-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngineForTest } from "../engine.js";
import { FFMPEG, probeVideo, runFfmpeg } from "../ffmpeg.js";
import { graphicsDocumentFromLayers } from "../graphics/model.js";
import { saveGraphicsTemplate, setWatermarkGraphicsTemplate } from "../graphics/templates.js";
import { watermarkLayerInputs } from "../graphics/watermark-profile.js";
import type { LightningWatermarkProfile } from "../lightning-defaults.js";
import { LIGHTNING_WATERMARK_PROFILE, X_WATERMARK_PROFILE } from "../lightning-defaults.js";
import { registerMediaProbe } from "../notebook-media-ops.js";
import { createTestClient } from "../test-client.js";
import { testBudget } from "../test-budget.js";
import { COMMON_VIDEO_FIXTURES, copyVideoFixture } from "../test-media-fixtures.js";
import { videoProxyMetadataMatches } from "../video-proxy.js";
import { buildWatermarkBadgePng } from "../watermark-badge.js";
import { watermarkProfileUrl } from "../watermark-platform.js";

const jsQR = jsQRImport as unknown as (data: Uint8ClampedArray, width: number, height: number) => { data: string } | null;
const execFileAsync = promisify(execFile);
const ORIENTATIONS = ["landscape", "portrait", "square"] as const;
const PORTRAIT = { width: 1080, height: 1920 };
const SMALL = { width: 360, height: 640 };
const GREY = 0x80;
const MAGENTA = [255, 0, 255] as const;
const DIFF_THRESHOLD = 6;
const BOX_TOLERANCE = 2;

type TextContent = Array<{ type: string; text: string }>;
type Frame = { width: number; height: number };
type Box = { left: number; top: number; width: number; height: number };

type ApplyResult = {
  card_asset_id: string | null;
  handle: string | null;
  url: string;
  include_qr: boolean;
  include_handle: boolean;
  qr_opacity: number;
  handle_opacity: number;
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
  position?: string | null;
  qr_asset_id?: string | null;
  handle_asset_id?: string | null;
  handle_position?: string | null;
  handle_vertical_percent: number;
  placement_source: string;
  template_id?: string | null;
};

async function frameRegionDifference(workDir: string, originalPath: string, candidatePath: string, frameIndex: number, region: Box): Promise<number> {
  const pixels = await Promise.all([originalPath, candidatePath].map(async (input, index) => {
    const framePath = join(workDir, `frame-${frameIndex}-${index}-${Date.now()}.png`);
    await runFfmpeg(["-y", "-i", input, "-vf", `select='eq(n,${frameIndex})'`, "-fps_mode", "passthrough", "-frames:v", "1", framePath]);
    const { data } = await sharp(framePath).extract(region).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    return data;
  }));
  let total = 0;
  for (let index = 0; index < pixels[0].length; index += 1) total += Math.abs(pixels[0][index] - pixels[1][index]);
  return total / pixels[0].length;
}

async function expectOverlayCleared(engine: Engine, assetId: string): Promise<void> {
  for (const orientation of ORIENTATIONS) {
    const meta = await engine.metadata.artifacts.read<Record<string, unknown>>(assetId, `${orientation}.render`);
    if (!meta.ok) continue;
    expect(meta.value.osgAssetId ?? null).toBeNull();
  }
}

async function frameAt(path: string, seconds: number, frame: Frame): Promise<Buffer> {
  const { stdout } = await execFileAsync(FFMPEG, [
    "-v", "error", "-ss", seconds.toFixed(3), "-i", path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
  ], { encoding: "buffer", maxBuffer: frame.width * frame.height * 4 });
  return stdout;
}

function changedBox(base: Buffer, marked: Buffer, frame: Frame, rows: readonly [number, number]): Box | null {
  const box = { minX: frame.width, maxX: -1, minY: frame.height, maxY: -1 };
  for (let y = rows[0]; y < rows[1]; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      const at = (y * frame.width + x) * 3;
      const delta = Math.max(Math.abs(base[at] - marked[at]), Math.abs(base[at + 1] - marked[at + 1]), Math.abs(base[at + 2] - marked[at + 2]));
      if (delta < DIFF_THRESHOLD) continue;
      box.minX = Math.min(box.minX, x);
      box.maxX = Math.max(box.maxX, x);
      box.minY = Math.min(box.minY, y);
      box.maxY = Math.max(box.maxY, y);
    }
  }
  return box.maxX < 0 ? null : { left: box.minX, top: box.minY, width: box.maxX - box.minX + 1, height: box.maxY - box.minY + 1 };
}

function decodeQr(pixels: Buffer, frame: Frame): string | null {
  const rgba = new Uint8ClampedArray(frame.width * frame.height * 4);
  for (let index = 0; index < frame.width * frame.height; index += 1) {
    const stretched = [0, 1, 2].map((channel) => Math.max(0, Math.min(255, (pixels[index * 3 + channel] - GREY) * 3 + GREY)));
    rgba.set([...stretched, 255], index * 4);
  }
  return jsQR(rgba, frame.width, frame.height)?.data ?? null;
}

function colorCount(pixels: Buffer, target: readonly [number, number, number], tolerance: number): number {
  let count = 0;
  for (let offset = 0; offset < pixels.length; offset += 3) {
    if (Math.abs(pixels[offset] - target[0]) + Math.abs(pixels[offset + 1] - target[1]) + Math.abs(pixels[offset + 2] - target[2]) <= tolerance) count += 1;
  }
  return count;
}

function evenPixels(value: number): number {
  return Math.max(2, 2 * Math.round(value / 2));
}

function todayQrBox(profile: LightningWatermarkProfile, frame: Frame): Box {
  const side = evenPixels(Math.min(frame.width, frame.height) * 0.16 * profile.scale);
  const padding = Math.round(frame.width * 0.02);
  return { left: frame.width - side - padding, top: frame.height - side - padding, width: side, height: side };
}

async function alphaBox(png: Buffer): Promise<Box & { imageWidth: number; imageHeight: number }> {
  const { data, info } = await sharp(png).ensureAlpha().extractChannel("alpha").raw().toBuffer({ resolveWithObject: true });
  const box = { minX: info.width, maxX: -1, minY: info.height, maxY: -1 };
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      if (data[y * info.width + x] === 0) continue;
      box.minX = Math.min(box.minX, x);
      box.maxX = Math.max(box.maxX, x);
      box.minY = Math.min(box.minY, y);
      box.maxY = Math.max(box.maxY, y);
    }
  }
  return { left: box.minX, top: box.minY, width: box.maxX - box.minX + 1, height: box.maxY - box.minY + 1, imageWidth: info.width, imageHeight: info.height };
}

async function todayHandleBox(profile: LightningWatermarkProfile, frame: Frame): Promise<Box> {
  const badge = await alphaBox(await buildWatermarkBadgePng(watermarkProfileUrl(profile.handle, profile.platform), profile.handle, {
    variant: "handle",
    platform: profile.platform,
    includePlatformIcon: profile.includePlatformIcon,
    includeHandleBorder: profile.includeHandleBorder,
    handlePadding: profile.handlePaddingX,
    handlePaddingY: profile.handlePaddingY,
    handleRounding: profile.handleRounding,
  }));
  const side = evenPixels(Math.min(frame.width, frame.height) * 0.16 * profile.scale);
  const height = evenPixels((side * badge.imageHeight) / 88);
  const scale = height / badge.imageHeight;
  const width = evenPixels(badge.imageWidth * scale);
  const left = (frame.width - width) / 2;
  const top = (frame.height * profile.handleVerticalPercent) / 100 - height / 2;
  return { left: left + badge.left * scale, top: top + badge.top * scale, width: badge.width * scale, height: badge.height * scale };
}

function expectWithin(actual: Box | null, expected: Box, label: string): void {
  if (!actual) throw new Error(`${label}: nothing changed`);
  const edges = {
    left: actual.left - expected.left,
    top: actual.top - expected.top,
    right: actual.left + actual.width - (expected.left + expected.width),
    bottom: actual.top + actual.height - (expected.top + expected.height),
  };
  for (const [edge, delta] of Object.entries(edges)) {
    expect(Math.abs(delta), `${label} ${edge} ${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`).toBeLessThanOrEqual(BOX_TOLERANCE);
  }
}

describe("apply_watermark burns through the graphics renderer", () => {
  let client: Client;
  let engine: Engine;
  let tempDir: string;
  let originalEnv: NodeJS.ProcessEnv;
  let clips = 0;
  const bookId = "watermark-burn-e2e";

  beforeEach(async () => {
    originalEnv = { ...process.env };
    delete process.env.OPENAI_API_KEY;
    delete process.env.X_ACCESS_TOKEN;
    tempDir = await mkdtemp(join(tmpdir(), "videobook-apply-watermark-e2e-"));
    client = await createTestClient(tempDir);
    engine = createEngineForTest(tempDir);
    await client.callTool({ name: "create_project", arguments: { book_id: bookId } });
  });

  afterEach(async () => {
    await client?.close();
    process.env = originalEnv;
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function fixtureAsset(): Promise<string> {
    const created = await engine.artifacts.create("vid", "real-clip");
    if (!created.ok) throw new Error(created.error.message);
    const path = join(tempDir, `fixture-${Date.now()}.mp4`);
    await copyVideoFixture(COMMON_VIDEO_FIXTURES.watermark, path);
    const written = await engine.files.writeFromPath(created.value.artifactId, "original.mp4", path);
    if (!written.ok) throw new Error(written.error.message);
    return created.value.artifactId;
  }

  async function greyAsset(frame: Frame, seconds: number): Promise<{ assetId: string; sourcePath: string }> {
    clips += 1;
    const sourcePath = join(tempDir, `grey-${clips}.mp4`);
    await execFileAsync(FFMPEG, [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", `color=c=0x808080:s=${frame.width}x${frame.height}:r=24:d=${seconds}`,
      "-f", "lavfi", "-i", `sine=frequency=330:sample_rate=48000:duration=${seconds}`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "12", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", sourcePath,
    ]);
    const created = await engine.artifacts.create("vid", `grey-${clips}`);
    if (!created.ok) throw new Error(created.error.message);
    const written = await engine.files.write(created.value.artifactId, "original.mp4", await readFile(sourcePath));
    if (!written.ok) throw new Error(written.error.message);
    const path = await videoPath(created.value.artifactId);
    await registerMediaProbe(engine, created.value.artifactId, "original.mp4", await probeVideo(path));
    return { assetId: created.value.artifactId, sourcePath };
  }

  async function videoPath(assetId: string): Promise<string> {
    const manifest = await engine.files.manifest(assetId);
    if (!manifest.ok) throw new Error(manifest.error.message);
    const file = findVideoFile(manifest.value.files);
    if (!file) throw new Error(`no video in ${assetId}`);
    return join(manifest.value.path, file.name);
  }

  async function apply(args: Record<string, unknown>): Promise<ApplyResult> {
    const result = await client.callTool({ name: "apply_watermark", arguments: { book_id: bookId, platform: "x", ...args } });
    const text = (result.content as TextContent)[0].text;
    expect(result.isError, text).toBeFalsy();
    return JSON.parse(text) as ApplyResult;
  }

  it("burns a saved TikTok alias into real video and rebuilds playback", async () => {
    const assetId = await fixtureAsset();
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
    const after = await engine.files.manifest(assetId);
    if (!after.ok) throw new Error(after.error.message);
    const source = findVideoFile(after.value.files)!;
    const proxy = after.value.files.find((file) => file.name === "proxy.mp4");
    const metadata = await engine.metadata.artifacts.read<Record<string, unknown>>(assetId, "proxy");
    expect(metadata.ok && proxy && videoProxyMetadataMatches(metadata.value, source, proxy)).toBe(true);
    expect(await frameRegionDifference(tempDir, originalPath, join(after.value.path, source.name), 5, {
      left: 40, top: 0, width: 240, height: 48,
    })).toBeGreaterThan(0.4);
    await expectOverlayCleared(engine, assetId);
  }, testBudget(180_000));

  it("burns separate QR and floating handle watermarks and clears overlay settings", async () => {
    const assetId = await fixtureAsset();
    await apply({ asset_id: assetId, handle: "someone", mode: "overlay" });
    const before = await engine.files.manifest(assetId);
    if (!before.ok) throw new Error(before.error.message);
    const beforeHash = findVideoFile(before.value.files)!.objectHash;
    const images = engine.artifacts.list().filter((artifact) => artifact.kind === "image").length;

    const parsed = await apply({
      asset_id: assetId,
      handle: "someone",
      include_qr: true,
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
    expect(parsed).toMatchObject({
      mode: "burn",
      status: "completed",
      fade_seconds: 0.5,
      position: "top-center",
      placement_source: "explicit",
      include_qr: true,
      qr_opacity: 0.35,
      handle_opacity: 0.7,
      include_platform_icon: false,
      include_handle_border: false,
      handle_padding: 64,
      handle_padding_y: 28,
      handle_rounding: 25,
      qr_start_seconds: 0.1,
      qr_end_seconds: 0.6,
      handle_start_seconds: 0.2,
      handle_end_seconds: 0.8,
      card_asset_id: null,
      qr_asset_id: null,
      handle_asset_id: null,
      handle_position: "center",
      handle_vertical_percent: 62,
    });
    expect(parsed.operation_id).toMatch(/^burn-watermark-/);
    expect(parsed).not.toHaveProperty("opacity");
    expect(engine.artifacts.list().filter((artifact) => artifact.kind === "image")).toHaveLength(images);

    const after = await engine.files.manifest(assetId);
    if (!after.ok) throw new Error(after.error.message);
    const videoFile = findVideoFile(after.value.files)!;
    expect(videoFile.objectHash).not.toBe(beforeHash);
    const proxyFile = after.value.files.find((file) => file.name === "proxy.mp4");
    const proxyMetadata = await engine.metadata.artifacts.read<Record<string, unknown>>(assetId, "proxy");
    expect(proxyMetadata.ok && proxyFile ? videoProxyMetadataMatches(proxyMetadata.value, videoFile, proxyFile) : false).toBe(true);
    const probe = await probeVideo(join(after.value.path, videoFile.name));
    expect(probe.width).toBe(320);
    expect(probe.height).toBe(240);
    expect(probe.duration).toBeGreaterThan(0.5);
    await expectOverlayCleared(engine, assetId);
  }, testBudget(180_000));

  it("burns a QR-only watermark without validating or rendering a handle", async () => {
    const assetId = await fixtureAsset();
    const before = await engine.files.manifest(assetId);
    if (!before.ok) throw new Error(before.error.message);
    const beforeHash = findVideoFile(before.value.files)!.objectHash;
    const parsed = await apply({
      asset_id: assetId,
      handle: "",
      url: "https://example.com/qr-only",
      include_qr: true,
      include_handle: false,
      position: "bottom-right",
      qr_opacity: 0.4,
      qr_start_seconds: 0.1,
      qr_end_seconds: 0.6,
      handle_start_seconds: 0.8,
      handle_end_seconds: 0.2,
    });
    expect(parsed).toMatchObject({
      handle: null,
      include_qr: true,
      include_handle: false,
      qr_opacity: 0.4,
      qr_start_seconds: 0.1,
      qr_end_seconds: 0.6,
      handle_start_seconds: null,
      handle_end_seconds: null,
      qr_asset_id: null,
      handle_asset_id: null,
      handle_position: null,
    });
    const after = await engine.files.manifest(assetId);
    if (!after.ok) throw new Error(after.error.message);
    expect(findVideoFile(after.value.files)!.objectHash).not.toBe(beforeHash);
    expect(after.value.files.some((file) => file.name === "proxy.mp4")).toBe(true);
  }, testBudget(180_000));

  it("fades a mid-clip QR in instead of cutting it in", async () => {
    const assetId = await fixtureAsset();
    const originalPath = join(tempDir, "fade-original.mp4");
    await copyVideoFixture(COMMON_VIDEO_FIXTURES.watermark, originalPath);
    const parsed = await apply({
      asset_id: assetId,
      handle: "",
      url: "https://example.com/fade",
      include_qr: true,
      include_handle: false,
      position: "bottom-right",
      qr_opacity: 1,
      qr_start_seconds: 0.2,
      qr_end_seconds: 0.8,
      fade_seconds: 0.3,
    });
    expect(parsed.fade_seconds).toBe(0.3);
    const burnedPath = await videoPath(assetId);
    const badgeRegion: Box = { left: 276, top: 196, width: 38, height: 38 };
    const [beforeStart, midFadeIn, fullyVisible] = await Promise.all([
      frameRegionDifference(tempDir, originalPath, burnedPath, 1, badgeRegion),
      frameRegionDifference(tempDir, originalPath, burnedPath, 3, badgeRegion),
      frameRegionDifference(tempDir, originalPath, burnedPath, 6, badgeRegion),
    ]);
    expect(beforeStart).toBeLessThan(8);
    expect(midFadeIn).toBeGreaterThan(beforeStart + 3);
    expect(fullyVisible).toBeGreaterThan(midFadeIn * 2);
  }, testBudget(180_000));

  it("queues the burn without waiting when wait is false", async () => {
    const assetId = await fixtureAsset();
    await apply({ asset_id: assetId, handle: "someone", mode: "overlay" });
    const before = await engine.files.manifest(assetId);
    if (!before.ok) throw new Error(before.error.message);
    const beforeHash = findVideoFile(before.value.files)!.objectHash;
    const parsed = await apply({ asset_id: assetId, handle: "someone", include_qr: true, position: "top-left", wait: false });
    expect(parsed).toMatchObject({ mode: "burn", status: "accepted", position: "top-left", placement_source: "explicit" });
    expect(typeof parsed.job_id).toBe("number");
    expect(parsed.operation_id).toMatch(/^burn-watermark-/);
    const readiness = await client.callTool({ name: "wait_for_asset_ready", arguments: { book_id: bookId, asset_id: assetId, timeout_seconds: 180 } });
    expect(readiness.isError, JSON.stringify(readiness)).toBeFalsy();
    const jobs = await client.callTool({ name: "list_jobs", arguments: { book_id: bookId, limit: 50 } });
    const jobList = JSON.parse((jobs.content as TextContent)[0].text) as Array<{ id: number; type: string; state: string; result: { corner?: string; placementSource?: string } | null }>;
    const burnJob = jobList.find((job) => job.id === parsed.job_id);
    expect(burnJob).toMatchObject({ type: "burn_watermark", state: "done", result: { corner: "top-left", placementSource: "explicit" } });
    const after = await engine.files.manifest(assetId);
    if (!after.ok) throw new Error(after.error.message);
    expect(findVideoFile(after.value.files)!.objectHash).not.toBe(beforeHash);
    expect(after.value.files.some((file) => file.name === "proxy.mp4")).toBe(true);
    await expectOverlayCleared(engine, assetId);
  }, testBudget(240_000));

  it.each([
    ["tiktok", LIGHTNING_WATERMARK_PROFILE, 1.5, 5.5],
    ["x", X_WATERMARK_PROFILE, 3, 3],
  ] as const)("keeps the default %s QR code and handle within 2 px of today's burn, decoding to the profile URL", async (platform, profile, handleAt, qrAt) => {
    const { assetId, sourcePath } = await greyAsset(PORTRAIT, 6);
    const parsed = await apply({ asset_id: assetId, platform, include_qr: true, position: "bottom-right" });
    expect(parsed).toMatchObject({ status: "completed", include_qr: true, include_handle: true, position: "bottom-right", handle: profile.handle });
    const burned = await videoPath(assetId);
    const split = Math.round(PORTRAIT.height * 0.6);
    const [baseHandle, markedHandle, baseQr, markedQr] = await Promise.all([
      frameAt(sourcePath, handleAt, PORTRAIT),
      frameAt(burned, handleAt, PORTRAIT),
      frameAt(sourcePath, qrAt, PORTRAIT),
      frameAt(burned, qrAt, PORTRAIT),
    ]);
    expect(decodeQr(markedQr, PORTRAIT)).toBe(watermarkProfileUrl(profile.handle, platform));
    expectWithin(changedBox(baseQr, markedQr, PORTRAIT, [split, PORTRAIT.height]), todayQrBox(profile, PORTRAIT), `${platform} QR`);
    expectWithin(changedBox(baseHandle, markedHandle, PORTRAIT, [0, split]), await todayHandleBox(profile, PORTRAIT), `${platform} handle`);
  }, testBudget(240_000));

  it("burns the TikTok handle alone by default, with no QR code and no shade", async () => {
    const { assetId, sourcePath } = await greyAsset(SMALL, 4);
    const parsed = await apply({ asset_id: assetId, platform: "tiktok" });
    expect(parsed).toMatchObject({ status: "completed", include_qr: false, include_handle: true, position: null, placement_source: "fixed", template_id: null });
    const burned = await videoPath(assetId);
    const [baseEarly, early, baseLate, late] = await Promise.all([
      frameAt(sourcePath, 1, SMALL),
      frameAt(burned, 1, SMALL),
      frameAt(sourcePath, 3.6, SMALL),
      frameAt(burned, 3.6, SMALL),
    ]);
    expect(changedBox(baseEarly, early, SMALL, [0, SMALL.height * 0.3])).not.toBeNull();
    expect(changedBox(baseEarly, early, SMALL, [SMALL.height * 0.3, SMALL.height])).toBeNull();
    expect(changedBox(baseLate, late, SMALL, [0, SMALL.height])).toBeNull();
    expect(decodeQr(late, SMALL)).toBeNull();
  }, testBudget(240_000));

  it("burns a saved watermark template's credit on a downloaded video and skips it on a generated one", async () => {
    const template = await saveGraphicsTemplate(engine, {
      name: "Credited",
      document: graphicsDocumentFromLayers([
        {
          kind: "text",
          name: "Credit",
          position: { anchor: "bottom-left", x: 0, y: 1, space: "safe" },
          width: 0.9,
          align: "left",
          plate: { color: "#FF00FF", opacity: 1, radius: 0 },
          items: [{ text: "credit", slot: "credit", size: 0.04, icon: "camera", shadow: false }],
        },
        ...watermarkLayerInputs(LIGHTNING_WATERMARK_PROFILE, SMALL, { includeQr: false }),
      ]),
    });
    await setWatermarkGraphicsTemplate(engine, "tiktok", template.id);
    const downloaded = await greyAsset(SMALL, 4);
    const original = await engine.metadata.artifacts.write(downloaded.assetId, "original", {
      platform: "tiktok",
      uploader: "pomkondeena",
      webpage_url: "https://www.tiktok.com/@pomkondeena/video/7",
    });
    expect(original.ok).toBe(true);
    const generated = await greyAsset(SMALL, 4);

    for (const clip of [downloaded, generated]) {
      const parsed = await apply({ asset_id: clip.assetId, platform: "tiktok" });
      expect(parsed).toMatchObject({ status: "completed", template_id: template.id, include_qr: false, include_handle: true });
    }
    const [downloadedFrame, generatedFrame, generatedBase] = await Promise.all([
      frameAt(await videoPath(downloaded.assetId), 1, SMALL),
      frameAt(await videoPath(generated.assetId), 1, SMALL),
      frameAt(generated.sourcePath, 1, SMALL),
    ]);
    expect(colorCount(downloadedFrame, MAGENTA, 90)).toBeGreaterThan(300);
    expect(colorCount(generatedFrame, MAGENTA, 90)).toBe(0);
    expect(changedBox(generatedBase, generatedFrame, SMALL, [0, SMALL.height * 0.3])).not.toBeNull();
    expect(changedBox(generatedBase, generatedFrame, SMALL, [SMALL.height * 0.5, SMALL.height])).toBeNull();
  }, testBudget(300_000));
});
