import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { createFs } from "videocity-engine";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

type TextContent = Array<{ type: string; text: string }>;

const PROJECT = "qart-proj";

function resultText(result: { content?: unknown; toolResult?: unknown }): string {
  if (result.content) return (result.content as TextContent)[0].text;
  const toolResult = result.toolResult as { content?: TextContent } | undefined;
  return toolResult?.content?.[0]?.text ?? "";
}

async function solidPng(
  width: number,
  height: number,
  rgb: { r: number; g: number; b: number },
): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: rgb,
    },
  })
    .png()
    .toBuffer();
}

describe("create_qart tool", () => {
  let client: Client | undefined;
  let tempDir: string;
  let fs: ReturnType<typeof createFs>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-create-qart-"));
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

  it("creates white and black artistic QR img- assets from a cover image", async () => {
    const coverId = await createImageAsset(
      "cover-photo",
      await solidPng(400, 400, { r: 200, g: 40, b: 80 }),
    );

    const result = await client!.callTool({
      name: "create_qart",
      arguments: {
        project_slug: PROJECT,
        image_slug: `@${coverId}`,
        value: "https://example.com/qart",
        size: 256,
        filter: "color",
      },
    });

    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(resultText(result)) as {
      white_asset_id: string;
      black_asset_id: string;
      value: string;
      size: number;
      filter: string;
      source_image: string;
    };
    expect(parsed.white_asset_id).toMatch(/^img-/);
    expect(parsed.black_asset_id).toMatch(/^img-/);
    expect(parsed.white_asset_id).not.toBe(parsed.black_asset_id);
    expect(parsed.value).toBe("https://example.com/qart");
    expect(parsed.size).toBe(256);
    expect(parsed.filter).toBe("color");
    expect(parsed.source_image).toBe(coverId);

    for (const assetId of [parsed.white_asset_id, parsed.black_asset_id]) {
      const manifest = await fs.getManifest(assetId, PROJECT, { includeDotfiles: true });
      expect(manifest.ok).toBe(true);
      if (!manifest.ok) return;
      const fileNames = new Set(manifest.value.files.map((file) => file.name));
      expect(fileNames.has("original.png")).toBe(true);
      expect(fileNames.has("landscape.jpg")).toBe(true);
      expect(fileNames.has("portrait.jpg")).toBe(true);
      expect(fileNames.has("square.jpg")).toBe(true);

      const read = await fs.readFile(assetId, "original.png", PROJECT);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      const buffer = Buffer.isBuffer(read.value) ? read.value : Buffer.from(read.value);
      const metadata = await sharp(buffer).metadata();
      expect(metadata.width).toBe(256);
      expect(metadata.height).toBe(256);
      expect(buffer.byteLength).toBeGreaterThan(100);
    }
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
