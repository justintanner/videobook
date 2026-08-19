import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createTestClient } from "../test-client.js";
import { queue, waitForJob } from "../queue.js";
import { FFPROBE } from "../ffmpeg.js";
import { COMMON_VIDEO_FIXTURES, copyVideoFixture } from "../test-media-fixtures.js";
import type { Client } from "@modelcontextprotocol/client";

const execFileAsync = promisify(execFile);

type TextContent = Array<{ type: string; text: string }>;

async function generateTestVideo(outputPath: string, durationSec: number, hasAudio: boolean): Promise<void> {
  await copyVideoFixture(COMMON_VIDEO_FIXTURES.padVideo(durationSec, hasAudio), outputPath);
}

async function uploadVideo(
  client: Client,
  bookId: string,
  videoPath: string,
): Promise<{ assetId: string; path: string }> {
  const data = (await readFile(videoPath)).toString("base64");
  const result = await client.callTool({
    name: "upload_file",
    arguments: { book_id: bookId, filename: "original.mp4", data },
  });
  return JSON.parse((result.content as TextContent)[0].text);
}

async function probeDuration(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync(FFPROBE, [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);
  return Number(stdout.trim());
}

async function hasAudioStream(filePath: string): Promise<boolean> {
  const { stdout } = await execFileAsync(FFPROBE, [
    "-v", "error", "-show_streams", "-select_streams", "a",
    "-of", "json",
    filePath,
  ]);
  const data = JSON.parse(stdout);
  return Array.isArray(data.streams) && data.streams.length > 0;
}

describe("pad_video tool", () => {
  let client: Client;
  let tempDir: string;
  let fixtureDir: string;

  beforeAll(async () => {
    await queue.start();
    fixtureDir = await mkdtemp(join(tmpdir(), "videocity-pad-video-fixture-"));
  }, 60_000);

  afterAll(async () => {
    await queue.stop();
    await rm(fixtureDir, { recursive: true, force: true, maxRetries: 3 });
  }, 30_000);

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-pad-video-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "pad-video-proj" },
    });
  }, 120_000);

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  }, 120_000);

  it("pads a 2.31s source by 2s to 5.00s", async () => {
    const videoPath = join(fixtureDir, "fractional.mp4");
    await generateTestVideo(videoPath, 2.31, true);
    const uploaded = await uploadVideo(client, "pad-video-proj", videoPath);

    const result = await client.callTool({
      name: "pad_video",
      arguments: {
        asset_id: uploaded.assetId,
        book_id: "pad-video-proj",
        padding: "2s",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.target_sec).toBe(5);
    expect(parsed.status).toBe("enqueued");

    await waitForJob(parsed.job_id);

    const manifest = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: uploaded.assetId, book_id: "pad-video-proj" },
    });
    const data = JSON.parse((manifest.content as TextContent)[0].text);
    const path = join(data.path, "original.mp4");
    const dur = await probeDuration(path);
    
    expect(dur).toBeCloseTo(5, 1);
    const hasAudio = await hasAudioStream(path);
    expect(hasAudio).toBe(true);
  }, 120_000);

  it("already integral source: 3s + 2s stays 5s", async () => {
    const videoPath = join(fixtureDir, "integral.mp4");
    await generateTestVideo(videoPath, 3.0, true);
    const uploaded = await uploadVideo(client, "pad-video-proj", videoPath);

    const result = await client.callTool({
      name: "pad_video",
      arguments: {
        asset_id: uploaded.assetId,
        book_id: "pad-video-proj",
        padding: "2s",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.target_sec).toBe(5);

    await waitForJob(parsed.job_id);
    const manifest = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: uploaded.assetId, book_id: "pad-video-proj" },
    });
    const path = join(JSON.parse((manifest.content as TextContent)[0].text).path, "original.mp4");
    const dur = await probeDuration(path);
    expect(dur).toBeCloseTo(5, 1);
  }, 120_000);

  it("pads silent video and retains silence", async () => {
    const videoPath = join(fixtureDir, "silent.mp4");
    await generateTestVideo(videoPath, 2.31, false);
    const uploaded = await uploadVideo(client, "pad-video-proj", videoPath);

    const result = await client.callTool({
      name: "pad_video",
      arguments: {
        asset_id: uploaded.assetId,
        book_id: "pad-video-proj",
        padding: "1",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.target_sec).toBe(4);

    await waitForJob(parsed.job_id);
    const manifest = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: uploaded.assetId, book_id: "pad-video-proj" },
    });
    const path = join(JSON.parse((manifest.content as TextContent)[0].text).path, "original.mp4");
    const dur = await probeDuration(path);
    expect(dur).toBeCloseTo(4, 1);
    
    const hasAudio = await hasAudioStream(path);
    expect(hasAudio).toBe(false);
  }, 120_000);

  it("returns error for invalid durations", async () => {
    const videoPath = join(fixtureDir, "invalid-dur.mp4");
    await generateTestVideo(videoPath, 1, false);
    const uploaded = await uploadVideo(client, "pad-video-proj", videoPath);

    for (const invalid of ["-1s", "0s", "invalid"]) {
      const result = await client.callTool({
        name: "pad_video",
        arguments: {
          asset_id: uploaded.assetId,
          book_id: "pad-video-proj",
          padding: invalid,
        },
      });
      expect(result.isError).toBe(true);
    }
  }, 60_000);
});
