import { createEngineForTest } from "../engine.js";
import { isUuidV7 } from "videobook-engine";
import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import type { Client } from "@modelcontextprotocol/client";
import { createTestClient } from "../test-client.js";
import { queue } from "../queue.js";
import {
  Wan30VideoPrimeRequestSchema,
  Wan30VideoRequestSchema,
} from "@apicity/kie/zod";
import { buildWan30VideoSchema } from "./generate-wan30-video.js";

type TextContent = Array<{ type: string; text: string }>;

function makePng(): Promise<Buffer> {
  return sharp({
    create: { width: 10, height: 10, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
  }).png().toBuffer();
}

describe("Wan 3.0 kie omni schema", () => {
  it("exposes the shared Wan 3.0 input surface", () => {
    const schema = buildWan30VideoSchema();

    expect(Object.keys(schema)).toEqual([
      "book_id",
      "prompt",
      "first_frame_ref",
      "last_frame_ref",
      "image_refs",
      "video_refs",
      "audio_refs",
      "resolution",
      "aspect_ratio",
      "duration",
      "audio",
      "seed",
      "nsfw_checker",
      "_provider",
    ]);
    expect(schema.prompt.safeParse(undefined).success).toBe(true);
    expect(schema.prompt.safeParse("x".repeat(20_000)).success).toBe(true);
    expect(schema.prompt.safeParse("x".repeat(20_001)).success).toBe(false);
    expect(schema.image_refs.safeParse(Array.from({ length: 10 }, (_, index) => `@img-${index}`)).success).toBe(true);
    expect(schema.image_refs.safeParse(Array.from({ length: 11 }, (_, index) => `@img-${index}`)).success).toBe(false);
    expect(schema.video_refs.safeParse(Array.from({ length: 5 }, (_, index) => `@vid-${index}`)).success).toBe(true);
    expect(schema.video_refs.safeParse(Array.from({ length: 6 }, (_, index) => `@vid-${index}`)).success).toBe(false);
    expect(schema.audio_refs.safeParse(Array.from({ length: 5 }, (_, index) => `@aud-${index}`)).success).toBe(true);
    expect(schema.audio_refs.safeParse(Array.from({ length: 6 }, (_, index) => `@aud-${index}`)).success).toBe(false);
    expect(schema.duration.safeParse("-1").success).toBe(true);
    expect(schema.duration.safeParse("2").success).toBe(true);
    expect(schema.duration.safeParse("30").success).toBe(true);
    expect(schema.duration.safeParse("1").success).toBe(false);
    expect(schema.duration.safeParse("31").success).toBe(false);
    expect(schema.resolution.safeParse("480P").success).toBe(true);
    expect(schema.resolution.safeParse("720P").success).toBe(true);
    expect(schema.resolution.safeParse("1080P").success).toBe(true);
    expect(schema.resolution.safeParse("720p").success).toBe(false);
    expect(schema.aspect_ratio.safeParse("adaptive").success).toBe(true);
    expect(schema.aspect_ratio.safeParse("16:9").success).toBe(true);
    expect(schema.audio.safeParse(true).success).toBe(true);
    expect(schema.seed.safeParse(42).success).toBe(true);
    expect(schema.nsfw_checker.safeParse(false).success).toBe(true);
  });

  it("enforces the documented Wan 3.0 exclusivity rules", () => {
    expect(Wan30VideoRequestSchema.safeParse({
      model: "wan/3-0-video",
      input: { prompt: "a cat dancing" },
    }).success).toBe(true);
    expect(Wan30VideoRequestSchema.safeParse({
      model: "wan/3-0-video",
      input: {},
    }).success).toBe(false);
    expect(Wan30VideoRequestSchema.safeParse({
      model: "wan/3-0-video",
      input: {
        first_frame_url: "asset://img-1",
        reference_image_urls: ["asset://img-2"],
      },
    }).success).toBe(false);
    expect(Wan30VideoRequestSchema.safeParse({
      model: "wan/3-0-video",
      input: {
        prompt: "animate Image1 to the rhythm of Audio1",
        reference_image_urls: ["asset://img-1"],
        reference_audio_urls: ["asset://aud-1"],
        duration: -1,
        resolution: "720P",
      },
    }).success).toBe(true);
    expect(Wan30VideoPrimeRequestSchema.safeParse({
      model: "wan/3-0-video-prime",
      input: { prompt: "a city timelapse", duration: 8 },
    }).success).toBe(true);
    expect(Wan30VideoPrimeRequestSchema.safeParse({
      model: "wan/3-0-video",
      input: { prompt: "wrong model id" },
    }).success).toBe(false);
  });
});

describe("generate_kie_wan_3_0_video / generate_kie_wan_3_0_prime_video tools", () => {
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
    tempDir = await mkdtemp(join(tmpdir(), "videobook-wan30-kie-test-"));
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

  async function makeAudioAsset(): Promise<string> {
    const fs = createEngineForTest(tempDir);
    const asset = await fs.artifacts.create("aud", "ref-aud");
    if (!asset.ok) throw new Error("Failed to create audio asset");
    await fs.files.write(asset.value.artifactId, "original.mp3", Buffer.from("fake-audio"));
    return asset.value.artifactId;
  }

  it("returns error when KIE_API_KEY is not set", async () => {
    const result = await client.callTool({
      name: "generate_kie_wan_3_0_video",
      arguments: { book_id: "test-proj", prompt: "a cat dancing" },
    });

    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("KIE_API_KEY environment variable is not set");
  });

  it("enqueues generate_wan30_video job (text-to-video)", async () => {
    process.env.KIE_API_KEY = "test-key";
    const fs = createEngineForTest(tempDir);
    const result = await client.callTool({
      name: "generate_kie_wan_3_0_video",
      arguments: {
        book_id: "test-proj",
        prompt: "a cat dancing",
        duration: "5",
        resolution: "720P",
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

  it("enqueues generate_wan30_prime_video job with intelligent duration", async () => {
    process.env.KIE_API_KEY = "test-key";
    const result = await client.callTool({
      name: "generate_kie_wan_3_0_prime_video",
      arguments: {
        book_id: "test-proj",
        prompt: "a city timelapse at dusk",
        duration: "-1",
        audio: false,
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("enqueued");
    expect(isUuidV7(parsed.vid_asset_id)).toBe(true);
    expect(parsed.job_id).toBeDefined();
  });

  it("enqueues generate_wan30_video job in frame mode", async () => {
    process.env.KIE_API_KEY = "test-key";
    const firstId = await makeImageAsset();
    const lastId = await makeImageAsset();
    const result = await client.callTool({
      name: "generate_kie_wan_3_0_video",
      arguments: {
        book_id: "test-proj",
        prompt: "smooth morph",
        first_frame_ref: `@${firstId}`,
        last_frame_ref: `@${lastId}`,
        duration: "10",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.source_images).toEqual([firstId, lastId]);
    expect(parsed.job_id).toBeDefined();
  });

  it("enqueues generate_wan30_prime_video job in reference mode", async () => {
    process.env.KIE_API_KEY = "test-key";
    const imageId = await makeImageAsset();
    const videoId = await makeVideoAsset();
    const audioId = await makeAudioAsset();
    const result = await client.callTool({
      name: "generate_kie_wan_3_0_prime_video",
      arguments: {
        book_id: "test-proj",
        prompt: "Image1 dances in the style of Video1 to Audio1",
        image_refs: [`@${imageId}`],
        video_refs: [`@${videoId}`],
        audio_refs: [`@${audioId}`],
        duration: "6",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.source_images).toEqual([imageId]);
    expect(parsed.source_videos).toEqual([videoId]);
    expect(parsed.source_audios).toEqual([audioId]);
    expect(parsed.job_id).toBeDefined();
  });

  it("rejects frames combined with reference inputs", async () => {
    process.env.KIE_API_KEY = "test-key";
    const firstId = await makeImageAsset();
    const refId = await makeImageAsset();
    const result = await client.callTool({
      name: "generate_kie_wan_3_0_video",
      arguments: {
        book_id: "test-proj",
        prompt: "bad combo",
        first_frame_ref: `@${firstId}`,
        image_refs: [`@${refId}`],
        duration: "5",
      },
    });

    expect(result.isError).toBe(true);
  });

  it("rejects a call with no prompt and no media inputs", async () => {
    process.env.KIE_API_KEY = "test-key";
    const result = await client.callTool({
      name: "generate_kie_wan_3_0_prime_video",
      arguments: { book_id: "test-proj", duration: "5" },
    });

    expect(result.isError).toBe(true);
  });

  it("registers both kie Wan 3.0 tools", async () => {
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    expect(names).toContain("generate_kie_wan_3_0_video");
    expect(names).toContain("generate_kie_wan_3_0_prime_video");
  });
});
