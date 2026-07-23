import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import jsQR from "jsqr";
import sharp from "sharp";
import { createFs, type VideocityFs } from "videobook-engine";
import { createTestClient } from "../test-client.js";
import { buildQrbtfPng, DEFAULT_QRBTF_SIZE } from "./create-qrbtf.js";
import type { QrbtfParams } from "./qrbtf-render.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

type TextContent = Array<{ type: string; text: string }>;

const PROJECT = "qrbtf-proj";

function resultText(result: { content?: unknown; toolResult?: unknown }): string {
  if (result.content) return (result.content as TextContent)[0].text;
  const toolResult = result.toolResult as { content?: TextContent } | undefined;
  return toolResult?.content?.[0]?.text ?? "";
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
    { inversionAttempts: "attemptBoth" },
  )?.data ?? null;
}

describe("create_qrbtf tool", () => {
  let client: Client | undefined;
  let tempDir: string;
  let fs: VideocityFs;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-create-qrbtf-"));
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

  async function readAssetFile(assetId: string, name: string): Promise<Buffer> {
    const read = await fs.readFile(assetId, name, PROJECT);
    if (!read.ok) throw new Error(read.error.message);
    return Buffer.isBuffer(read.value) ? read.value : Buffer.from(read.value);
  }

  const STYLES = ["normal", "line", "dsj", "bubble", "func"] as const;

  for (const style of STYLES) {
    it(`creates a ${style} QR asset with correct files and metadata`, async () => {
      const value = "https://example.com/qrbtf";
      const result = await client!.callTool({
        name: "create_qrbtf",
        arguments: {
          project_slug: PROJECT,
          value,
          style,
        },
      });

      expect(result.isError).not.toBe(true);
      const parsed = JSON.parse(resultText(result)) as {
        asset_id: string;
        value: string;
        style: string;
        size: number;
        qr_version: number;
        bg_color: string;
      };
      expect(parsed.asset_id).toMatch(/^img-/);
      expect(parsed.value).toBe(value);
      expect(parsed.style).toBe(style);
      expect(parsed.size).toBe(DEFAULT_QRBTF_SIZE);
      expect(parsed.bg_color).toBe("#000000");

      const manifest = await fs.getManifest(parsed.asset_id, PROJECT, { includeDotfiles: true });
      expect(manifest.ok).toBe(true);
      if (!manifest.ok) return;
      const fileNames = new Set(manifest.value.files.map((f) => f.name));
      for (const filename of [
        ".created_at",
        ".original.json",
        "original.png",
        "landscape.jpg",
        "portrait.jpg",
        "square.jpg",
      ]) {
        expect(fileNames.has(filename)).toBe(true);
      }

      const metadata = await fs.readMetadata(parsed.asset_id, "original", PROJECT);
      expect(metadata.ok).toBe(true);
      if (!metadata.ok) return;
      expect(metadata.value).toMatchObject({
        origin: "create_qrbtf",
        qrbtf_style: style,
        value,
        width: DEFAULT_QRBTF_SIZE,
        height: DEFAULT_QRBTF_SIZE,
        error_correction: "H",
        bg_color: "#000000",
      });

      const original = await readAssetFile(parsed.asset_id, "original.png");
      const meta = await sharp(original).metadata();
      expect(meta.width).toBe(DEFAULT_QRBTF_SIZE);
      expect(meta.height).toBe(DEFAULT_QRBTF_SIZE);

      const landscape = await readAssetFile(parsed.asset_id, "landscape.jpg");
      const landMeta = await sharp(landscape).metadata();
      expect(landMeta.width).toBe(1920);
      expect(landMeta.height).toBe(1080);

      const portrait = await readAssetFile(parsed.asset_id, "portrait.jpg");
      const portMeta = await sharp(portrait).metadata();
      expect(portMeta.width).toBe(1080);
      expect(portMeta.height).toBe(1920);
    });
  }

  it("decodes scannable QR for normal style with default black bg", async () => {
    const value = "https://example.com/scan-test";
    const rendered = await buildQrbtfPng(value, "normal", {}, 1024);
    expect(rendered.width).toBe(1024);
    expect(rendered.height).toBe(1024);
    expect(await decodeQr(rendered.buffer)).toBe(value);
  });

  it("decodes scannable QR for line style with default width", async () => {
    const value = "https://example.com/line-test";
    const rendered = await buildQrbtfPng(value, "line", { direction: "left-right" }, 1024);
    expect(await decodeQr(rendered.buffer)).toBe(value);
  });


  it("decodes scannable QR with round point type", async () => {
    const value = "https://example.com/round-test";
    const rendered = await buildQrbtfPng(value, "normal", { pointType: "round" }, 1024);
    expect(await decodeQr(rendered.buffer)).toBe(value);
  });

  it("decodes scannable QR with all line directions", async () => {
    const directions = [
      "left-right", "up-down", "h-v", "loop",
      "topLeft-bottomRight", "topRight-bottomLeft",
    ] as const;
    for (const direction of directions) {
      const value = `https://example.com/dir-${direction}`;
      const params: QrbtfParams = { direction };
      const rendered = await buildQrbtfPng(value, "line", params, 1024);
      expect(await decodeQr(rendered.buffer)).toBe(value);
    }
  });

  it("defaults to normal style when style is omitted", async () => {
    const result = await client!.callTool({
      name: "create_qrbtf",
      arguments: {
        project_slug: PROJECT,
        value: "https://example.com/default",
      },
    });
    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(resultText(result)) as { style: string };
    expect(parsed.style).toBe("normal");
  });

  it("accepts custom colors and background", async () => {
    const result = await client!.callTool({
      name: "create_qrbtf",
      arguments: {
        project_slug: PROJECT,
        value: "https://example.com/custom-colors",
        style: "normal",
        other_color: "#00FF00",
        pos_color: "#FF00FF",
        bg_color: "#1A1A2E",
      },
    });
    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(resultText(result)) as { asset_id: string; bg_color: string };
    expect(parsed.bg_color).toBe("#1A1A2E");

    const metadata = await fs.readMetadata(parsed.asset_id, "original", PROJECT);
    expect(metadata.ok).toBe(true);
    if (!metadata.ok) return;
    expect(metadata.value).toMatchObject({
      other_color: "#00FF00",
      pos_color: "#FF00FF",
      bg_color: "#1A1A2E",
    });
  });

  it("uses a larger QR version for long payloads", async () => {
    const value = `https://example.com/?payload=${"x".repeat(700)}`;
    const rendered = await buildQrbtfPng(value, "normal", {}, 1400);
    expect(rendered.qrVersion).toBeGreaterThan(10);
    expect(rendered.width).toBe(1400);
    expect(rendered.height).toBe(1400);
  });

  it("rejects empty value", async () => {
    const result = await client!.callTool({
      name: "create_qrbtf",
      arguments: {
        project_slug: PROJECT,
        value: "  ",
      },
    });
    expect(result.isError).toBe(true);
  });

  it("rejects sizes below 256", async () => {
    const result = await client!.callTool({
      name: "create_qrbtf",
      arguments: {
        project_slug: PROJECT,
        value: "https://example.com",
        size: 128,
      },
    });
    expect(result.isError).toBe(true);
  });
});
