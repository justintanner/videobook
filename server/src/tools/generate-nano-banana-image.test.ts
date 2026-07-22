import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { queue } from "../queue.js";
import { createFs } from "videocity-engine";
import sharp from "sharp";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

type TextContent = Array<{ type: string; text: string }>;

describe("generate_nano_banana_image tool", () => {
  let client: Client;
  let tempDir: string;
  const originalKey = process.env.KIE_API_KEY;

  beforeAll(async () => {
    await queue.start();
  });

  afterAll(async () => {
    await queue.stop();
  });

  beforeEach(async () => {
    delete process.env.KIE_API_KEY;
    tempDir = await mkdtemp(join(tmpdir(), "videocity-nano-banana-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "test-proj" },
    });
  });

  afterEach(async () => {
    if (originalKey) {
      process.env.KIE_API_KEY = originalKey;
    } else {
      delete process.env.KIE_API_KEY;
    }
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("returns error when KIE_API_KEY is not set", async () => {
    const result = await client.callTool({
      name: "generate_kie_nano_banana_pro_text_to_image",
      arguments: {
        prompt: "a beautiful sunset",
        project_slug: "test-proj",
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("not set");
  });

  it("returns error with more than 8 reference images", async () => {
    process.env.KIE_API_KEY = "test-key";

    const result = await client.callTool({
      name: "generate_kie_nano_banana_pro_text_to_image",
      arguments: {
        prompt: "test prompt",
        project_slug: "test-proj",
        image_slugs: [
          "@img-a", "@img-b", "@img-c", "@img-d",
          "@img-e", "@img-f", "@img-g", "@img-h", "@img-i",
        ],
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toMatch(/at most 8 element|<=8 items/);
  });

  it("returns error when image_slugs entry does not start with img-", async () => {
    process.env.KIE_API_KEY = "test-key";

    const result = await client.callTool({
      name: "generate_kie_nano_banana_pro_text_to_image",
      arguments: {
        prompt: "test prompt",
        project_slug: "test-proj",
        image_slugs: ["@vid-something"],
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("image_slugs entries must be img-* assets");
  });

  it("returns error for nonexistent reference image asset", async () => {
    process.env.KIE_API_KEY = "test-key";

    const result = await client.callTool({
      name: "generate_kie_nano_banana_pro_text_to_image",
      arguments: {
        prompt: "test prompt",
        project_slug: "test-proj",
        image_slugs: ["@img-does-not-exist"],
      },
    });

    expect(result.isError).toBe(true);
  });

  it("returns error when reference image asset has no image file", async () => {
    process.env.KIE_API_KEY = "test-key";

    const fs = createFs({ projectsDir: tempDir });
    const asset = await fs.createAsset("img", "empty-img", "test-proj");
    if (!asset.ok) throw new Error("Failed to create asset");

    await fs.writeFile(asset.value.assetId, "notes.txt", "hello", "test-proj");

    const result = await client.callTool({
      name: "generate_kie_nano_banana_pro_text_to_image",
      arguments: {
        prompt: "test prompt",
        project_slug: "test-proj",
        image_slugs: [`@${asset.value.assetId}`],
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("No image file");
  });

  it("enqueues job with prompt only (no reference images)", async () => {
    process.env.KIE_API_KEY = "test-key";

    const result = await client.callTool({
      name: "generate_kie_nano_banana_pro_text_to_image",
      arguments: {
        prompt: "a beautiful sunset",
        project_slug: "test-proj",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.img_asset_id).toMatch(/^img-/);
    expect(parsed.job_id).toBeDefined();
  });

  it("enqueues job with prompt and valid reference images", async () => {
    process.env.KIE_API_KEY = "test-key";

    const fs = createFs({ projectsDir: tempDir });
    const asset = await fs.createAsset("img", "ref-img", "test-proj");
    if (!asset.ok) throw new Error("Failed to create asset");

    const png = await sharp({
      create: { width: 10, height: 10, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
    }).png().toBuffer();
    await fs.writeFile(asset.value.assetId, "original.png", png, "test-proj");

    const result = await client.callTool({
      name: "generate_kie_nano_banana_pro_text_to_image",
      arguments: {
        prompt: "transform this image",
        project_slug: "test-proj",
        image_slugs: [`@${asset.value.assetId}`],
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.img_asset_id).toMatch(/^img-/);
    expect(parsed.job_id).toBeDefined();
  });
});
