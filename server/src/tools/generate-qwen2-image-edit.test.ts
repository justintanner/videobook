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

describe("generate_qwen2_image_edit tool", () => {
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
    tempDir = await mkdtemp(join(tmpdir(), "videocity-qwen2-edit-test-"));
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
      name: "generate_qwen2_image_edit",
      arguments: {
        prompt: "exactly the same remove game",
        project_slug: "test-proj",
        image_slugs: ["@img-nbp-scene-reference-2-3"],
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("not set");
  });

  it("returns error when image_slugs count is not exactly 1", async () => {
    process.env.KIE_API_KEY = "test-key";

    // Empty array fails MCP schema (.min(1) from apicity single-url slot) before handler.
    const empty = await client.callTool({
      name: "generate_qwen2_image_edit",
      arguments: {
        prompt: "edit me",
        project_slug: "test-proj",
        image_slugs: [],
      },
    });
    expect(empty.isError).toBe(true);
    expect((empty.content as TextContent)[0].text).toMatch(/Too small|>=1 items|exactly 1/i);

    // Two images pass schema array max (from single string slot mapped as array)
    // but the handler enforces exactly one reference for qwen2/image-edit.
    const two = await client.callTool({
      name: "generate_qwen2_image_edit",
      arguments: {
        prompt: "edit me",
        project_slug: "test-proj",
        image_slugs: ["@img-a", "@img-b"],
      },
    });
    expect(two.isError).toBe(true);
    expect((two.content as TextContent)[0].text).toMatch(/exactly 1|Too big|<=1 items/i);
  });

  // vc-zcxs: apicity image_url is z.string().url(); bare @img slugs used to
  // fail pre-upload safeParse with "image_url: Invalid URL".
  it("accepts local @img slug without Invalid URL (enqueues job)", async () => {
    process.env.KIE_API_KEY = "test-key";

    const fs = createFs({ projectsDir: tempDir });
    const asset = await fs.createAsset("img", "nbp-scene-reference-2-3", "test-proj");
    if (!asset.ok) throw new Error("Failed to create asset");

    const png = await sharp({
      create: { width: 10, height: 10, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
    }).png().toBuffer();
    await fs.writeFile(asset.value.assetId, "original.png", png, "test-proj");

    const result = await client.callTool({
      name: "generate_qwen2_image_edit",
      arguments: {
        prompt: "exactly the same remove game",
        project_slug: "test-proj",
        image_slugs: [`@${asset.value.assetId}`],
        image_size: "16:9",
        output_format: "png",
      },
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content as TextContent)[0].text;
    expect(text).not.toMatch(/Invalid URL/i);
    const parsed = JSON.parse(text) as { status: string; img_asset_id: string; job_id: string };
    expect(parsed.status).toBe("enqueued");
    expect(parsed.img_asset_id).toMatch(/^img-/);
    expect(parsed.job_id).toBeDefined();
  });
});
