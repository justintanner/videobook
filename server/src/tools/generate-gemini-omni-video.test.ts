import { createEngineForTest } from "../fs.js";
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import type { Client } from "@modelcontextprotocol/client";
import { createTestClient } from "../test-client.js";
import { queue } from "../queue.js";

type TextContent = Array<{ type: string; text: string }>;

function makePng(): Promise<Buffer> {
  return sharp({
    create: { width: 10, height: 10, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
  }).png().toBuffer();
}

describe("generate_gemini_omni_video tool", () => {
  let client: Client;
  let tempDir: string;
  const originalKey = process.env.KIE_API_KEY;

  beforeEach(async () => {
    process.env.KIE_API_KEY = "test-key";
    tempDir = await mkdtemp(join(tmpdir(), "videocity-gemini-omni-video-test-"));
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

  it("enqueues with image and video slugs before provider upload", async () => {
    const fs = createEngineForTest(tempDir);
    const imageAsset = await fs.artifacts.create("img", "source-img");
    const videoAsset = await fs.artifacts.create("vid", "source-video");
    if (!imageAsset.ok) throw new Error("Failed to create image asset");
    if (!videoAsset.ok) throw new Error("Failed to create video asset");

    await fs.files.write(imageAsset.value.slug, "original.png", await makePng());
    await fs.files.write(videoAsset.value.slug, "original.mp4", Buffer.from("fake mp4"));

    const result = await client.callTool({
      name: "generate_kie_gemini_omni_video",
      arguments: {
        book_id: "test-proj",
        prompt: "char swap",
        image_slugs: [`@${imageAsset.value.slug}`],
        video_slug: `@${videoAsset.value.slug}`,
        video_clip_start: 0,
        video_clip_ends: 9.97,
        duration: "10",
        resolution: "720p",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.vid_asset_id).toMatch(/^vid-/);
    expect(parsed.source_images).toEqual([imageAsset.value.slug]);
    expect(parsed.source_videos).toEqual([videoAsset.value.slug]);
  });
});
