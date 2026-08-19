import type { Client } from "@modelcontextprotocol/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isUuidV7 } from "videobook-engine";
import { createEngineForTest } from "../engine.js";
import { createTestClient } from "../test-client.js";
import { seedanceActorReplacementPrompt } from "./_seedance2-shared.js";

type TextContent = Array<{ type: string; text: string }>;

async function solidPng(): Promise<Buffer> {
  return sharp({
    create: {
      width: 16,
      height: 16,
      channels: 3,
      background: { r: 40, g: 80, b: 120 },
    },
  }).png().toBuffer();
}

describe("generate_kie_seedance_2_0_video actor replacement", () => {
  let client: Client;
  let tempDir: string;
  const originalKey = process.env.KIE_API_KEY;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videobook-seedance2-r2v-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "seedance-r2v" },
    });
  });

  afterEach(async () => {
    if (originalKey) process.env.KIE_API_KEY = originalKey;
    else delete process.env.KIE_API_KEY;
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("enqueues r2v with one video ref and three image refs as a playable video artifact", async () => {
    process.env.KIE_API_KEY = "test-key";
    const engine = createEngineForTest(tempDir);
    const video = await engine.artifacts.create({ kind: "video", label: "Source clip" });
    if (!video.ok) throw new Error(video.error.message);
    const videoWrite = await engine.files.write(
      video.value.artifactId,
      "original.mp4",
      Buffer.from("ftypisom"),
    );
    if (!videoWrite.ok) throw new Error(videoWrite.error.message);

    const stillIds: string[] = [];
    for (const label of ["Actor A", "Actor B", "Actor C"]) {
      const still = await engine.artifacts.create({ kind: "image", label });
      if (!still.ok) throw new Error(still.error.message);
      const written = await engine.files.write(
        still.value.artifactId,
        "original.png",
        await solidPng(),
      );
      if (!written.ok) throw new Error(written.error.message);
      stillIds.push(still.value.artifactId);
    }

    const result = await client.callTool({
      name: "generate_kie_seedance_2_0_video",
      arguments: {
        book_id: "seedance-r2v",
        prompt: seedanceActorReplacementPrompt(3),
        video_refs: [`@${video.value.artifactId}`],
        image_refs: stillIds.map((id) => `@${id}`),
      },
    });
    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse((result.content as TextContent)[0]!.text) as {
      vid_asset_id: string;
      source_images: string[];
      source_videos: string[];
      job_id: string;
      status: string;
    };
    expect(parsed.status).toBe("enqueued");
    expect(isUuidV7(parsed.vid_asset_id)).toBe(true);
    expect(parsed.source_videos).toEqual([video.value.artifactId]);
    expect(parsed.source_images).toEqual(stillIds);
    const created = engine.artifacts.get(parsed.vid_asset_id);
    expect(created.ok).toBe(true);
    if (created.ok) expect(created.value.kind).toBe("video");
    const jobs = engine.jobs.queue.list({ type: "generate_seedance2_video" });
    const job = jobs.find((entry) => entry.payload.vidAssetId === parsed.vid_asset_id);
    expect(job?.payload.videoInputs).toEqual([
      expect.objectContaining({ assetId: video.value.artifactId }),
    ]);
    expect(job?.payload.imageInputs).toEqual(stillIds.map((assetId) =>
      expect.objectContaining({ assetId })));
  });
});
