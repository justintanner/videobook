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

describe("generate_minimax_h3_i2v_video tool", () => {
  let client: Client;
  let tempDir: string;
  const originalKey = process.env.KIE_API_KEY;

  beforeEach(async () => {
    process.env.KIE_API_KEY = "test-key";
    tempDir = await mkdtemp(join(tmpdir(), "videocity-minimax-h3-i2v-test-"));
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
      name: "generate_kie_minimax_h3_image_to_video",
      arguments: {
        book_id: "test-proj",
        prompt: "animate this image",
        duration: "6",
        first_frame_ref: "@img-start",
      },
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("KIE_API_KEY environment variable is not set");
  });

  it("rejects a call with neither first_frame_ref nor last_frame_ref", async () => {
    const result = await client.callTool({
      name: "generate_kie_minimax_h3_image_to_video",
      arguments: {
        book_id: "test-proj",
        prompt: "animate this image",
        duration: "6",
      },
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain(
      "At least one of first_frame_ref or last_frame_ref is required",
    );
  });

  it("creates a vid artifact and enqueues a generate_minimax_h3_i2v_video job", async () => {
    const fs = createEngineForTest(tempDir);
    const firstFrame = await fs.artifacts.create("img", "first-frame");
    if (!firstFrame.ok) throw new Error("Failed to create image asset");
    await fs.files.write(firstFrame.value.artifactId, "original.png", await makePng());
    const lastFrame = await fs.artifacts.create("img", "last-frame");
    if (!lastFrame.ok) throw new Error("Failed to create image asset");
    await fs.files.write(lastFrame.value.artifactId, "original.png", await makePng());

    const result = await client.callTool({
      name: "generate_kie_minimax_h3_image_to_video",
      arguments: {
        book_id: "test-proj",
        prompt: "animate between these frames",
        duration: "8",
        resolution: "768P",
        first_frame_ref: `@${firstFrame.value.artifactId}`,
        last_frame_ref: `@${lastFrame.value.artifactId}`,
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("enqueued");
    expect(isUuidV7(parsed.vid_asset_id)).toBe(true);
    const created = fs.artifacts.get(parsed.vid_asset_id);
    expect(created.ok).toBe(true);
    if (created.ok) expect(created.value.kind).toBe("video");
    expect(parsed.source_images).toEqual([firstFrame.value.artifactId, lastFrame.value.artifactId]);
    expect(parsed.job_id).toBeDefined();

    const jobs = fs.jobs.queue.list({
      states: ["queued", "running", "completing", "done", "failed", "aborted"],
    });
    const job = jobs.find((j) => j.type === "generate_minimax_h3_i2v_video");
    expect(job).toBeDefined();
    expect(job?.payload).toMatchObject({
      type: "generate_minimax_h3_i2v_video",
      vidAssetId: parsed.vid_asset_id,
      bookId: fs.book.get().bookId,
      prompt: "animate between these frames",
      duration: "8",
      resolution: "768P",
      firstFrame: { assetId: firstFrame.value.artifactId, filename: "original.png" },
      lastFrame: { assetId: lastFrame.value.artifactId, filename: "original.png" },
      sourceImageIds: [firstFrame.value.artifactId, lastFrame.value.artifactId],
    });
  });
});
