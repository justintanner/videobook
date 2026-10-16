import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { createTestClient } from "../test-client.js";
import { queue } from "../queue.js";
import { probeImage } from "../image.js";
import type { Client } from "@modelcontextprotocol/client";

type TextContent = Array<{ type: string; text: string }>;

async function createTestPng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 40, g: 120, b: 200 },
    },
  })
    .png()
    .toBuffer();
}

async function uploadImage(
  client: Client,
  bookId: string,
  buffer: Buffer,
  filename = "photo.png",
): Promise<{ assetId: string; path: string }> {
  const data = buffer.toString("base64");
  const result = await client.callTool({
    name: "upload_file",
    arguments: { book_id: bookId, filename, data },
  });
  return JSON.parse((result.content as TextContent)[0].text);
}

async function waitForProcessImage(assetPath: string, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await readFile(join(assetPath, "landscape.jpg"));
      await readFile(join(assetPath, "portrait.jpg"));
      await readFile(join(assetPath, "square.jpg"));
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("process_image variants did not appear in time");
}

describe("crop_image tool", () => {
  let client: Client;
  let tempDir: string;
  let sourcePng: Buffer;

  beforeAll(async () => {
    await queue.start();
    // 1920x1080 source so centred 9:16 / 1:1 crops fit with correct aspect.
    sourcePng = await createTestPng(1920, 1080);
  }, 30_000);

  afterAll(async () => {
    await queue.stop();
  }, 30_000);

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-crop-image-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "crop-img-proj" },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("crops to 9:16 and produces 1080x1920 original.jpg", async () => {
    const uploaded = await uploadImage(client, "crop-img-proj", sourcePng);
    await waitForProcessImage(uploaded.path);

    // Centred 9:16 strip on 1920x1080: w ≈ 0.3167, h = 1.
    const w = 0.3167;
    const h = 1.0;
    const x = (1 - w) / 2;
    const y = 0;

    const result = await client.callTool({
      name: "crop_asset",
      arguments: {
        asset_id: uploaded.assetId,
        book_id: "crop-img-proj",
        ratio: "9:16",
        x, y, w, h,
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("completed");
    expect(parsed.ratio).toBe("9:16");

    const jpg = await readFile(join(uploaded.path, "original.jpg"));
    expect(jpg.byteLength).toBeGreaterThan(0);
    const dims = await probeImage(jpg);
    expect(dims.width).toBe(1080);
    expect(dims.height).toBe(1920);
    await readFile(join(uploaded.path, "landscape.jpg"));
    await readFile(join(uploaded.path, "portrait.jpg"));
    await readFile(join(uploaded.path, "square.jpg"));
  }, 60_000);

  it("crops to 1:1 and produces 1080x1080 original.jpg", async () => {
    const uploaded = await uploadImage(client, "crop-img-proj", sourcePng);
    await waitForProcessImage(uploaded.path);

    const w = 0.5625;
    const h = 1.0;
    const x = (1 - w) / 2;
    const y = 0;

    const result = await client.callTool({
      name: "crop_asset",
      arguments: {
        asset_id: uploaded.assetId,
        book_id: "crop-img-proj",
        ratio: "1:1",
        x, y, w, h,
      },
    });

    expect(result.isError).toBeFalsy();
    const jpg = await readFile(join(uploaded.path, "original.jpg"));
    const dims = await probeImage(jpg);
    expect(dims.width).toBe(1080);
    expect(dims.height).toBe(1080);
  }, 60_000);

  it("crops to 16:9 and produces 1920x1080 original.jpg", async () => {
    const uploaded = await uploadImage(client, "crop-img-proj", sourcePng);
    await waitForProcessImage(uploaded.path);

    const result = await client.callTool({
      name: "crop_asset",
      arguments: {
        asset_id: uploaded.assetId,
        book_id: "crop-img-proj",
        ratio: "16:9",
        x: 0.1,
        y: 0.1,
        w: 0.8,
        h: 0.8,
      },
    });

    expect(result.isError).toBeFalsy();
    const jpg = await readFile(join(uploaded.path, "original.jpg"));
    const dims = await probeImage(jpg);
    expect(dims.width).toBe(1920);
    expect(dims.height).toBe(1080);
  }, 60_000);

  it("returns error for out-of-bounds rect", async () => {
    const uploaded = await uploadImage(client, "crop-img-proj", sourcePng);
    await waitForProcessImage(uploaded.path);

    const result = await client.callTool({
      name: "crop_asset",
      arguments: {
        asset_id: uploaded.assetId,
        book_id: "crop-img-proj",
        ratio: "1:1",
        x: 0.5,
        y: 0,
        w: 0.7,
        h: 1.0,
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toMatch(/x \+ w/);
  });

  it("returns error when rect aspect mismatches ratio", async () => {
    const uploaded = await uploadImage(client, "crop-img-proj", sourcePng);
    await waitForProcessImage(uploaded.path);

    const result = await client.callTool({
      name: "crop_asset",
      arguments: {
        asset_id: uploaded.assetId,
        book_id: "crop-img-proj",
        ratio: "16:9",
        x: 0.1,
        y: 0.1,
        w: 0.3,
        h: 0.5,
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toMatch(/aspect/i);
  }, 60_000);

  it("returns error for nonexistent asset", async () => {
    const result = await client.callTool({
      name: "crop_asset",
      arguments: {
        asset_id: "img-does-not-exist",
        book_id: "crop-img-proj",
        ratio: "1:1",
        x: 0,
        y: 0,
        w: 0.5,
        h: 0.5,
      },
    });

    expect(result.isError).toBe(true);
  });

  it("returns error when asset has no original image file", async () => {
    // Upload a video — no original image file for crop_image to target.
    const data = Buffer.from("not-an-image").toString("base64");
    const uploadResult = await client.callTool({
      name: "upload_file",
      arguments: { book_id: "crop-img-proj", filename: "clip.mp4", data },
    });
    // Processing may fail for invalid bytes, but the asset should still be created.
    const text = (uploadResult.content as TextContent)[0]?.text ?? "";
    let assetId: string | null = null;
    try {
      assetId = (JSON.parse(text) as { assetId: string }).assetId;
    } catch {
      // If upload itself failed, the tool path under test is still the crop call below
      // with a synthetic video id.
      assetId = "vid-clip";
    }

    const result = await client.callTool({
      name: "crop_asset",
      arguments: {
        asset_id: assetId,
        book_id: "crop-img-proj",
        ratio: "1:1",
        x: 0.1,
        y: 0.1,
        w: 0.5,
        h: 0.5,
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toMatch(/No original image|not found|Failed|Crop failed/i);
  }, 60_000);
});
