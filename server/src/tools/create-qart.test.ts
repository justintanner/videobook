import { createEngineForTest } from "../fs.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import jsQR from "jsqr";
import QRCode from "qrcode";
import sharp from "sharp";
import { createTestClient } from "../test-client.js";
import {
  buildQartPng,
  QART_DARK_MAX,
  QART_LIGHT_MIN,
  QART_MIN_VERSION,
  QART_QUIET_MODULES,
} from "./create-qart.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

type TextContent = Array<{ type: string; text: string }>;

const PROJECT = "qart-proj";

function resultText(result: { content?: unknown; toolResult?: unknown }): string {
  if (result.content) return (result.content as TextContent)[0].text;
  const toolResult = result.toolResult as { content?: TextContent } | undefined;
  return toolResult?.content?.[0]?.text ?? "";
}

async function gradientPng(width: number, height: number): Promise<Buffer> {
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 3;
      data[index] = Math.round((x / Math.max(1, width - 1)) * 255);
      data[index + 1] = Math.round((y / Math.max(1, height - 1)) * 255);
      data[index + 2] = Math.round((((x + y) % width) / Math.max(1, width - 1)) * 255);
    }
  }
  return sharp(data, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

async function decodeQr(buffer: Buffer): Promise<string | null> {
  const raw = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return jsQR(
    Uint8ClampedArray.from(raw.data),
    raw.info.width,
    raw.info.height,
    { inversionAttempts: "dontInvert" },
  )?.data ?? null;
}

describe("create_qart tool", () => {
  let client: Client | undefined;
  let tempDir: string;
  let fs: ReturnType<typeof createEngineForTest>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-create-qart-"));
    fs = createEngineForTest(tempDir);
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
    const asset = await fs.artifacts.create("img", name, PROJECT);
    if (!asset.ok) throw new Error(asset.error.message);
    const write = await fs.files.write(asset.value.slug, "original.png", buffer, PROJECT);
    if (!write.ok) throw new Error(write.error.message);
    return asset.value.slug;
  }

  async function readAssetFile(assetId: string, name: string): Promise<Buffer> {
    const read = await fs.files.read(assetId, name, PROJECT);
    if (!read.ok) throw new Error(read.error.message);
    return Buffer.isBuffer(read.value) ? read.value : Buffer.from(read.value);
  }

  it("creates scan-safe inverted and monochrome QR mosaic assets by default", async () => {
    const coverId = await createImageAsset("cover-photo", await gradientPng(500, 400));
    const value = "https://example.com/qart";
    const size = 630;
    const result = await client!.callTool({
      name: "create_qart",
      arguments: {
        project_slug: PROJECT,
        image_slug: `@${coverId}`,
        value,
        size,
      },
    });

    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(resultText(result)) as {
      inverted_asset_id: string;
      monochrome_asset_id: string;
      value: string;
      size: number;
      source_image: string;
      qr_version: number;
    };
    expect(parsed.inverted_asset_id).toMatch(/^img-/);
    expect(parsed.monochrome_asset_id).toMatch(/^img-/);
    expect(parsed.inverted_asset_id).not.toBe(parsed.monochrome_asset_id);
    expect(parsed.value).toBe(value);
    expect(parsed.size).toBe(size);
    expect(parsed.source_image).toBe(coverId);
    expect(parsed.qr_version).toBe(QART_MIN_VERSION);

    for (const assetId of [parsed.inverted_asset_id, parsed.monochrome_asset_id]) {
      const manifest = await fs.files.manifest(assetId, PROJECT, { includeDotfiles: true });
      expect(manifest.ok).toBe(true);
      if (!manifest.ok) return;
      const fileNames = new Set(manifest.value.files.map((file) => file.name));
      for (const filename of [
        "original.png",
        "landscape.jpg",
        "portrait.jpg",
        "square.jpg",
      ]) {
        expect(fileNames.has(filename)).toBe(true);
      }

      for (const filename of ["original.png", "landscape.jpg", "portrait.jpg", "square.jpg"]) {
        expect(await decodeQr(await readAssetFile(assetId, filename))).toBe(value);
      }

      const metadata = await fs.metadata.artifacts.read(assetId, "original", PROJECT);
      expect(metadata.ok).toBe(true);
      if (!metadata.ok) return;
      expect(metadata.value).toMatchObject({
        origin: "create_qart",
        qart_style: "module_mosaic",
        value,
        source_image: coverId,
        width: size,
        height: size,
        qr_version: QART_MIN_VERSION,
        error_correction: "H",
        quiet_zone_modules: QART_QUIET_MODULES,
      });
    }

    const invertedBuffer = await readAssetFile(parsed.inverted_asset_id, "original.png");
    const raw = await sharp(invertedBuffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const qr = QRCode.create(value, { errorCorrectionLevel: "H", version: parsed.qr_version });
    const totalModules = qr.modules.size + QART_QUIET_MODULES * 2;
    const modulePx = Math.floor(size / totalModules);
    const pixel = (x: number, y: number): [number, number, number] => {
      const index = (y * raw.info.width + x) * raw.info.channels;
      return [raw.data[index], raw.data[index + 1], raw.data[index + 2]];
    };
    expect(pixel(0, 0)).toEqual([255, 255, 255]);
    expect(pixel(QART_QUIET_MODULES * modulePx - 1, QART_QUIET_MODULES * modulePx - 1))
      .toEqual([255, 255, 255]);

    for (let row = 0; row < qr.modules.size; row++) {
      for (let col = 0; col < qr.modules.size; col++) {
        const x = (col + QART_QUIET_MODULES) * modulePx;
        const y = (row + QART_QUIET_MODULES) * modulePx;
        const topLeft = pixel(x, y);
        const bottomRight = pixel(x + modulePx - 1, y + modulePx - 1);
        expect(bottomRight).toEqual(topLeft);
        const dark = qr.modules.get(row, col) === 1;
        if (qr.modules.isReserved(row, col)) {
          expect(topLeft).toEqual(dark ? [0, 0, 0] : [255, 255, 255]);
        } else {
          for (const channel of topLeft) {
            expect(dark ? channel <= QART_DARK_MAX : channel >= QART_LIGHT_MIN).toBe(true);
          }
          expect(topLeft[0]).toBe(topLeft[1]);
          expect(topLeft[1]).toBe(topLeft[2]);
        }
      }
    }

    const monochromeBuffer = await readAssetFile(parsed.monochrome_asset_id, "original.png");
    const monochromeRaw = await sharp(monochromeBuffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let row = 0; row < qr.modules.size; row++) {
      for (let col = 0; col < qr.modules.size; col++) {
        const x = (col + QART_QUIET_MODULES) * modulePx + Math.floor(modulePx / 2);
        const y = (row + QART_QUIET_MODULES) * modulePx + Math.floor(modulePx / 2);
        const index = (y * monochromeRaw.info.width + x) * monochromeRaw.info.channels;
        expect(monochromeRaw.data[index]).toBe(monochromeRaw.data[index + 1]);
        expect(monochromeRaw.data[index + 1]).toBe(monochromeRaw.data[index + 2]);
      }
    }
  });

  it("preserves explicit style when provided", async () => {
    const coverId = await createImageAsset("explicit-style", await gradientPng(500, 400));
    const result = await client!.callTool({
      name: "create_qart",
      arguments: {
        project_slug: PROJECT,
        image_slug: coverId,
        value: "https://example.com/color",
        style: "color",
      },
    });
    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(resultText(result)) as { style: string };
    expect(parsed.style).toBe("color");
  });

  it("uses a larger QR version for long payloads", async () => {
    const value = `https://example.com/?payload=${"x".repeat(700)}`;
    const rendered = await buildQartPng(value, await gradientPng(500, 500), {
      size: 1400,
      style: "color",
    });
    expect(rendered.qrVersion).toBeGreaterThan(QART_MIN_VERSION);
    expect(rendered.width).toBe(1400);
    expect(rendered.height).toBe(1400);
    expect(await decodeQr(rendered.buffer)).toBe(value);
  });

  it("rejects sizes that cannot preserve three pixels per module", async () => {
    const coverId = await createImageAsset("small-cover", await gradientPng(100, 100));
    const result = await client!.callTool({
      name: "create_qart",
      arguments: {
        project_slug: PROJECT,
        image_slug: coverId,
        value: "https://example.com",
        size: 256,
      },
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("minimum is 315px");
  });

  it("rejects non-img assets", async () => {
    const result = await client!.callTool({
      name: "create_qart",
      arguments: {
        project_slug: PROJECT,
        image_slug: "vid-not-an-image",
        value: "https://example.com",
      },
    });
    expect(result.isError).toBe(true);
  });

  it("rejects missing cover images", async () => {
    const result = await client!.callTool({
      name: "create_qart",
      arguments: {
        project_slug: PROJECT,
        image_slug: "@img-does-not-exist",
        value: "https://example.com",
      },
    });
    expect(result.isError).toBe(true);
  });
});
