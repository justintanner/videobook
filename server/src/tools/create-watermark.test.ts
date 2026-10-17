import { createEngineForTest } from "../engine.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import jsQRImport from "jsqr";

const jsQR = jsQRImport as unknown as (
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options?: { inversionAttempts?: string },
) => { data: string } | null;
import { createTestClient } from "../test-client.js";
import { readWatermarkConfig } from "../watermark-config.js";
import { BADGE_HEIGHT, BADGE_WIDTH, WATERMARK_BADGE_LAYOUT } from "../watermark-badge.js";
import type { Client } from "@modelcontextprotocol/client";

async function decodeQr(png: Buffer): Promise<string | null> {
  const { data, info } = await sharp(png)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const decoded = jsQR(new Uint8ClampedArray(data), info.width, info.height);
  return decoded?.data ?? null;
}

type TextContent = Array<{ type: string; text: string }>;

const PROJECT = "watermark-proj";

function resultText(result: { content?: unknown; toolResult?: unknown }): string {
  if (result.content) return (result.content as TextContent)[0].text;
  const toolResult = result.toolResult as { content?: TextContent } | undefined;
  return toolResult?.content?.[0]?.text ?? "";
}

describe("create_watermark tool", () => {
  let client: Client | undefined;
  let tempDir: string;
  let fs: ReturnType<typeof createEngineForTest>;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    originalEnv = { ...process.env };
    tempDir = await mkdtemp(join(tmpdir(), "videocity-create-watermark-"));
    delete process.env.X_ACCESS_TOKEN;
    
    fs = createEngineForTest(tempDir);
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: PROJECT },
    });
  });

  afterEach(async () => {
    await client?.close();
    process.env = originalEnv;
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("creates a TikTok badge and remembers its alias independently of X", async () => {
    const result = await client!.callTool({
      name: "create_watermark_card",
      arguments: { book_id: PROJECT, platform: "tiktok", handle: "  @creator.name ", save_default: true },
    });
    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(resultText(result)) as { asset_id: string; url: string };
    expect(parsed).toMatchObject({
      platform: "tiktok", handle: "creator.name", url: "https://www.tiktok.com/@creator.name",
      include_platform_icon: true,
    });
    const png = await fs.files.read(parsed.asset_id, "original.png");
    if (!png.ok) throw new Error(png.error.message);
    expect(await decodeQr(Buffer.from(png.value))).toBe(parsed.url);
    const metadata = await fs.metadata.artifacts.read(parsed.asset_id, "original");
    expect(metadata.ok && metadata.value).toMatchObject({
      platform: "tiktok", include_platform_icon: true, include_x_icon: false,
    });
    const config = await client!.callTool({
      name: "get_watermark_config",
      arguments: { book_id: PROJECT, platform: "tiktok" },
    });
    expect(JSON.parse(resultText(config))).toMatchObject({
      savedHandle: "creator.name", recent: ["creator.name"], authenticatedHandle: null,
      profile: { handle: "creator.name", platform: "tiktok" },
    });
    expect((await readWatermarkConfig(fs)).savedHandle).toBeNull();
    const saved = await client!.callTool({
      name: "create_watermark_card",
      arguments: { book_id: PROJECT, platform: "tiktok", include_platform_icon: false },
    });
    expect(JSON.parse(resultText(saved))).toMatchObject({ handle: "creator.name", include_platform_icon: false });
  });

  it("uses the TikTok alias instead of the X default", async () => {
    const result = await client!.callTool({
      name: "create_watermark_card",
      arguments: { book_id: PROJECT, platform: "tiktok" },
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(resultText(result))).toMatchObject({
      platform: "tiktok",
      handle: "jtbkk",
      url: "https://www.tiktok.com/@jtbkk",
    });
  });

  it("creates a ready image asset holding the QR card", async () => {
    const result = await client!.callTool({
      name: "create_watermark_card",
      arguments: {
        book_id: PROJECT,
        platform: "x",
        handle: "@someone",
        include_platform_icon: false,
        include_handle_border: false,
        handle_padding: 64,
        handle_rounding: 25,
      },
    });

    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(resultText(result)) as {
      asset_id: string;
      handle: string;
      url: string;
      include_platform_icon: boolean;
      include_handle_border: boolean;
      handle_padding: number;
      handle_padding_y: number;
      handle_rounding: number;
    };
    const artifact = fs.artifacts.get(parsed.asset_id);
    expect(artifact.ok && artifact.value.kind).toBe("image");
    expect(parsed.handle).toBe("someone");
    expect(parsed.url).toBe("https://x.com/someone");
    expect(parsed.include_platform_icon).toBe(false);
    expect(parsed).not.toHaveProperty("include_x_icon");
    expect(parsed.include_handle_border).toBe(false);
    expect(parsed.handle_padding).toBe(64);
    expect(parsed.handle_padding_y).toBe(32);
    expect(parsed.handle_rounding).toBe(25);

    const manifest = await fs.files.manifest(parsed.asset_id);
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;
    const fileNames = new Set(manifest.value.files.map((file) => file.name));
    expect(fileNames.has("original.png")).toBe(true);
    expect(fileNames.has("landscape.jpg")).toBe(true);
    expect(fileNames.has("portrait.jpg")).toBe(true);
    expect(fileNames.has("square.jpg")).toBe(true);

    const read = await fs.files.read(parsed.asset_id, "original.png");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const buffer = Buffer.isBuffer(read.value) ? read.value : Buffer.from(read.value);
    const metadata = await sharp(buffer).metadata();
    // TILE 480 (QR 384 + 2*TILE_PAD 48) wide; TILE 480 + GAP 12 + PILL 88 tall.
    expect(metadata.width).toBe(BADGE_WIDTH);
    expect(metadata.height).toBe(BADGE_HEIGHT);
    // The floating badge sits on a transparent canvas.
    expect(metadata.hasAlpha).toBe(true);

    // The ECC-H QR must decode to the handle's URL.
    expect(await decodeQr(buffer)).toBe("https://x.com/someone");

    const originalMeta = await fs.metadata.artifacts.read<Record<string, unknown>>(parsed.asset_id, "original");
    expect(originalMeta.ok && originalMeta.value.layout).toBe(WATERMARK_BADGE_LAYOUT);
    expect(originalMeta.ok && originalMeta.value.origin).toBe("watermark");
    expect(originalMeta.ok && originalMeta.value.include_x_icon).toBe(false);
    expect(originalMeta.ok && originalMeta.value.include_handle_border).toBe(false);
    expect(originalMeta.ok && originalMeta.value.handle_padding).toBe(64);
    expect(originalMeta.ok && originalMeta.value.handle_padding_y).toBe(32);
    expect(originalMeta.ok && originalMeta.value.handle_rounding).toBe(25);
  });

  it("defaults the handle and derives the X URL", async () => {
    const result = await client!.callTool({
      name: "create_watermark_card",
      arguments: { book_id: PROJECT, platform: "x" },
    });

    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(resultText(result)) as {
      handle: string;
      url: string;
      handle_padding: number;
      handle_padding_y: number;
      handle_rounding: number;
    };
    expect(parsed.handle).toBe("justinwtanner");
    expect(parsed.url).toBe("https://x.com/justinwtanner");
    expect(parsed.handle_padding).toBe(32);
    expect(parsed.handle_padding_y).toBe(32);
    expect(parsed.handle_rounding).toBe(100);
  });

  it("remembers used handles and the saved default", async () => {
    await client!.callTool({
      name: "create_watermark_card",
      arguments: { book_id: PROJECT, platform: "x", handle: "alice", save_default: true },
    });
    await client!.callTool({
      name: "create_watermark_card",
      arguments: { book_id: PROJECT, platform: "x", handle: "@bob" },
    });

    // Most-recent-first; saved default stays pinned to the save_default handle.
    const config = await readWatermarkConfig(fs);
    expect(config.recent).toEqual(["bob", "alice"]);
    expect(config.savedHandle).toBe("alice");

    // get_watermark_config exposes the same state to the client.
    const cfgResult = await client!.callTool({
      name: "get_watermark_config",
      arguments: { book_id: PROJECT, platform: "x" },
    });
    expect(cfgResult.isError).not.toBe(true);
    const exposed = JSON.parse(resultText(cfgResult)) as { savedHandle: string | null; recent: string[]; authenticatedHandle: string | null };
    expect(exposed.savedHandle).toBe("alice");
    expect(exposed.recent).toEqual(["bob", "alice"]);
    // authenticatedHandle is null in tests because no X access token is configured.
    expect(exposed.authenticatedHandle).toBeNull();
  });
});
