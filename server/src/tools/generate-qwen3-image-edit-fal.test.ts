import { createEngineForTest } from "../engine.js";
import { isUuidV7 } from "videobook-engine";
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import type { Client } from "@modelcontextprotocol/client";
import { createTestClient } from "../test-client.js";

type TextContent = Array<{ type: string; text: string }>;

function makePng(): Promise<Buffer> {
  return sharp({
    create: { width: 10, height: 10, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
  }).png().toBuffer();
}

describe("generate_fal_qwen_3_0_edit_image tool", () => {
  let client: Client;
  let tempDir: string;
  const originalKey = process.env.FAL_API_KEY;

  beforeEach(async () => {
    process.env.FAL_API_KEY = "test-key";
    tempDir = await mkdtemp(join(tmpdir(), "videobook-qwen3-fal-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "test-proj" },
    });
  });

  afterEach(async () => {
    if (originalKey) {
      process.env.FAL_API_KEY = originalKey;
    } else {
      delete process.env.FAL_API_KEY;
    }
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function makeImageAsset(): Promise<string> {
    const fs = createEngineForTest(tempDir);
    const asset = await fs.artifacts.create("img", "ref-img");
    if (!asset.ok) throw new Error("Failed to create image asset");
    await fs.files.write(asset.value.artifactId, "original.png", await makePng());
    return asset.value.artifactId;
  }

  it("returns error when FAL_API_KEY is not set", async () => {
    delete process.env.FAL_API_KEY;
    const imageId = await makeImageAsset();
    const result = await client.callTool({
      name: "generate_fal_qwen_3_0_edit_image",
      arguments: {
        book_id: "test-proj",
        prompt: "make the sky purple",
        image_refs: [`@${imageId}`],
      },
    });

    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("FAL_API_KEY environment variable is not set");
  });

  it("enqueues generate_qwen3_image_edit_fal job with one reference image", async () => {
    const imageId = await makeImageAsset();
    const fs = createEngineForTest(tempDir);
    const result = await client.callTool({
      name: "generate_fal_qwen_3_0_edit_image",
      arguments: {
        book_id: "test-proj",
        prompt: "make the sky purple",
        image_refs: [`@${imageId}`],
        image_size: "landscape_16_9",
        num_images: 2,
        output_format: "jpeg",
        enable_prompt_expansion: false,
        seed: 42,
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("enqueued");
    expect(isUuidV7(parsed.img_asset_id)).toBe(true);
    const created = fs.artifacts.get(parsed.img_asset_id);
    expect(created.ok).toBe(true);
    if (created.ok) expect(created.value.kind).toBe("image");
    expect(parsed.source_images).toEqual([imageId]);
    expect(parsed.job_id).toBeDefined();
  });

  it("enqueues with three ordered reference images, preserving order", async () => {
    const firstId = await makeImageAsset();
    const secondId = await makeImageAsset();
    const thirdId = await makeImageAsset();
    const result = await client.callTool({
      name: "generate_fal_qwen_3_0_edit_image",
      arguments: {
        book_id: "test-proj",
        prompt: "put the subject of image 1 into the scene of image 2, lit like image 3",
        image_refs: [`@${firstId}`, `@${secondId}`, `@${thirdId}`],
        negative_prompt: "blurry, watermark",
        sync_mode: false,
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.source_images).toEqual([firstId, secondId, thirdId]);
    expect(parsed.job_id).toBeDefined();
  });

  it("rejects when no reference image is provided", async () => {
    const result = await client.callTool({
      name: "generate_fal_qwen_3_0_edit_image",
      arguments: {
        book_id: "test-proj",
        prompt: "make the sky purple",
        image_refs: [],
      },
    });

    expect(result.isError).toBe(true);
  });

  it("rejects more than three reference images", async () => {
    const ids = await Promise.all([makeImageAsset(), makeImageAsset(), makeImageAsset(), makeImageAsset()]);
    const result = await client.callTool({
      name: "generate_fal_qwen_3_0_edit_image",
      arguments: {
        book_id: "test-proj",
        prompt: "combine these",
        image_refs: ids.map((id) => `@${id}`),
      },
    });

    expect(result.isError).toBe(true);
  });

  it("rejects a reference that is not an image artifact", async () => {
    const fs = createEngineForTest(tempDir);
    const video = await fs.artifacts.create("vid", "ref-vid");
    if (!video.ok) throw new Error("Failed to create video asset");
    await fs.files.write(video.value.artifactId, "original.mp4", Buffer.from("fake-video"));

    const result = await client.callTool({
      name: "generate_fal_qwen_3_0_edit_image",
      arguments: {
        book_id: "test-proj",
        prompt: "make the sky purple",
        image_refs: [`@${video.value.artifactId}`],
      },
    });

    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("image artifact");
  });
});
