import { createEngineForTest } from "../fs.js";
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createTestClient } from "../test-client.js";

type TextContent = Array<{ type: string; text: string }>;

function makePng(): Promise<Buffer> {
  return sharp({
    create: { width: 10, height: 10, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
  }).png().toBuffer();
}

describe("generate_nano_banana_2_lite_fal / generate_nano_banana_2_lite_edit_fal tools", () => {
  let client: Client;
  let tempDir: string;
  const originalKey = process.env.FAL_API_KEY;

  beforeEach(async () => {
    process.env.FAL_API_KEY = "test-key";
    tempDir = await mkdtemp(join(tmpdir(), "videocity-nano-banana-2-lite-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "test-proj" },
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

  it("returns error when FAL_API_KEY is not set", async () => {
    delete process.env.FAL_API_KEY;
    const result = await client.callTool({
      name: "generate_fal_nano_banana_2_lite_text_to_image",
      arguments: {
        prompt: "a beautiful sunset",
        project_slug: "test-proj",
      },
    });

    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("FAL_API_KEY environment variable is not set");
  });

  it("enqueues generate_nano_banana_2_lite_fal job (text-to-image)", async () => {
    const result = await client.callTool({
      name: "generate_fal_nano_banana_2_lite_text_to_image",
      arguments: {
        prompt: "a beautiful sunset",
        project_slug: "test-proj",
        aspect_ratio: "16:9",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.img_asset_id).toMatch(/^img-/);
    expect(parsed.job_id).toBeDefined();
  });

  it("enqueues generate_nano_banana_2_lite_edit_fal job (image-to-image)", async () => {
    const fs = createEngineForTest(tempDir);
    const asset = await fs.artifacts.create("img", "ref-img", "test-proj");
    if (!asset.ok) throw new Error("Failed to create asset");
    await fs.files.write(asset.value.slug, "original.png", await makePng(), "test-proj");

    const result = await client.callTool({
      name: "generate_fal_nano_banana_2_lite_edit_image",
      arguments: {
        prompt: "add a sunset",
        project_slug: "test-proj",
        image_slugs: [`@${asset.value.slug}`],
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.img_asset_id).toMatch(/^img-/);
    expect(parsed.source_images).toEqual([asset.value.slug]);
    expect(parsed.job_id).toBeDefined();
  });
});
