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

describe("generate_fal_wan_3_0_* / generate_fal_wan_3_0_prime_* tools", () => {
  let client: Client;
  let tempDir: string;
  const originalKey = process.env.FAL_API_KEY;

  beforeEach(async () => {
    process.env.FAL_API_KEY = "test-key";
    tempDir = await mkdtemp(join(tmpdir(), "videobook-wan30-fal-test-"));
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

  async function makeVideoAsset(): Promise<string> {
    const fs = createEngineForTest(tempDir);
    const asset = await fs.artifacts.create("vid", "ref-vid");
    if (!asset.ok) throw new Error("Failed to create video asset");
    await fs.files.write(asset.value.artifactId, "original.mp4", Buffer.from("fake-video"));
    return asset.value.artifactId;
  }

  it("returns error when FAL_API_KEY is not set", async () => {
    delete process.env.FAL_API_KEY;
    const result = await client.callTool({
      name: "generate_fal_wan_3_0_text_to_video",
      arguments: {
        prompt: "a cat dancing",
        book_id: "test-proj",
        duration: 5,
      },
    });

    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("FAL_API_KEY environment variable is not set");
  });

  it("enqueues generate_wan30_t2v_fal job (text-to-video)", async () => {
    const fs = createEngineForTest(tempDir);
    const result = await client.callTool({
      name: "generate_fal_wan_3_0_text_to_video",
      arguments: {
        prompt: "a cat dancing",
        book_id: "test-proj",
        duration: 5,
        resolution: "720p",
        aspect_ratio: "16:9",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("enqueued");
    expect(isUuidV7(parsed.vid_asset_id)).toBe(true);
    const created = fs.artifacts.get(parsed.vid_asset_id);
    expect(created.ok).toBe(true);
    if (created.ok) expect(created.value.kind).toBe("video");
    expect(parsed.job_id).toBeDefined();
  });

  it("enqueues generate_wan30_prime_t2v_fal job (prime text-to-video)", async () => {
    const fs = createEngineForTest(tempDir);
    const result = await client.callTool({
      name: "generate_fal_wan_3_0_prime_text_to_video",
      arguments: {
        prompt: "a cat dancing",
        book_id: "test-proj",
        duration: 8,
        audio: false,
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("enqueued");
    expect(isUuidV7(parsed.vid_asset_id)).toBe(true);
    const created = fs.artifacts.get(parsed.vid_asset_id);
    expect(created.ok).toBe(true);
    if (created.ok) expect(created.value.kind).toBe("video");
    expect(parsed.job_id).toBeDefined();
  });

  it("requires duration on text-to-video", async () => {
    const result = await client.callTool({
      name: "generate_fal_wan_3_0_text_to_video",
      arguments: {
        prompt: "a cat dancing",
        book_id: "test-proj",
      },
    });

    expect(result.isError).toBe(true);
  });

  it("enqueues generate_wan30_i2v_fal job (image-to-video)", async () => {
    const imageId = await makeImageAsset();
    const fs = createEngineForTest(tempDir);
    const result = await client.callTool({
      name: "generate_fal_wan_3_0_image_to_video",
      arguments: {
        book_id: "test-proj",
        first_frame_ref: `@${imageId}`,
        duration: 5,
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("enqueued");
    expect(isUuidV7(parsed.vid_asset_id)).toBe(true);
    const created = fs.artifacts.get(parsed.vid_asset_id);
    expect(created.ok).toBe(true);
    if (created.ok) expect(created.value.kind).toBe("video");
    expect(parsed.source_images).toEqual([imageId]);
    expect(parsed.job_id).toBeDefined();
  });

  it("enqueues generate_wan30_prime_i2v_fal job with end frame", async () => {
    const firstId = await makeImageAsset();
    const endId = await makeImageAsset();
    const result = await client.callTool({
      name: "generate_fal_wan_3_0_prime_image_to_video",
      arguments: {
        prompt: "smooth morph",
        book_id: "test-proj",
        first_frame_ref: `@${firstId}`,
        end_frame_ref: `@${endId}`,
        duration: 10,
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.source_images).toEqual([firstId, endId]);
    expect(parsed.job_id).toBeDefined();
  });

  it("rejects reference-to-video with no grounding input", async () => {
    const result = await client.callTool({
      name: "generate_fal_wan_3_0_reference_to_video",
      arguments: {
        book_id: "test-proj",
        duration: 5,
      },
    });

    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("requires at least one of");
  });

  it("enqueues generate_wan30_r2v_fal job (reference-to-video)", async () => {
    const imageId = await makeImageAsset();
    const videoId = await makeVideoAsset();
    const result = await client.callTool({
      name: "generate_fal_wan_3_0_reference_to_video",
      arguments: {
        prompt: "character dances in the clip style",
        book_id: "test-proj",
        image_refs: [`@${imageId}`],
        video_refs: [`@${videoId}`],
        duration: 6,
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.source_images).toEqual([imageId]);
    expect(parsed.source_videos).toEqual([videoId]);
    expect(parsed.job_id).toBeDefined();
  });

  it("enqueues generate_wan30_prime_r2v_fal job from a prompt alone", async () => {
    const result = await client.callTool({
      name: "generate_fal_wan_3_0_prime_reference_to_video",
      arguments: {
        prompt: "a city timelapse at dusk",
        book_id: "test-proj",
        duration: 5,
        enable_thinking: true,
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("enqueued");
    expect(isUuidV7(parsed.vid_asset_id)).toBe(true);
    expect(parsed.job_id).toBeDefined();
  });
});
