import { createEngineForTest } from "../engine.js";
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

  it("enqueues with image and video refs before provider upload", async () => {
    const fs = createEngineForTest(tempDir);
    const imageAsset = await fs.artifacts.create("img", "source-img");
    const videoAsset = await fs.artifacts.create("vid", "source-video");
    if (!imageAsset.ok) throw new Error("Failed to create image asset");
    if (!videoAsset.ok) throw new Error("Failed to create video asset");

    await fs.files.write(imageAsset.value.artifactId, "original.png", await makePng());
    await fs.files.write(videoAsset.value.artifactId, "original.mp4", Buffer.from("fake mp4"));

    const result = await client.callTool({
      name: "generate_google_flow_omni_flash_video",
      arguments: {
        book_id: "test-proj",
        prompt: "char swap",
        image_refs: [`@${imageAsset.value.artifactId}`],
        video_ref: `@${videoAsset.value.artifactId}`,
        video_clip_start: 0,
        video_clip_ends: 10,
        duration: "10",
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
    expect(parsed.source_videos).toEqual([videoAsset.value.artifactId]);
  });

  it("normalizes prompt @artifact mentions to positional markers before enqueue", async () => {
    const fs = createEngineForTest(tempDir);
    const imageAsset = await fs.artifacts.create("img", "da-set");
    const videoAsset = await fs.artifacts.create("vid", "motion");
    if (!imageAsset.ok) throw new Error("Failed to create image asset");
    if (!videoAsset.ok) throw new Error("Failed to create video asset");

    await fs.files.write(imageAsset.value.artifactId, "original.png", await makePng());
    await fs.files.write(videoAsset.value.artifactId, "original.mp4", Buffer.from("fake mp4"));

    const result = await client.callTool({
      name: "generate_google_flow_omni_flash_video",
      arguments: {
        book_id: "test-proj",
        prompt: `fade to @${imageAsset.value.artifactId} inside @${videoAsset.value.artifactId} while @character_1 waves`,
        image_refs: [`@${imageAsset.value.artifactId}`],
        video_ref: `@${videoAsset.value.artifactId}`,
        character_refs: ["character:bbb"],
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    const meta = await fs.metadata.artifacts.read<{ prompt: string }>(parsed.vid_asset_id, "generation-request"
    );
    expect(meta.ok && meta.value).toBeTruthy();
    // Image ref → @referenceImage_1; clip mention removed (no inline form);
    // already-positional @character_1 untouched.
    expect(meta.value!.prompt).toBe("fade to @referenceImage_1 inside while @character_1 waves");
  });

  it("enqueues with a first-frame image ref before provider upload", async () => {
    const fs = createEngineForTest(tempDir);
    const imageAsset = await fs.artifacts.create("img", "start-frame");
    if (!imageAsset.ok) throw new Error("Failed to create image asset");

    await fs.files.write(imageAsset.value.artifactId, "original.png", await makePng());

    const result = await client.callTool({
      name: "generate_google_flow_omni_flash_video",
      arguments: {
        book_id: "test-proj",
        prompt: "animate this frame",
        first_frame_ref: `@${imageAsset.value.artifactId}`,
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.source_first_frame).toBe(imageAsset.value.artifactId);
    expect(parsed.source_images).toEqual([]);
    expect(parsed.source_videos).toEqual([]);
  });

  it("enqueues a reference clip without explicit trim timecodes", async () => {
    const fs = createEngineForTest(tempDir);
    const videoAsset = await fs.artifacts.create("vid", "source-video");
    if (!videoAsset.ok) throw new Error("Failed to create video asset");

    await fs.files.write(videoAsset.value.artifactId, "original.mp4", Buffer.from("fake mp4"));

    const result = await client.callTool({
      name: "generate_google_flow_omni_flash_video",
      arguments: {
        book_id: "test-proj",
        prompt: "edit this",
        video_ref: `@${videoAsset.value.artifactId}`,
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.source_videos).toEqual([videoAsset.value.artifactId]);
  });

  it("rejects a reference clip window over 10 seconds", async () => {
    const result = await client.callTool({
      name: "generate_google_flow_omni_flash_video",
      arguments: {
        book_id: "test-proj",
        prompt: "edit this",
        video_ref: "@vid-motion",
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
      name: "generate_google_flow_omni_flash_video",
      arguments: {
        book_id: "test-proj",
        prompt: "animate this",
        first_frame_ref: "@img-start",
        image_refs: ["@img-ref"],
      },
    });
    expect(refsResult.isError).toBe(true);
    expect((refsResult.content as TextContent)[0].text).toContain("first_frame_ref cannot be combined with image_refs");

    const videoResult = await client.callTool({
      name: "generate_google_flow_omni_flash_video",
      arguments: {
        book_id: "test-proj",
        prompt: "animate this",
        first_frame_ref: "@img-start",
        video_ref: "@vid-motion",
      },
    });
    expect(videoResult.isError).toBe(true);
    expect((videoResult.content as TextContent)[0].text).toContain("first_frame_ref cannot be combined with video_ref");
  });

  it("rejects more than 5 reference images alongside a clip", async () => {
    const result = await client.callTool({
      name: "generate_google_flow_omni_flash_video",
      arguments: {
        book_id: "test-proj",
        prompt: "edit this",
        image_refs: ["@img-1", "@img-2", "@img-3", "@img-4", "@img-5", "@img-6"],
        video_ref: "@vid-motion",
        video_clip_start: 0,
        video_clip_ends: 5,
        duration: "8",
      },
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("at most 5 alongside a reference clip");
  });

  it("enqueues with voice and character refs echoed back", async () => {
    const result = await client.callTool({
      name: "generate_google_flow_omni_flash_video",
      arguments: {
        book_id: "test-proj",
        prompt: "cast the scene",
        voice_refs: ["voice:aaa"],
        character_refs: ["character:bbb"],
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.voice_refs).toEqual(["voice:aaa"]);
    expect(parsed.character_refs).toEqual(["character:bbb"]);

    // The exact enqueued payload is persisted for retry_generation replay.
    const fs = createEngineForTest(tempDir);
    const meta = await fs.metadata.artifacts.read<{ type: string; vidAssetId: string; prompt: string }>(parsed.vid_asset_id, "generation-request"
    );
    expect(meta.ok && meta.value).toBeTruthy();
    expect(meta.value!.type).toBe("generate_google_omni_video");
    expect(meta.value!.vidAssetId).toBe(parsed.vid_asset_id);
    expect(meta.value!.prompt).toBe("cast the scene");
  });

  it("rejects more than 5 voice refs at the schema layer", async () => {
    const result = await client.callTool({
      name: "generate_google_flow_omni_flash_video",
      arguments: {
        book_id: "test-proj",
        prompt: "x",
        voice_refs: ["v1", "v2", "v3", "v4", "v5", "v6"],
      },
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("voice_refs");
  });

  it("rejects more than 3 voice refs alongside a reference clip", async () => {
    const result = await client.callTool({
      name: "generate_google_flow_omni_flash_video",
      arguments: {
        book_id: "test-proj",
        prompt: "x",
        video_ref: "@vid-motion",
        voice_refs: ["v1", "v2", "v3", "v4"],
      },
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("at most 3 voice refs");
  });

  it("rejects character refs combined with a first frame", async () => {
    const result = await client.callTool({
      name: "generate_google_flow_omni_flash_video",
      arguments: {
        book_id: "test-proj",
        prompt: "x",
        first_frame_ref: "@img-start",
        character_refs: ["character:bbb"],
      },
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("first_frame_ref cannot be combined with character_refs");
  });

  it("rejects an image + character reference budget over 7", async () => {
    const result = await client.callTool({
      name: "generate_google_flow_omni_flash_video",
      arguments: {
        book_id: "test-proj",
        prompt: "x",
        image_refs: ["@img-a", "@img-b", "@img-c", "@img-d"],
        character_refs: ["c1", "c2"],
      },
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("reference budget");
  });

  it("rejects a fourth character with a readable slot-cost error", async () => {
    const result = await client.callTool({
      name: "generate_google_flow_omni_flash_video",
      arguments: {
        book_id: "test-proj",
        prompt: "x",
        character_refs: ["c1", "c2", "c3", "c4"],
      },
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("at most 3 character refs");
    expect((result.content as TextContent)[0].text).toContain("Remove 1 character");
  });

  it("rejects duplicate characters using canonical IDs", async () => {
    const result = await client.callTool({
      name: "generate_google_flow_omni_flash_video",
      arguments: {
        book_id: "test-proj",
        prompt: "x",
        character_refs: ["character:a-imgs:1", "character:a-imgs:2"],
      },
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("Duplicate character in character_refs: character:a-imgs:2");
  });

  it("rejects a budget over 7 counting characters at 2 slots each", async () => {
    const fs = createEngineForTest(tempDir);
    const imageAssets: string[] = [];
    for (let i = 0; i < 4; i++) {
      const a = await fs.artifacts.create("img", `img-${i}`);
      if (!a.ok) throw new Error("createAsset failed");
      await fs.files.write(a.value.artifactId, "original.png", await makePng());
      imageAssets.push(a.value.artifactId);
    }
    const result = await client.callTool({
      name: "generate_google_flow_omni_flash_video",
      arguments: {
        book_id: "test-proj",
        prompt: "x",
        image_refs: imageAssets.map((id) => `@${id}`),
        character_refs: ["character:a-imgs:2", "character:b-imgs:2"],
      },
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("reference budget");
  });

  it("enqueues when 3 images + two characters exactly hit 7 slots", async () => {
    const fs = createEngineForTest(tempDir);
    const imageAssets: string[] = [];
    for (let i = 0; i < 3; i++) {
      const a = await fs.artifacts.create("img", `img-${i}`);
      if (!a.ok) throw new Error("createAsset failed");
      await fs.files.write(a.value.artifactId, "original.png", await makePng());
      imageAssets.push(a.value.artifactId);
    }
    const result = await client.callTool({
      name: "generate_google_flow_omni_flash_video",
      arguments: {
        book_id: "test-proj",
        prompt: "x",
        image_refs: imageAssets.map((id) => `@${id}`),
        character_refs: ["character:a-imgs:2", "character:b-imgs:2"],
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("enqueued");
  });
});
