import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { createTestClient } from "../test-client.js";
import { queue } from "../queue.js";
import { FFPROBE } from "../ffmpeg.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const FFMPEG: string = require("ffmpeg-static");

type TextContent = Array<{ type: string; text: string }>;

async function generateTestVideo(outputPath: string): Promise<void> {
  // 1920x1080 source so a centred 9:16 crop (608x1080) and a 1:1 crop (1080x1080) both fit.
  await execFileAsync(FFMPEG, [
    "-y",
    "-f", "lavfi", "-i", "testsrc=duration=2:size=1920x1080:rate=10",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest",
    outputPath,
  ]);
}

async function uploadVideo(
  client: Client,
  bookId: string,
  videoPath: string,
): Promise<{ assetId: string; path: string }> {
  const { readFile } = await import("node:fs/promises");
  const data = (await readFile(videoPath)).toString("base64");
  const result = await client.callTool({
    name: "upload_file",
    arguments: { book_id: bookId, filename: "original.mp4", data },
  });
  return JSON.parse((result.content as TextContent)[0].text);
}

async function probeDims(filePath: string): Promise<{ width: number; height: number; duration: number }> {
  const { stdout } = await execFileAsync(FFPROBE, [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-show_entries", "format=duration",
    "-of", "json",
    filePath,
  ]);
  const data = JSON.parse(stdout) as {
    streams: Array<{ width: number; height: number }>;
    format: { duration: string };
  };
  return {
    width: data.streams[0].width,
    height: data.streams[0].height,
    duration: Number(data.format.duration),
  };
}

describe("crop_video tool", () => {
  let client: Client;
  let tempDir: string;
  let fixtureDir: string;
  let videoPath: string;

  beforeAll(async () => {
    await queue.start();
    fixtureDir = await mkdtemp(join(tmpdir(), "videocity-crop-fixture-"));
    videoPath = join(fixtureDir, "test-source.mp4");
    await generateTestVideo(videoPath);
  }, 60_000);

  afterAll(async () => {
    await queue.stop();
    await rm(fixtureDir, { recursive: true, force: true, maxRetries: 3 });
  }, 30_000);

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-crop-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "crop-proj" },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("crops to 9:16 and produces 1080x1920 output", async () => {
    const uploaded = await uploadVideo(client, "crop-proj", videoPath);

    // Centred 9:16 strip on a 1920x1080 source: width = 1080 * 9/16 ≈ 607.5 → fraction ≈ 0.3164
    // Use 0.3164 * 1920 = 607.5 → rounded to even = 608. 608/1080 ≈ 0.5630. Aspect 608/1080 ≈ 0.5630, target 0.5625 → ok.
    const w = 0.3167;
    const h = 1.0;
    const x = (1 - w) / 2;
    const y = 0;

    const result = await client.callTool({
      name: "crop_video",
      arguments: { asset_id: uploaded.assetId, book_id: "crop-proj", ratio: "9:16", x, y, w, h },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("completed");
    expect(parsed.ratio).toBe("9:16");

    const dims = await probeDims(join(uploaded.path, "original.mp4"));
    expect(dims.width).toBe(1080);
    expect(dims.height).toBe(1920);
    expect(dims.duration).toBeGreaterThan(1.5);
  }, 60_000);

  it("crops to 1:1 and produces 1080x1080 output", async () => {
    const uploaded = await uploadVideo(client, "crop-proj", videoPath);

    // 1080x1080 from a 1920x1080 source: w/h fractions 1080/1920 and 1080/1080.
    const w = 0.5625;
    const h = 1.0;
    const x = (1 - w) / 2;
    const y = 0;

    const result = await client.callTool({
      name: "crop_video",
      arguments: { asset_id: uploaded.assetId, book_id: "crop-proj", ratio: "1:1", x, y, w, h },
    });

    expect(result.isError).toBeFalsy();
    const dims = await probeDims(join(uploaded.path, "original.mp4"));
    expect(dims.width).toBe(1080);
    expect(dims.height).toBe(1080);
  }, 60_000);

  it("crops to 16:9 and produces 1920x1080 output", async () => {
    const uploaded = await uploadVideo(client, "crop-proj", videoPath);

    // Inset crop that preserves 16:9 — drop 10% off each side.
    const w = 0.8;
    const h = 0.8;
    const x = 0.1;
    const y = 0.1;

    const result = await client.callTool({
      name: "crop_video",
      arguments: { asset_id: uploaded.assetId, book_id: "crop-proj", ratio: "16:9", x, y, w, h },
    });

    expect(result.isError).toBeFalsy();
    const dims = await probeDims(join(uploaded.path, "original.mp4"));
    expect(dims.width).toBe(1920);
    expect(dims.height).toBe(1080);
  }, 60_000);

  it("returns error for out-of-bounds rect", async () => {
    const uploaded = await uploadVideo(client, "crop-proj", videoPath);

    const result = await client.callTool({
      name: "crop_video",
      arguments: { asset_id: uploaded.assetId, book_id: "crop-proj", ratio: "1:1", x: 0.5, y: 0, w: 0.7, h: 1.0 },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toMatch(/x \+ w/);
  });

  it("returns error when rect aspect mismatches ratio", async () => {
    const uploaded = await uploadVideo(client, "crop-proj", videoPath);

    // Source is 1920x1080 (16:9), so equal-fraction rects are also 16:9.
    // Use a non-16:9 fraction (0.3 x 0.5 → 576x540 ≈ 1.067) against ratio "16:9".
    const result = await client.callTool({
      name: "crop_video",
      arguments: { asset_id: uploaded.assetId, book_id: "crop-proj", ratio: "16:9", x: 0.1, y: 0.1, w: 0.3, h: 0.5 },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toMatch(/aspect/i);
  }, 60_000);

  it("returns error for nonexistent asset", async () => {
    const result = await client.callTool({
      name: "crop_video",
      arguments: { asset_id: "vid-does-not-exist", book_id: "crop-proj", ratio: "1:1", x: 0, y: 0, w: 0.5, h: 0.5 },
    });

    expect(result.isError).toBe(true);
  });

  it("returns error when asset has no video file", async () => {
    const data = Buffer.from("fake-png-data").toString("base64");
    const uploadResult = await client.callTool({
      name: "upload_file",
      arguments: { book_id: "crop-proj", filename: "photo.png", data },
    });
    const uploaded = JSON.parse((uploadResult.content as TextContent)[0].text);

    const result = await client.callTool({
      name: "crop_video",
      arguments: { asset_id: uploaded.assetId, book_id: "crop-proj", ratio: "1:1", x: 0.1, y: 0.1, w: 0.5, h: 0.5 },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("No video file");
  });
});
