import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { createTestClient } from "../test-client.js";
import { queue } from "../queue.js";
import type { Client } from "@modelcontextprotocol/client";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const FFMPEG: string = require("ffmpeg-static");

type TextContent = Array<{ type: string; text: string }>;

async function generateTestVideo(outputPath: string): Promise<void> {
  await execFileAsync(FFMPEG, [
    "-y",
    "-f", "lavfi", "-i", "testsrc=duration=1:size=320x240:rate=10",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest",
    outputPath,
  ]);
}

async function uploadVideo(
  client: Client,
  bookId: string,
  videoPath: string,
  filename = "original.mp4",
): Promise<{ assetId: string; path: string }> {
  const data = (await readFile(videoPath)).toString("base64");
  const result = await client.callTool({
    name: "upload_file",
    arguments: { book_id: bookId, filename, data },
  });
  return JSON.parse((result.content as TextContent)[0].text);
}

// Single shared client/project/source-video upload across all tests. The
// per-test mkdtemp + createTestClient + create_project + upload was the
// dominant cost (~10s/test). Validation tests just need a working video
// asset_id; only the "no video file" test needs its own non-video upload.
describe("change_video_speed tool", () => {
  let client: Client;
  let tempDir: string;
  let fixtureDir: string;
  let videoPath: string;
  let sharedVideoAssetId: string;
  let targetDurationVideoAssetId: string;

  beforeAll(async () => {
    await queue.start();
    fixtureDir = await mkdtemp(join(tmpdir(), "videocity-speed-fixture-"));
    videoPath = join(fixtureDir, "test-source.mp4");
    await generateTestVideo(videoPath);
    tempDir = await mkdtemp(join(tmpdir(), "videocity-speed-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "speed-proj" },
    });
    const uploaded = await uploadVideo(client, "speed-proj", videoPath);
    sharedVideoAssetId = uploaded.assetId;
    const targetDurationVideo = await uploadVideo(
      client,
      "speed-proj",
      videoPath,
      "target-duration.mp4",
    );
    targetDurationVideoAssetId = targetDurationVideo.assetId;
  });

  afterAll(async () => {
    await client?.close();
    await queue.stop();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
    await rm(fixtureDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("returns error for speed 1.0 (no-op)", async () => {
    const result = await client.callTool({
      name: "change_video_speed",
      arguments: {
        asset_id: sharedVideoAssetId,
        book_id: "speed-proj",
        speed: 1.0,
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("no-op");
  });

  it("returns error for speed below 0.25", async () => {
    const result = await client.callTool({
      name: "change_video_speed",
      arguments: {
        asset_id: sharedVideoAssetId,
        book_id: "speed-proj",
        speed: 0.1,
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("0.25");
    expect(content[0].text).toContain("4");
  });

  it("returns error for speed above 4.0", async () => {
    const result = await client.callTool({
      name: "change_video_speed",
      arguments: {
        asset_id: sharedVideoAssetId,
        book_id: "speed-proj",
        speed: 5.0,
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("0.25");
    expect(content[0].text).toContain("4");
  });

  it("returns error for nonexistent asset", async () => {
    const result = await client.callTool({
      name: "change_video_speed",
      arguments: {
        asset_id: "vid-does-not-exist",
        book_id: "speed-proj",
        speed: 2.0,
      },
    });

    expect(result.isError).toBe(true);
  });

  it("returns error when asset has no video file", async () => {
    const data = Buffer.from("fake-png-data").toString("base64");
    const uploadResult = await client.callTool({
      name: "upload_file",
      arguments: { book_id: "speed-proj", filename: "photo.png", data },
    });
    const uploaded = JSON.parse((uploadResult.content as TextContent)[0].text);

    const result = await client.callTool({
      name: "change_video_speed",
      arguments: {
        asset_id: uploaded.assetId,
        book_id: "speed-proj",
        speed: 2.0,
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("No video file");
  });

  it("enqueues job for valid speed change", async () => {
    const result = await client.callTool({
      name: "change_video_speed",
      arguments: {
        asset_id: sharedVideoAssetId,
        book_id: "speed-proj",
        speed: 2.0,
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.asset_id).toBe(sharedVideoAssetId);
    expect(parsed.job_id).toMatch(/^speed-/);
    expect(parsed.status).toBe("enqueued");
  });

  it("enqueues job for valid target_duration_seconds", async () => {
    const result = await client.callTool({
      name: "change_video_speed",
      arguments: {
        asset_id: targetDurationVideoAssetId,
        book_id: "speed-proj",
        target_duration_seconds: 0.5,
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.asset_id).toBe(targetDurationVideoAssetId);
    expect(parsed.job_id).toMatch(/^speed-/);
    expect(parsed.status).toBe("enqueued");
  });

  it("returns error if both speed and target_duration_seconds are provided", async () => {
    const result = await client.callTool({
      name: "change_video_speed",
      arguments: {
        asset_id: sharedVideoAssetId,
        book_id: "speed-proj",
        speed: 2.0,
        target_duration_seconds: 0.5,
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("exactly one of speed or target_duration_seconds");
  });
});
