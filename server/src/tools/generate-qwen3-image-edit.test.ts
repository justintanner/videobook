import type { Client } from "@modelcontextprotocol/client";
import { KieError } from "@apicity/kie";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { isUuidV7 } from "videobook-engine";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createEngineForTest } from "../engine.js";
import {
  falImageSizeForKieQwen3,
  isKieBlankPlaygroundTaskError,
} from "../jobs/generate-qwen3-image-edit.js";
import { queue } from "../queue.js";
import { createTestClient } from "../test-client.js";

type TextContent = Array<{ type: string; text: string }>;

describe("generate_kie_qwen_3_0_edit_image tool", () => {
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
    tempDir = await mkdtemp(join(tmpdir(), "videobook-qwen3-edit-test-"));
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

  async function makeImageAsset(label: string): Promise<string> {
    const engine = createEngineForTest(tempDir);
    const asset = await engine.artifacts.create("img", label);
    if (!asset.ok) throw new Error("Failed to create image asset");
    const png = await sharp({
      create: { width: 10, height: 10, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
    }).png().toBuffer();
    await engine.files.write(asset.value.artifactId, "original.png", png);
    return asset.value.artifactId;
  }

  it("maps Kie aspect ratios onto Fal Qwen 3 sizes and detects playground 422s", () => {
    expect(falImageSizeForKieQwen3("9:16")).toBe("portrait_16_9");
    expect(falImageSizeForKieQwen3("16:9")).toBe("landscape_16_9");
    expect(falImageSizeForKieQwen3("1:1")).toBe("square_hd");
    expect(falImageSizeForKieQwen3("21:9")).toBeUndefined();
    expect(isKieBlankPlaygroundTaskError(
      new KieError("createTask failed: generate playground failed, task id is blank", 422),
    )).toBe(true);
    expect(isKieBlankPlaygroundTaskError(
      new KieError("createTask failed: credits insufficient", 402),
    )).toBe(false);
  });

  it("returns an error when KIE_API_KEY is not set", async () => {
    const result = await client.callTool({
      name: "generate_kie_qwen_3_0_edit_image",
      arguments: {
        book_id: "test-proj",
        prompt: "make the sky purple",
        image_refs: ["@01890f1c-0000-7000-8000-0000000000aa"],
      },
    });

    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("KIE_API_KEY environment variable is not set");
  });

  it("enqueues three ordered images with Qwen 3 options", async () => {
    process.env.KIE_API_KEY = "test-key";
    const firstId = await makeImageAsset("first");
    const secondId = await makeImageAsset("second");
    const thirdId = await makeImageAsset("third");
    const engine = createEngineForTest(tempDir);
    const result = await client.callTool({
      name: "generate_kie_qwen_3_0_edit_image",
      arguments: {
        book_id: "test-proj",
        prompt: "put image 1 into image 2 with the lighting of image 3",
        image_refs: [`@${firstId}`, `@${secondId}`, `@${thirdId}`],
        image_size: "9:16",
        output_format: "jpeg",
        prompt_extend: false,
        nsfw_checker: true,
        negative_prompt: "watermark",
        seed: 42,
        resolution: "2K",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text) as {
      status: string;
      img_asset_id: string;
      source_images: string[];
      job_id: string;
    };
    expect(parsed.status).toBe("enqueued");
    expect(parsed.source_images).toEqual([firstId, secondId, thirdId]);
    expect(isUuidV7(parsed.img_asset_id)).toBe(true);
    expect(parsed.job_id).toContain("qwen3-edit-");
    const created = engine.artifacts.get(parsed.img_asset_id);
    expect(created.ok).toBe(true);
    if (created.ok) expect(created.value.kind).toBe("image");
  });

  it("rejects zero or more than three reference images", async () => {
    process.env.KIE_API_KEY = "test-key";
    const empty = await client.callTool({
      name: "generate_kie_qwen_3_0_edit_image",
      arguments: { book_id: "test-proj", prompt: "edit", image_refs: [] },
    });
    expect(empty.isError).toBe(true);

    const ids = await Promise.all([
      makeImageAsset("one"),
      makeImageAsset("two"),
      makeImageAsset("three"),
      makeImageAsset("four"),
    ]);
    const tooMany = await client.callTool({
      name: "generate_kie_qwen_3_0_edit_image",
      arguments: {
        book_id: "test-proj",
        prompt: "edit",
        image_refs: ids.map((id) => `@${id}`),
      },
    });
    expect(tooMany.isError).toBe(true);
  });

  it("rejects a non-image reference", async () => {
    process.env.KIE_API_KEY = "test-key";
    const engine = createEngineForTest(tempDir);
    const video = await engine.artifacts.create("vid", "reference video");
    if (!video.ok) throw new Error("Failed to create video artifact");
    await engine.files.write(video.value.artifactId, "original.mp4", Buffer.from("video"));

    const result = await client.callTool({
      name: "generate_kie_qwen_3_0_edit_image",
      arguments: {
        book_id: "test-proj",
        prompt: "edit",
        image_refs: [`@${video.value.artifactId}`],
      },
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("image artifact");
  });
});
