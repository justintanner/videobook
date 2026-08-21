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
import {
  KLING_OMNI_IMAGE_TO_VIDEO_TOOL,
  KLING_OMNI_REFERENCE_TO_VIDEO_TOOL,
  KLING_OMNI_TEXT_TO_VIDEO_TOOL,
  KLING_OMNI_TRANSFORMATION_TOOL,
} from "../kling-omni.js";
import {
  buildKlingOmniImageSchema,
  buildKlingOmniReferenceSchema,
  buildKlingOmniTextSchema,
  buildKlingOmniTransformationSchema,
} from "./generate-kling30-omni-video.js";
import {
  KlingOmniImageToVideoRequestSchema,
  KlingOmniReferenceToVideoRequestSchema,
  KlingOmniTextToVideoRequestSchema,
  KlingOmniTransformationRequestSchema,
} from "@apicity/kie/zod";

type TextContent = Array<{ type: string; text: string }>;

function makePng(): Promise<Buffer> {
  return sharp({
    create: { width: 10, height: 10, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
  }).png().toBuffer();
}

describe("Kling 3.0 Omni schemas", () => {
  it("accepts a legal text-to-video payload and rejects images", () => {
    const schema = buildKlingOmniTextSchema();
    expect(schema.prompt.safeParse("a cat walks").success).toBe(true);
    expect(schema.resolution.safeParse("720p").success).toBe(true);
    expect(schema.resolution.safeParse("4k").success).toBe(true);
    expect(schema.resolution.safeParse("480p").success).toBe(false);
    expect("image_refs" in schema).toBe(false);
    expect(KlingOmniTextToVideoRequestSchema.safeParse({
      model: "kling-3.0-omni/text-to-video",
      input: { prompt: "a cat walks", customize_multi_shots: false, resolution: "1080p" },
    }).success).toBe(true);
    expect(KlingOmniTextToVideoRequestSchema.safeParse({
      model: "kling-3.0-omni/image-to-video",
      input: { prompt: "a cat walks", customize_multi_shots: false },
    }).success).toBe(false);
  });

  it("requires 1-2 image refs for image-to-video and rejects video refs", () => {
    const schema = buildKlingOmniImageSchema();
    expect(schema.image_refs.safeParse(["@img-1"]).success).toBe(true);
    expect(schema.image_refs.safeParse(["@img-1", "@img-2"]).success).toBe(true);
    expect(schema.image_refs.safeParse(["@img-1", "@img-2", "@img-3"]).success).toBe(false);
    expect("video_refs" in schema).toBe(false);
    expect(KlingOmniImageToVideoRequestSchema.safeParse({
      model: "kling-3.0-omni/image-to-video",
      input: {
        prompt: "animate",
        image_urls: ["https://example.com/a.png"],
      },
    }).success).toBe(true);
  });

  it("requires image or video refs for reference-to-video", () => {
    const schema = buildKlingOmniReferenceSchema();
    expect(schema.image_refs.safeParse(["@img-1"]).success).toBe(true);
    expect(schema.video_refs.safeParse(["@vid-1"]).success).toBe(true);
    expect(schema.video_refs.safeParse(["@vid-1", "@vid-2"]).success).toBe(false);
    expect(KlingOmniReferenceToVideoRequestSchema.safeParse({
      model: "kling-3.0-omni/reference-to-video",
      input: { prompt: "guide", image_urls: ["https://example.com/a.png"] },
    }).success).toBe(true);
    expect(KlingOmniReferenceToVideoRequestSchema.safeParse({
      model: "kling-3.0-omni/reference-to-video",
      input: { prompt: "guide" },
    }).success).toBe(false);
  });

  it("requires a motion video for transformation and rejects text-only", () => {
    const schema = buildKlingOmniTransformationSchema();
    expect(schema.video_refs.safeParse(["@vid-1"]).success).toBe(true);
    expect(schema.video_refs.safeParse([]).success).toBe(false);
    expect(KlingOmniTransformationRequestSchema.safeParse({
      model: "kling-3.0-omni/transformation",
      input: {
        prompt: "dance",
        video_urls: ["https://example.com/motion.mp4"],
        image_urls: ["https://example.com/cat.png"],
        aspect_ratio: "9:16",
      },
    }).success).toBe(true);
    expect(KlingOmniTransformationRequestSchema.safeParse({
      model: "kling-3.0-omni/text-to-video",
      input: { prompt: "dance", customize_multi_shots: false },
    }).success).toBe(false);
  });
});

describe("Kling 3.0 Omni tools", () => {
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
    tempDir = await mkdtemp(join(tmpdir(), "videocity-kling-omni-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "test-proj" },
    });
  });

  afterEach(async () => {
    if (originalKey) process.env.KIE_API_KEY = originalKey;
    else delete process.env.KIE_API_KEY;
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("returns error when KIE_API_KEY is not set", async () => {
    const result = await client.callTool({
      name: KLING_OMNI_TEXT_TO_VIDEO_TOOL,
      arguments: { book_id: "test-proj", prompt: "a dog skateboarding" },
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("not set");
  });

  it("enqueues a text-to-video job", async () => {
    process.env.KIE_API_KEY = "test-key";
    const fs = createEngineForTest(tempDir);
    const result = await client.callTool({
      name: KLING_OMNI_TEXT_TO_VIDEO_TOOL,
      arguments: {
        book_id: "test-proj",
        prompt: "a dog skateboarding",
        customize_multi_shots: false,
        resolution: "720p",
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

  it("enqueues an image-to-video job with one frame", async () => {
    process.env.KIE_API_KEY = "test-key";
    const fs = createEngineForTest(tempDir);
    const asset = await fs.artifacts.create("img", "source-img");
    if (!asset.ok) throw new Error("Failed to create asset");
    await fs.files.write(asset.value.artifactId, "original.png", await makePng());
    const result = await client.callTool({
      name: KLING_OMNI_IMAGE_TO_VIDEO_TOOL,
      arguments: {
        book_id: "test-proj",
        prompt: "animate this image",
        image_refs: [`@${asset.value.artifactId}`],
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.source_images).toEqual([asset.value.artifactId]);
  });

  it("enqueues a transformation job with image plus motion video", async () => {
    process.env.KIE_API_KEY = "test-key";
    const fs = createEngineForTest(tempDir);
    const image = await fs.artifacts.create("img", "character");
    const video = await fs.artifacts.create("vid", "motion");
    if (!image.ok || !video.ok) throw new Error("Failed to create assets");
    await fs.files.write(image.value.artifactId, "original.png", await makePng());
    await fs.files.write(video.value.artifactId, "original.mp4", Buffer.from("fake-mp4"));
    const result = await client.callTool({
      name: KLING_OMNI_TRANSFORMATION_TOOL,
      arguments: {
        book_id: "test-proj",
        prompt: "two kittens dance",
        image_refs: [`@${image.value.artifactId}`],
        video_refs: [`@${video.value.artifactId}`],
        resolution: "720p",
        aspect_ratio: "9:16",
        duration: "10",
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.source_images).toEqual([image.value.artifactId]);
    expect(parsed.source_videos).toEqual([video.value.artifactId]);
  });

  it("rejects image-to-video without an image", async () => {
    process.env.KIE_API_KEY = "test-key";
    const result = await client.callTool({
      name: KLING_OMNI_IMAGE_TO_VIDEO_TOOL,
      arguments: { book_id: "test-proj", prompt: "animate" },
    });
    expect(result.isError).toBe(true);
  });

  it("does not register retired Kling tools", async () => {
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    expect(names).toContain(KLING_OMNI_TEXT_TO_VIDEO_TOOL);
    expect(names).toContain(KLING_OMNI_IMAGE_TO_VIDEO_TOOL);
    expect(names).toContain(KLING_OMNI_REFERENCE_TO_VIDEO_TOOL);
    expect(names).toContain(KLING_OMNI_TRANSFORMATION_TOOL);
    expect(names).not.toContain("generate_kie_kling_3_0_video");
    expect(names).not.toContain("generate_kie_kling_3_0_motion_control");
  });
});
