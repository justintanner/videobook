import { createEngineForTest } from "../engine.js";
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findVideoFile } from "videobook-engine";
import { createTestClient } from "../test-client.js";
import { probeVideo } from "../ffmpeg.js";
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
  handle: string;
  url: string;
  include_qr: boolean;
  opacity: number;
  scale: number;
  requested_position: string;
  start_seconds: number | null;
  end_seconds: number | null;
  mode: string;
  positions?: Record<(typeof ORIENTATIONS)[number], string>;
  position?: string;
  placement_source: string;
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

  async function createVideoAsset(): Promise<string> {
    const created = await fs.artifacts.create("vid", "clip");
    if (!created.ok) throw new Error(created.error.message);
    const write = await fs.files.write(created.value.artifactId, "original.mp4", Buffer.from("fake-video"));
    if (!write.ok) throw new Error(write.error.message);
    return created.value.artifactId;
  }

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
      arguments: { book_id: bookId, ...args },
    });
    expect(result.isError).toBeFalsy();
    return JSON.parse((result.content as TextContent)[0].text) as ApplyResult;
  }

  it("falls back to the analyze-video corner and stores faint whole-clip settings", async () => {
    const assetId = await createVideoAsset();
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
    const assetId = await createVideoAsset();
    const parsed = await apply({ asset_id: assetId, handle: "someone", mode: "overlay" });
    expect(parsed.placement_source).toBe("default");
    expect(parsed.positions?.landscape).toBe("bottom-right");
  });

  it("stores explicit placement, timing, and a handle-only badge", async () => {
    const assetId = await createVideoAsset();
    const parsed = await apply({
      asset_id: assetId,
      handle: "someone",
      include_qr: false,
      position: "middle-center",
      start_seconds: 0.25,
      end_seconds: 0.75,
      mode: "overlay",
    });

    expect(parsed.include_qr).toBe(false);
    expect(parsed.requested_position).toBe("middle-center");
    expect(parsed.start_seconds).toBe(0.25);
    expect(parsed.end_seconds).toBe(0.75);
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
    expect(cardMeta.value.layout).toBe("handle-v1");
    expect(cardMeta.value.include_qr).toBe(false);
    expect(cardMeta.value.height).toBe(88);

    for (const orient of ORIENTATIONS) {
      const meta = await fs.metadata.artifacts.read<Record<string, unknown>>(assetId, `${orient}.render`);
      if (!meta.ok) throw new Error(`missing ${orient}.render`);
      expect(meta.value.osgPosition).toBe("middle-center");
      expect(meta.value.osgStartSeconds).toBe(0.25);
      expect(meta.value.osgEndSeconds).toBe(0.75);
    }
  });

  it("reuses the badge asset across applies and honors custom opacity/scale", async () => {
    const firstAsset = await createVideoAsset();
    const secondAsset = await createVideoAsset();

    const first = await apply({ asset_id: firstAsset, handle: "someone", mode: "overlay" });
    const second = await apply({
      asset_id: secondAsset,
      handle: "someone",
      mode: "overlay",
      opacity: 0.35,
      scale: 1.5,
    });

    expect(second.card_asset_id).toBe(first.card_asset_id);
    expect(second.opacity).toBe(0.35);
    const meta = await fs.metadata.artifacts.read<Record<string, unknown>>(secondAsset, "portrait.render");
    if (!meta.ok) throw new Error("missing portrait.render");
    expect(meta.value.osgOpacity).toBe(0.35);
    expect(meta.value.osgScale).toBeCloseTo(watermarkOsgScale("portrait", 1.5), 4);

    // A different handle mints a fresh badge instead of reusing the old one.
    const other = await apply({ asset_id: firstAsset, handle: "other", mode: "overlay" });
    expect(other.card_asset_id).not.toBe(first.card_asset_id);
  });

  it("records handles and defaults to the saved handle", async () => {
    const assetId = await createVideoAsset();
    await apply({ asset_id: assetId, handle: "alice", save_default: true, mode: "overlay" });

    const config = await readWatermarkConfig(fs);
    expect(config.savedHandle).toBe("alice");
    expect(config.recent[0]).toBe("alice");

    const parsed = await apply({ asset_id: assetId, mode: "overlay" });
    expect(parsed.handle).toBe("alice");
  });

  it("burns the badge into the video by default and clears overlay settings", async () => {
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
      include_qr: false,
      position: "top-center",
      start_seconds: 0.2,
      end_seconds: 0.8,
    });
    expect(parsed.mode).toBe("burn");
    expect(parsed.position).toBe("top-center");
    expect(parsed.placement_source).toBe("explicit");
    expect(parsed.include_qr).toBe(false);
    expect(parsed.start_seconds).toBe(0.2);
    expect(parsed.end_seconds).toBe(0.8);

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

    // The burned badge replaces the render-time overlay; settings are cleared
    // so a later render can't stamp the watermark twice.
    for (const orient of ORIENTATIONS) {
      const meta = await fs.metadata.artifacts.read<Record<string, unknown>>(assetId, `${orient}.render`);
      if (!meta.ok) throw new Error(`missing ${orient}.render`);
      expect(meta.value.osgAssetId).toBeNull();
      expect(meta.value.osgOpacity).toBe(1);
    }
  }, 120_000);

  it("rejects non-video targets", async () => {
    const created = await fs.artifacts.create("img", "still");
    if (!created.ok) throw new Error(created.error.message);
    const result = await client.callTool({
      name: "apply_watermark",
      arguments: { book_id: bookId, asset_id: created.value.artifactId },
    });
    expect(result.isError).toBe(true);
  });

  it("rejects an empty timing window", async () => {
    const assetId = await createVideoAsset();
    const result = await client.callTool({
      name: "apply_watermark",
      arguments: {
        book_id: bookId,
        asset_id: assetId,
        start_seconds: 0.8,
        end_seconds: 0.2,
      },
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("end_seconds");
  });
});
