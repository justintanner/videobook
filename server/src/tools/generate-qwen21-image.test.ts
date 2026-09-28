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

describe("generate_kie_qwen_2_1 image tools", () => {
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
    tempDir = await mkdtemp(join(tmpdir(), "videocity-qwen21-image-test-"));
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
    for (const name of ["generate_kie_qwen_2_1_text_to_image", "generate_kie_qwen_2_1_edit_image"]) {
      const result = await client.callTool({
        name,
        arguments: {
          prompt: "a red fox in snow",
          book_id: "test-proj",
          ...(name === "generate_kie_qwen_2_1_edit_image"
            ? { image_refs: ["@01890f1c-0000-7000-8000-0000000000aa"] }
            : {}),
        },
      });
      expect(result.isError, name).toBe(true);
      expect((result.content as TextContent)[0].text).toContain("not set");
    }
  });

  it("rejects edit image_refs outside 1-10", async () => {
    process.env.KIE_API_KEY = "test-key";

    const empty = await client.callTool({
      name: "generate_kie_qwen_2_1_edit_image",
      arguments: {
        prompt: "edit me",
        book_id: "test-proj",
        image_refs: [],
      },
    });
    expect(empty.isError).toBe(true);
    expect((empty.content as TextContent)[0].text).toMatch(/Too small|>=1 items/i);

    const eleven = Array.from({ length: 11 }, (_, index) => `@01890f1c-0000-7000-8000-0000000000a${index}`);
    const tooMany = await client.callTool({
      name: "generate_kie_qwen_2_1_edit_image",
      arguments: {
        prompt: "edit me",
        book_id: "test-proj",
        image_refs: eleven,
      },
    });
    expect(tooMany.isError).toBe(true);
    expect((tooMany.content as TextContent)[0].text).toMatch(/Too big|<=10 items/i);
  });

  it("enqueues a text-to-image job", async () => {
    process.env.KIE_API_KEY = "test-key";

    const result = await client.callTool({
      name: "generate_kie_qwen_2_1_text_to_image",
      arguments: {
        prompt: "a red fox in snow",
        book_id: "test-proj",
        aspect_ratio: "16:9",
        resolution: "2K",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text) as {
      status: string;
      img_asset_id: string;
      job_id: string;
    };
    expect(parsed.status).toBe("enqueued");
    expect(isUuidV7(parsed.img_asset_id)).toBe(true);

    const fs = createEngineForTest(tempDir);
    const created = fs.artifacts.get(parsed.img_asset_id);
    expect(created.ok).toBe(true);
    if (created.ok) expect(created.value.kind).toBe("image");
  });

  it("accepts a local @<artifact-id> ref without Invalid URL (enqueues job)", async () => {
    process.env.KIE_API_KEY = "test-key";

    const fs = createEngineForTest(tempDir);
    const asset = await fs.artifacts.create("img", "qwen21-mask-reference");
    if (!asset.ok) throw new Error("Failed to create asset");

    const png = await sharp({
      create: { width: 10, height: 10, channels: 4, background: { r: 0, g: 255, b: 0, alpha: 1 } },
    }).png().toBuffer();
    await fs.files.write(asset.value.artifactId, "original.png", png);

    const result = await client.callTool({
      name: "generate_kie_qwen_2_1_edit_image",
      arguments: {
        prompt: "recolor the fox",
        book_id: "test-proj",
        image_refs: [`@${asset.value.artifactId}`],
        aspect_ratio: "auto",
        output_format: "png",
      },
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content as TextContent)[0].text;
    expect(text).not.toMatch(/Invalid URL/i);
    const parsed = JSON.parse(text) as {
      status: string;
      img_asset_id: string;
      source_images: string[];
      job_id: string;
    };
    expect(parsed.status).toBe("enqueued");
    expect(parsed.source_images).toEqual([asset.value.artifactId]);
    expect(isUuidV7(parsed.img_asset_id)).toBe(true);
  });
});
