import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { queue } from "../queue.js";
import { createFs } from "videobook-engine";
import sharp from "sharp";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

type TextContent = Array<{ type: string; text: string }>;

const requiredKlingArgs = {
  mode: "std",
  duration: "8",
  sound: true,
  multi_shots: false,
} as const;

function makePng(): Promise<Buffer> {
  return sharp({
    create: { width: 10, height: 10, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
  }).png().toBuffer();
}

describe("generate_kling30_video tool", () => {
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
    tempDir = await mkdtemp(join(tmpdir(), "videocity-kling30-video-test-"));
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
      name: "generate_kie_kling_3_0_video",
      arguments: {
        ...requiredKlingArgs,
        project_slug: "test-proj",
        prompt: "a dog skateboarding",
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("not set");
  });

  it("enqueues text-to-video job with no images", async () => {
    process.env.KIE_API_KEY = "test-key";

    const result = await client.callTool({
      name: "generate_kie_kling_3_0_video",
      arguments: {
        ...requiredKlingArgs,
        project_slug: "test-proj",
        prompt: "a dog skateboarding",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.vid_asset_id).toMatch(/^vid-/);
    expect(parsed.source_images).toEqual([]);
    expect(parsed.job_id).toBeDefined();
  });

  it("enqueues image-to-video job with one reference image", async () => {
    process.env.KIE_API_KEY = "test-key";

    const fs = createFs({ projectsDir: tempDir });
    const asset = await fs.createAsset("img", "source-img", "test-proj");
    if (!asset.ok) throw new Error("Failed to create asset");

    const png = await makePng();
    await fs.writeFile(asset.value.assetId, "original.png", png, "test-proj");

    const result = await client.callTool({
      name: "generate_kie_kling_3_0_video",
      arguments: {
        ...requiredKlingArgs,
        project_slug: "test-proj",
        prompt: "animate this image",
        image_slugs: [`@${asset.value.assetId}`],
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.vid_asset_id).toMatch(/^vid-/);
    expect(parsed.source_images).toEqual([asset.value.assetId]);
  });

  it("returns error when image_slugs entry is not img-*", async () => {
    process.env.KIE_API_KEY = "test-key";

    const result = await client.callTool({
      name: "generate_kie_kling_3_0_video",
      arguments: {
        ...requiredKlingArgs,
        project_slug: "test-proj",
        prompt: "test",
        image_slugs: ["@vid-something"],
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("must be img-*");
  });

  it("returns error for nonexistent image asset in image_slugs", async () => {
    process.env.KIE_API_KEY = "test-key";

    const result = await client.callTool({
      name: "generate_kie_kling_3_0_video",
      arguments: {
        ...requiredKlingArgs,
        project_slug: "test-proj",
        prompt: "test",
        image_slugs: ["@img-does-not-exist"],
      },
    });

    expect(result.isError).toBe(true);
  });

  it("returns error when image asset has no image file", async () => {
    process.env.KIE_API_KEY = "test-key";

    const fs = createFs({ projectsDir: tempDir });
    const asset = await fs.createAsset("img", "empty-img", "test-proj");
    if (!asset.ok) throw new Error("Failed to create asset");

    await fs.writeFile(asset.value.assetId, "notes.txt", "hello", "test-proj");

    const result = await client.callTool({
      name: "generate_kie_kling_3_0_video",
      arguments: {
        ...requiredKlingArgs,
        project_slug: "test-proj",
        prompt: "test",
        image_slugs: [`@${asset.value.assetId}`],
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("No image file");
  });

  it("enqueues job with element slugs", async () => {
    process.env.KIE_API_KEY = "test-key";

    const fs = createFs({ projectsDir: tempDir });
    const asset = await fs.createAsset("img", "char-face", "test-proj");
    if (!asset.ok) throw new Error("Failed to create asset");

    const png = await makePng();
    await fs.writeFile(asset.value.assetId, "original.png", png, "test-proj");

    const result = await client.callTool({
      name: "generate_kie_kling_3_0_video",
      arguments: {
        ...requiredKlingArgs,
        project_slug: "test-proj",
        prompt: "character walks down the street",
        element1_slugs: [`@${asset.value.assetId}`],
        element1_name: "hero",
        element1_desc: "the main character",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.vid_asset_id).toMatch(/^vid-/);
  });

  it("returns error for nonexistent element slug", async () => {
    process.env.KIE_API_KEY = "test-key";

    const result = await client.callTool({
      name: "generate_kie_kling_3_0_video",
      arguments: {
        ...requiredKlingArgs,
        project_slug: "test-proj",
        prompt: "test",
        element1_slugs: ["@img-nonexistent"],
        element1_name: "test",
        element1_desc: "test",
      },
    });

    expect(result.isError).toBe(true);
  });

  it("accepts all optional parameters", async () => {
    process.env.KIE_API_KEY = "test-key";

    const result = await client.callTool({
      name: "generate_kie_kling_3_0_video",
      arguments: {
        ...requiredKlingArgs,
        project_slug: "test-proj",
        prompt: "a sunset timelapse",
        mode: "pro",
        duration: "10",
        sound: false,
        aspect_ratio: "9:16",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("enqueued");
  });

  it("accepts multi-shot parameters", async () => {
    process.env.KIE_API_KEY = "test-key";

    const result = await client.callTool({
      name: "generate_kie_kling_3_0_video",
      arguments: {
        ...requiredKlingArgs,
        project_slug: "test-proj",
        prompt: "a story",
        multi_shots: true,
        multi_prompt: [
          { prompt: "scene one: sunrise", duration: 3 },
          { prompt: "scene two: sunset", duration: 5 },
        ],
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("enqueued");
  });
});
