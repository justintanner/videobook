import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFs } from "videocity-engine";
import sharp from "sharp";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createTestClient } from "../test-client.js";
import { queue } from "../queue.js";

type TextContent = Array<{ type: string; text: string }>;

function makePng(): Promise<Buffer> {
  return sharp({
    create: { width: 10, height: 10, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
  }).png().toBuffer();
}

describe("generate_google_omni_video tool", () => {
  let client: Client;
  let tempDir: string;
  const originalKey = process.env.GOOGLE_FLOW_API_KEY;

  beforeEach(async () => {
    process.env.GOOGLE_FLOW_API_KEY = "test-key";
    tempDir = await mkdtemp(join(tmpdir(), "videocity-google-omni-video-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "test-proj" },
    });
  });

  afterEach(async () => {
    if (originalKey) {
      process.env.GOOGLE_FLOW_API_KEY = originalKey;
    } else {
      delete process.env.GOOGLE_FLOW_API_KEY;
    }
    await client?.close();
    await queue.stop();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("enqueues with image and video slugs before provider upload", async () => {
    const fs = createFs({ projectsDir: tempDir });
    const imageAsset = await fs.createAsset("img", "source-img", "test-proj");
    const videoAsset = await fs.createAsset("vid", "source-video", "test-proj");
    if (!imageAsset.ok) throw new Error("Failed to create image asset");
    if (!videoAsset.ok) throw new Error("Failed to create video asset");

    await fs.writeFile(imageAsset.value.assetId, "original.png", await makePng(), "test-proj");
    await fs.writeFile(videoAsset.value.assetId, "original.mp4", Buffer.from("fake mp4"), "test-proj");

    const result = await client.callTool({
      name: "generate_google_omni_video",
      arguments: {
        project_slug: "test-proj",
        prompt: "char swap",
        image_slugs: [`@${imageAsset.value.assetId}`],
        video_slug: `@${videoAsset.value.assetId}`,
        video_clip_start: 0,
        video_clip_ends: 10,
        duration: "10",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.vid_asset_id).toMatch(/^vid-/);
    expect(parsed.source_images).toEqual([imageAsset.value.assetId]);
    expect(parsed.source_videos).toEqual([videoAsset.value.assetId]);
  });

  it("enqueues with a first-frame image slug before provider upload", async () => {
    const fs = createFs({ projectsDir: tempDir });
    const imageAsset = await fs.createAsset("img", "start-frame", "test-proj");
    if (!imageAsset.ok) throw new Error("Failed to create image asset");

    await fs.writeFile(imageAsset.value.assetId, "original.png", await makePng(), "test-proj");

    const result = await client.callTool({
      name: "generate_google_omni_video",
      arguments: {
        project_slug: "test-proj",
        prompt: "animate this frame",
        first_frame_slug: `@${imageAsset.value.assetId}`,
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.source_first_frame).toBe(imageAsset.value.assetId);
    expect(parsed.source_images).toEqual([]);
    expect(parsed.source_videos).toEqual([]);
  });

  it("enqueues a reference clip without explicit trim timecodes", async () => {
    const fs = createFs({ projectsDir: tempDir });
    const videoAsset = await fs.createAsset("vid", "source-video", "test-proj");
    if (!videoAsset.ok) throw new Error("Failed to create video asset");

    await fs.writeFile(videoAsset.value.assetId, "original.mp4", Buffer.from("fake mp4"), "test-proj");

    const result = await client.callTool({
      name: "generate_google_omni_video",
      arguments: {
        project_slug: "test-proj",
        prompt: "edit this",
        video_slug: `@${videoAsset.value.assetId}`,
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.source_videos).toEqual([videoAsset.value.assetId]);
  });

  it("rejects a reference clip window over 10 seconds", async () => {
    const result = await client.callTool({
      name: "generate_google_omni_video",
      arguments: {
        project_slug: "test-proj",
        prompt: "edit this",
        video_slug: "@vid-motion",
        video_clip_start: 0,
        video_clip_ends: 12,
        duration: "8",
      },
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("video_clip_ends");
  });

  it("rejects first-frame mode combined with reference images or video", async () => {
    const refsResult = await client.callTool({
      name: "generate_google_omni_video",
      arguments: {
        project_slug: "test-proj",
        prompt: "animate this",
        first_frame_slug: "@img-start",
        image_slugs: ["@img-ref"],
      },
    });
    expect(refsResult.isError).toBe(true);
    expect((refsResult.content as TextContent)[0].text).toContain("first_frame_slug cannot be combined with image_slugs");

    const videoResult = await client.callTool({
      name: "generate_google_omni_video",
      arguments: {
        project_slug: "test-proj",
        prompt: "animate this",
        first_frame_slug: "@img-start",
        video_slug: "@vid-motion",
      },
    });
    expect(videoResult.isError).toBe(true);
    expect((videoResult.content as TextContent)[0].text).toContain("first_frame_slug cannot be combined with video_slug");
  });

  it("rejects more than 5 reference images alongside a clip", async () => {
    const result = await client.callTool({
      name: "generate_google_omni_video",
      arguments: {
        project_slug: "test-proj",
        prompt: "edit this",
        image_slugs: ["@img-1", "@img-2", "@img-3", "@img-4", "@img-5", "@img-6"],
        video_slug: "@vid-motion",
        video_clip_start: 0,
        video_clip_ends: 5,
        duration: "8",
      },
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("at most 5 reference images");
  });
});
