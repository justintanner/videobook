import { createEngineForTest } from "../fs.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const PROJECT = "invert-proj";

describe("invert_image tool", () => {
  let client: Client | undefined;
  let tempDir: string;
  let fs: ReturnType<typeof createEngineForTest>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-invert-image-"));
    fs = createEngineForTest(tempDir);
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: PROJECT },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("inverts an image asset in-place", async () => {
    const asset = await fs.artifacts.create("img", "test-image");
    expect(asset.ok).toBe(true);
    if (!asset.ok) return;

    // Create a 2x2 image, white on top, black on bottom
    const rawData = Buffer.from([
      255, 255, 255, 255, 255, 255, // white, white
      0, 0, 0, 0, 0, 0,             // black, black
    ]);
    const png = await sharp(rawData, { raw: { width: 2, height: 2, channels: 3 } }).png().toBuffer();
    await fs.files.write(asset.value.slug, "original.png", png);

    const result = await client!.callTool({
      name: "invert_image",
      arguments: {
        book_id: PROJECT,
        asset_id: asset.value.slug,
      },
    });

    if (result.isError) {
      throw new Error(`Tool failed: ${JSON.stringify(result.content)}`);
    }

    const read = await fs.files.read(asset.value.slug, "original.png");
    expect(read.ok).toBe(true);
    if (!read.ok) return;

    const invertedRaw = await sharp(Buffer.isBuffer(read.value) ? read.value : Buffer.from(read.value))
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Expect black on top, white on bottom
    expect(invertedRaw.data[0]).toBe(0);
    expect(invertedRaw.data[1]).toBe(0);
    expect(invertedRaw.data[2]).toBe(0);
    
    expect(invertedRaw.data[6]).toBe(255);
    expect(invertedRaw.data[7]).toBe(255);
    expect(invertedRaw.data[8]).toBe(255);
  });
});
