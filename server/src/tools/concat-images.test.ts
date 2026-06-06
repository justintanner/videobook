import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { createFs } from "vc-engine";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

type TextContent = Array<{ type: string; text: string }>;
type Pixel = [number, number, number, number];

const PROJECT = "concat-proj";

function resultText(result: { content?: unknown; toolResult?: unknown }): string {
  if (result.content) return (result.content as TextContent)[0].text;
  const toolResult = result.toolResult as { content?: TextContent } | undefined;
  return toolResult?.content?.[0]?.text ?? "";
}

async function solidPng(width: number, height: number, rgb: { r: number; g: number; b: number }): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: rgb,
    },
  }).png().toBuffer();
}

async function pixelsFor(buffer: Buffer): Promise<{ pixel: (x: number, y: number) => Pixel }> {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    pixel: (x, y) => {
      const offset = (y * info.width + x) * info.channels;
      return [data[offset], data[offset + 1], data[offset + 2], data[offset + 3]];
    },
  };
}

function expectRgb(pixel: Pixel, rgb: { r: number; g: number; b: number }): void {
  expect(pixel[0]).toBeGreaterThanOrEqual(rgb.r - 8);
  expect(pixel[0]).toBeLessThanOrEqual(rgb.r + 8);
  expect(pixel[1]).toBeGreaterThanOrEqual(rgb.g - 8);
  expect(pixel[1]).toBeLessThanOrEqual(rgb.g + 8);
  expect(pixel[2]).toBeGreaterThanOrEqual(rgb.b - 8);
  expect(pixel[2]).toBeLessThanOrEqual(rgb.b + 8);
}

describe("concat_images tool", () => {
  let client: Client | undefined;
  let tempDir: string;
  let fs: ReturnType<typeof createFs>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-concat-images-"));
    fs = createFs({ projectsDir: tempDir });
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: PROJECT },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function createImageAsset(name: string, buffer: Buffer): Promise<string> {
    const asset = await fs.createAsset("img", name, PROJECT);
    if (!asset.ok) throw new Error(asset.error.message);
    const write = await fs.writeFile(asset.value.assetId, "original.png", buffer, PROJECT);
    if (!write.ok) throw new Error(write.error.message);
    return asset.value.assetId;
  }

  it("creates a 16:9 image asset while fitting sources without stretching", async () => {
    const wide = await createImageAsset("wide-red", await solidPng(1600, 900, { r: 255, g: 0, b: 0 }));
    const tall = await createImageAsset("tall-blue", await solidPng(900, 1600, { r: 0, g: 0, b: 255 }));

    const result = await client!.callTool({
      name: "concat_images",
      arguments: {
        project_slug: PROJECT,
        image_slugs: [`@${wide}`, `@${tall}`],
      },
    });

    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(resultText(result)) as {
      img_asset_id: string;
      width: number;
      height: number;
      layout: string;
      aspect_ratio: string;
    };
    expect(parsed.img_asset_id).toMatch(/^img-/);
    expect(parsed.width).toBe(1920);
    expect(parsed.height).toBe(1080);
    expect(parsed.layout).toBe("horizontal");
    expect(parsed.aspect_ratio).toBe("16:9");

    const manifest = await fs.getManifest(parsed.img_asset_id, PROJECT, { includeDotfiles: true });
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;
    const fileNames = new Set(manifest.value.files.map((file) => file.name));
    expect(fileNames.has(".original.json")).toBe(true);
    expect(fileNames.has("landscape.jpg")).toBe(true);
    expect(fileNames.has("original.png")).toBe(true);
    expect(fileNames.has("portrait.jpg")).toBe(true);
    expect(fileNames.has("square.jpg")).toBe(true);

    const read = await fs.readFile(parsed.img_asset_id, "original.png", PROJECT);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const buffer = Buffer.isBuffer(read.value) ? read.value : Buffer.from(read.value);
    const metadata = await sharp(buffer).metadata();
    expect(metadata.width).toBe(1920);
    expect(metadata.height).toBe(1080);

    const pixels = await pixelsFor(buffer);
    expectRgb(pixels.pixel(480, 120), { r: 0, g: 0, b: 0 });
    expectRgb(pixels.pixel(480, 540), { r: 255, g: 0, b: 0 });
    expectRgb(pixels.pixel(980, 540), { r: 0, g: 0, b: 0 });
    expectRgb(pixels.pixel(1440, 540), { r: 0, g: 0, b: 255 });
  });

  it("returns an error when a referenced asset has no image file", async () => {
    const asset = await fs.createAsset("img", "empty", PROJECT);
    if (!asset.ok) throw new Error(asset.error.message);
    const write = await fs.writeFile(asset.value.assetId, "notes.txt", "hello", PROJECT);
    if (!write.ok) throw new Error(write.error.message);

    const result = await client!.callTool({
      name: "concat_images",
      arguments: {
        project_slug: PROJECT,
        image_slugs: [`@${asset.value.assetId}`, "@img-missing"],
      },
    });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain(`No image file found in asset ${asset.value.assetId}`);
  });
});
