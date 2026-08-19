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

describe("generate_minimax_h3_r2v_video tool", () => {
  let client: Client;
  let tempDir: string;
  const originalKey = process.env.KIE_API_KEY;

  beforeEach(async () => {
    process.env.KIE_API_KEY = "test-key";
    tempDir = await mkdtemp(join(tmpdir(), "videocity-minimax-h3-r2v-test-"));
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
    delete process.env.KIE_API_KEY;
    const result = await client.callTool({
      name: "generate_kie_minimax_h3_reference_to_video",
      arguments: {
        book_id: "test-proj",
        prompt: "cast these references",
        duration: "6",
        image_refs: ["@img-cast"],
      },
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("KIE_API_KEY environment variable is not set");
  });

  it("rejects a call with audio-only references", async () => {
    const fs = createEngineForTest(tempDir);
    const audio = await fs.artifacts.create("aud", "voiceover");
    if (!audio.ok) throw new Error("Failed to create audio asset");
    await fs.files.write(audio.value.artifactId, "original.mp3", Buffer.from("fake mp3"));

    const result = await client.callTool({
      name: "generate_kie_minimax_h3_reference_to_video",
      arguments: {
        book_id: "test-proj",
        prompt: "cast these references",
        duration: "6",
        audio_refs: [`@${audio.value.artifactId}`],
      },
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain(
      "At least one of image_refs or video_refs is required",
    );
  });

  it("creates a vid artifact and enqueues a generate_minimax_h3_r2v_video job", async () => {
    const fs = createEngineForTest(tempDir);
    const image = await fs.artifacts.create("img", "cast-image");
    if (!image.ok) throw new Error("Failed to create image asset");
    await fs.files.write(image.value.artifactId, "original.png", await makePng());
    const video = await fs.artifacts.create("vid", "ref-clip");
    if (!video.ok) throw new Error("Failed to create video asset");
    await fs.files.write(video.value.artifactId, "original.mp4", Buffer.from("fake video"));
    const audio = await fs.artifacts.create("aud", "ref-score");
    if (!audio.ok) throw new Error("Failed to create audio asset");
    await fs.files.write(audio.value.artifactId, "original.mp3", Buffer.from("fake mp3"));

    const result = await client.callTool({
      name: "generate_kie_minimax_h3_reference_to_video",
      arguments: {
        book_id: "test-proj",
        prompt: "cast these references",
        duration: "10",
        aspect_ratio: "adaptive",
        resolution: "2K",
        image_refs: [`@${image.value.artifactId}`],
        video_refs: [`@${video.value.artifactId}`],
        audio_refs: [`@${audio.value.artifactId}`],
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("enqueued");
    expect(isUuidV7(parsed.vid_asset_id)).toBe(true);
    const created = fs.artifacts.get(parsed.vid_asset_id);
    expect(created.ok).toBe(true);
    if (created.ok) expect(created.value.kind).toBe("video");
    expect(parsed.source_images).toEqual([image.value.artifactId]);
    expect(parsed.source_videos).toEqual([video.value.artifactId]);
    expect(parsed.source_audios).toEqual([audio.value.artifactId]);
    expect(parsed.job_id).toBeDefined();

    const jobs = fs.jobs.queue.list({
      states: ["queued", "running", "completing", "done", "failed", "aborted"],
    });
    const job = jobs.find((j) => j.type === "generate_minimax_h3_r2v_video");
    expect(job).toBeDefined();
    expect(job?.payload).toMatchObject({
      type: "generate_minimax_h3_r2v_video",
      vidAssetId: parsed.vid_asset_id,
      bookId: fs.book.get().bookId,
      prompt: "cast these references",
      duration: "10",
      aspect_ratio: "adaptive",
      resolution: "2K",
      imageInputs: [{ assetId: image.value.artifactId, filename: "original.png" }],
      videoInputs: [{ assetId: video.value.artifactId, filename: "original.mp4" }],
      audioInputs: [{ assetId: audio.value.artifactId, filename: "original.mp3" }],
      sourceImageIds: [image.value.artifactId],
      sourceVideoIds: [video.value.artifactId],
      sourceAudioIds: [audio.value.artifactId],
    });
  });

  it("rejects a reference video outside Kie's 2-15s duration bound", async () => {
    // Kie enforces [2000, 15000] ms per reference clip at runtime; the schema
    // bounds only counts, so without the local metadata pre-check this payload
    // mints an OTP and burns a task before the 400 comes back.
    const fs = createEngineForTest(tempDir);
    const long = await fs.artifacts.create("vid", "long-clip");
    if (!long.ok) throw new Error("Failed to create video asset");
    await fs.files.write(long.value.artifactId, "original.mp4", Buffer.from("fake video"));
    const longMeta = await fs.metadata.artifacts.write(long.value.artifactId, "original", { duration: 29.917 });
    expect(longMeta.ok).toBe(true);

    const tooLong = await client.callTool({
      name: "generate_kie_minimax_h3_reference_to_video",
      arguments: {
        book_id: "test-proj",
        prompt: "cast these references",
        duration: "6",
        video_refs: [`@${long.value.artifactId}`],
      },
    });
    expect(tooLong.isError).toBe(true);
    expect((tooLong.content as TextContent)[0].text).toContain("is 29.9s");
    expect((tooLong.content as TextContent)[0].text).toContain("2-15s");

    const short = await fs.artifacts.create("vid", "blip");
    if (!short.ok) throw new Error("Failed to create video asset");
    await fs.files.write(short.value.artifactId, "original.mp4", Buffer.from("fake video"));
    const shortMeta = await fs.metadata.artifacts.write(short.value.artifactId, "original", { duration: 1 });
    expect(shortMeta.ok).toBe(true);

    const tooShort = await client.callTool({
      name: "generate_kie_minimax_h3_reference_to_video",
      arguments: {
        book_id: "test-proj",
        prompt: "cast these references",
        duration: "6",
        video_refs: [`@${short.value.artifactId}`],
      },
    });
    expect(tooShort.isError).toBe(true);
    expect((tooShort.content as TextContent)[0].text).toContain("2-15s");
  });

  it("accepts a reference video at the 15s boundary", async () => {
    const fs = createEngineForTest(tempDir);
    const clip = await fs.artifacts.create("vid", "boundary-clip");
    if (!clip.ok) throw new Error("Failed to create video asset");
    await fs.files.write(clip.value.artifactId, "original.mp4", Buffer.from("fake video"));
    const meta = await fs.metadata.artifacts.write(clip.value.artifactId, "original", { duration: 15 });
    expect(meta.ok).toBe(true);

    const result = await client.callTool({
      name: "generate_kie_minimax_h3_reference_to_video",
      arguments: {
        book_id: "test-proj",
        prompt: "cast these references",
        duration: "6",
        video_refs: [`@${clip.value.artifactId}`],
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("enqueued");
  });
});
