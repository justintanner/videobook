import { createEngineForTest } from "../engine.js";
import { isUuidV7 } from "videobook-engine";
import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { queue } from "../queue.js";
import sharp from "sharp";
import type { Client } from "@modelcontextprotocol/client";

type TextContent = Array<{ type: string; text: string }>;

describe("generate_gpt_image tool", () => {
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
    tempDir = await mkdtemp(join(tmpdir(), "videocity-gpt-image-test-"));
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
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("returns error when KIE_API_KEY is not set", async () => {
    const result = await client.callTool({
      name: "generate_kie_gpt_image_2_image_to_image",
      arguments: {
        prompt: "test prompt",
        book_id: "test-proj",
        image_refs: ["@img-test"],
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("not set");
  });

  it("returns error with empty image_refs", async () => {
    process.env.KIE_API_KEY = "test-key";

    const result = await client.callTool({
      name: "generate_kie_gpt_image_2_image_to_image",
      arguments: {
        prompt: "test prompt",
        book_id: "test-proj",
        image_refs: [],
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toMatch(/at least 1 element|>=1 items/);
  });

  it("returns error with more than 16 images", async () => {
    process.env.KIE_API_KEY = "test-key";

    const result = await client.callTool({
      name: "generate_kie_gpt_image_2_image_to_image",
      arguments: {
        prompt: "test prompt",
        book_id: "test-proj",
        image_refs: Array.from({ length: 17 }, (_, i) => `@img-${i}`),
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toMatch(/at most 16 element|<=16 items/);
  });

  it("returns error when an image_refs entry is not an image artifact", async () => {
    process.env.KIE_API_KEY = "test-key";

    const fs = createEngineForTest(tempDir);
    const video = await fs.artifacts.create("vid", "not-an-image");
    if (!video.ok) throw new Error("Failed to create asset");

    const result = await client.callTool({
      name: "generate_kie_gpt_image_2_image_to_image",
      arguments: {
        prompt: "test prompt",
        book_id: "test-proj",
        image_refs: [`@${video.value.artifactId}`],
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("image ref must be an image artifact, got video");
  });

  it("returns error for nonexistent image asset", async () => {
    process.env.KIE_API_KEY = "test-key";

    const result = await client.callTool({
      name: "generate_kie_gpt_image_2_image_to_image",
      arguments: {
        prompt: "test prompt",
        book_id: "test-proj",
        image_refs: ["@01890f1c-0000-7000-8000-0000000000aa"],
      },
    });

    expect(result.isError).toBe(true);
  });

  it("returns error when image asset has no image file", async () => {
    process.env.KIE_API_KEY = "test-key";

    const fs = createEngineForTest(tempDir);
    const asset = await fs.artifacts.create("img", "empty-img");
    if (!asset.ok) throw new Error("Failed to create asset");

    // Write a non-image file so the asset exists but has no image
    await fs.files.write(asset.value.artifactId, "notes.txt", "hello");

    const result = await client.callTool({
      name: "generate_kie_gpt_image_2_image_to_image",
      arguments: {
        prompt: "test prompt",
        book_id: "test-proj",
        image_refs: [`@${asset.value.artifactId}`],
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("No image file");
  });

  it("enqueues job with valid image asset", async () => {
    process.env.KIE_API_KEY = "test-key";

    const fs = createEngineForTest(tempDir);
    const asset = await fs.artifacts.create("img", "test-img");
    if (!asset.ok) throw new Error("Failed to create asset");

    const png = await sharp({
      create: { width: 10, height: 10, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
    }).png().toBuffer();
    await fs.files.write(asset.value.artifactId, "original.png", png);

    const result = await client.callTool({
      name: "generate_kie_gpt_image_2_image_to_image",
      arguments: {
        prompt: "test prompt",
        book_id: "test-proj",
        image_refs: [`@${asset.value.artifactId}`],
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("enqueued");
    expect(isUuidV7(parsed.img_asset_id)).toBe(true);
    const created = fs.artifacts.get(parsed.img_asset_id);
    expect(created.ok).toBe(true);
    if (created.ok) expect(created.value.kind).toBe("image");
    expect(parsed.job_id).toBeDefined();
  });
});
