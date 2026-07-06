import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFs } from "videocity-engine";
import sharp from "sharp";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createTestClient } from "../test-client.js";
import { queue } from "../queue.js";

type TextContent = Array<{ type: string; text: string }>;

function makePng(): Promise<Buffer> {
  return sharp({
    create: { width: 10, height: 10, channels: 4, background: { r: 0, g: 255, b: 0, alpha: 1 } },
  }).png().toBuffer();
}

describe("generate_nano_banana_pro_google tool", () => {
  let client: Client;
  let tempDir: string;
  const originalKey = process.env.GOOGLE_FLOW_API_KEY;

  beforeEach(async () => {
    process.env.GOOGLE_FLOW_API_KEY = "test-key";
    tempDir = await mkdtemp(join(tmpdir(), "videocity-nbp-google-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "test-proj" },
    });
  });

  afterEach(async () => {
    if (originalKey) {
      process.env.GOOGLE_FLOW_API_KEY = originalKey;
    } else {
      delete process.env.GOOGLE_FLOW_API_KEY;
    }
    await client?.close();
    await queue.stop();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("enqueues a text-to-image job", async () => {
    const result = await client.callTool({
      name: "generate_nano_banana_pro_google",
      arguments: {
        project_slug: "test-proj",
        prompt: "a clean product photo",
        aspect_ratio: "1:1",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.img_asset_id).toMatch(/^img-/);
    expect(parsed.source_images).toEqual([]);
  });

  it("enqueues with reference images resolved to asset inputs", async () => {
    const fs = createFs({ projectsDir: tempDir });
    const imageAsset = await fs.createAsset("img", "style-ref", "test-proj");
    if (!imageAsset.ok) throw new Error("Failed to create image asset");
    await fs.writeFile(imageAsset.value.assetId, "original.png", await makePng(), "test-proj");

    const result = await client.callTool({
      name: "generate_nano_banana_pro_google",
      arguments: {
        project_slug: "test-proj",
        prompt: "same style, new scene",
        image_slugs: [`@${imageAsset.value.assetId}`],
        aspect_ratio: "auto",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.source_images).toEqual([imageAsset.value.assetId]);
  });

  it("rejects aspect_ratio 'auto' without reference images", async () => {
    const result = await client.callTool({
      name: "generate_nano_banana_pro_google",
      arguments: {
        project_slug: "test-proj",
        prompt: "a sunset",
        aspect_ratio: "auto",
      },
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("requires at least one reference image");
  });
});
