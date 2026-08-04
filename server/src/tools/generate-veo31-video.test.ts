import { createEngineForTest } from "../fs.js";
import { isUuidV7 } from "videobook-engine";
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
    create: { width: 10, height: 10, channels: 4, background: { r: 0, g: 128, b: 255, alpha: 1 } },
  }).png().toBuffer();
}

describe("generate_veo31_video tools", () => {
  let client: Client;
  let tempDir: string;
  const originalKey = process.env.GOOGLE_FLOW_API_KEY;

  beforeEach(async () => {
    process.env.GOOGLE_FLOW_API_KEY = "test-key";
    tempDir = await mkdtemp(join(tmpdir(), "videocity-veo31-video-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "test-proj" },
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

  it("enqueues a fast-tier job with start frame and duration", async () => {
    const fs = createEngineForTest(tempDir);
    const imageAsset = await fs.artifacts.create("img", "start-frame");
    if (!imageAsset.ok) throw new Error("Failed to create image asset");
    await fs.files.write(imageAsset.value.artifactId, "original.png", await makePng());

    const result = await client.callTool({
      name: "generate_google_flow_veo_3_1_fast_video",
      arguments: {
        book_id: "test-proj",
        prompt: "a slow push through fog",
        first_frame_ref: `@${imageAsset.value.artifactId}`,
        aspect_ratio: "16:9",
        duration: "8",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("enqueued");
    expect(isUuidV7(parsed.vid_asset_id)).toBe(true);
    const created = fs.artifacts.get(parsed.vid_asset_id);
    expect(created.ok).toBe(true);
    if (created.ok) expect(created.value.kind).toBe("video");
    expect(parsed.source_images).toEqual([imageAsset.value.artifactId]);
  });

  it("rejects last_frame_ref without first_frame_ref", async () => {
    const result = await client.callTool({
      name: "generate_google_flow_veo_3_1_quality_video",
      arguments: {
        book_id: "test-proj",
        prompt: "a sunset",
        last_frame_ref: "@img-ending",
      },
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("requires first_frame_ref");
  });

  it("enqueues a lite-low-priority job", async () => {
    const fs = createEngineForTest(tempDir);
    const result = await client.callTool({
      name: "generate_google_flow_veo_3_1_lite_low_priority_video",
      arguments: {
        book_id: "test-proj",
        prompt: "a fog bank rolling over hills",
        aspect_ratio: "16:9",
        duration: "4",
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("enqueued");
    expect(isUuidV7(parsed.vid_asset_id)).toBe(true);
    // The model tier now lives in the artifact's display label, not its id.
    const created = fs.artifacts.get(parsed.vid_asset_id);
    expect(created.ok).toBe(true);
    if (created.ok) {
      expect(created.value.kind).toBe("video");
      expect(created.value.label).toBe("veo31-lite-lp — a fog bank rolling over hills");
    }
  });

  it("rejects reference images combined with a start frame", async () => {
    const result = await client.callTool({
      name: "generate_google_flow_veo_3_1_lite_video",
      arguments: {
        book_id: "test-proj",
        prompt: "a sunset",
        first_frame_ref: "@img-start",
        image_refs: ["@img-style"],
      },
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("pick one mode");
  });
});
