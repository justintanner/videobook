import { createEngineForTest } from "../fs.js";
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createTestClient } from "../test-client.js";
import { queue } from "../queue.js";

type TextContent = Array<{ type: string; text: string }>;

function makePng(): Promise<Buffer> {
  return sharp({
    create: { width: 10, height: 10, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
  }).png().toBuffer();
}

describe("generate_veo3_video / generate_veo3_fast_video tools", () => {
  let client: Client;
  let tempDir: string;
  const originalKey = process.env.KIE_API_KEY;

  beforeEach(async () => {
    process.env.KIE_API_KEY = "test-key";
    tempDir = await mkdtemp(join(tmpdir(), "videocity-veo3-video-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "test-proj" },
    });
  });

  afterEach(async () => {
    if (originalKey) {
      process.env.KIE_API_KEY = originalKey;
    } else {
      delete process.env.KIE_API_KEY;
    }
    await client?.close();
    await queue.stop();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("returns error when KIE_API_KEY is not set", async () => {
    delete process.env.KIE_API_KEY;
    const result = await client.callTool({
      name: "generate_kie_veo_3_0_video",
      arguments: {
        book_id: "test-proj",
        prompt: "a beautiful sunset",
      },
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("KIE_API_KEY environment variable is not set");
  });

  it("enqueues veo3 job (text-to-video)", async () => {
    const result = await client.callTool({
      name: "generate_kie_veo_3_0_video",
      arguments: {
        book_id: "test-proj",
        prompt: "a beautiful sunset",
        aspect_ratio: "16:9",
        seed: 42,
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.vid_asset_id).toMatch(/^vid-/);
    expect(parsed.source_images).toEqual([]);
    expect(parsed.job_id).toBeDefined();
  });

  it("enqueues veo3_fast job (image-to-video)", async () => {
    const fs = createEngineForTest(tempDir);
    const imageAsset = await fs.artifacts.create("img", "source-img");
    if (!imageAsset.ok) throw new Error("Failed to create image asset");
    await fs.files.write(imageAsset.value.slug, "original.png", await makePng());

    const result = await client.callTool({
      name: "generate_kie_veo_3_0_fast_video",
      arguments: {
        book_id: "test-proj",
        prompt: "a fast car",
        image_slugs: [`@${imageAsset.value.slug}`],
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.vid_asset_id).toMatch(/^vid-/);
    expect(parsed.source_images).toEqual([imageAsset.value.slug]);
    expect(parsed.job_id).toBeDefined();
  });
});
