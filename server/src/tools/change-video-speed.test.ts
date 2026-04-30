import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { createTestClient } from "../test-client.js";
import { queue } from "../queue.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

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
  projectSlug: string,
  videoPath: string,
): Promise<{ assetId: string; path: string }> {
  const data = (await readFile(videoPath)).toString("base64");
  const result = await client.callTool({
    name: "upload_file",
    arguments: { project_slug: projectSlug, filename: "original.mp4", data },
  });
  return JSON.parse((result.content as TextContent)[0].text);
}

describe("change_video_speed tool", () => {
  let client: Client;
  let tempDir: string;
  let fixtureDir: string;
  let videoPath: string;

  beforeAll(async () => {
    await queue.start();
    // Encode the shared test source once. Under parallel test load, running
    // libx264 inside beforeEach (6x per-suite) starves ffmpeg and can blow
    // through the 60s hook timeout.
    fixtureDir = await mkdtemp(join(tmpdir(), "clipfirst-speed-fixture-"));
    videoPath = join(fixtureDir, "test-source.mp4");
    await generateTestVideo(videoPath);
  });

  afterAll(async () => {
    await queue.stop();
    await rm(fixtureDir, { recursive: true, force: true, maxRetries: 3 });
  });

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-speed-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "speed-proj" },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("returns error for speed 1.0 (no-op)", async () => {
    const uploaded = await uploadVideo(client, "speed-proj", videoPath);

    const result = await client.callTool({
      name: "change_video_speed",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "speed-proj",
        speed: 1.0,
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("no-op");
  });

  it("returns error for speed below 0.25", async () => {
    const uploaded = await uploadVideo(client, "speed-proj", videoPath);

    const result = await client.callTool({
      name: "change_video_speed",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "speed-proj",
        speed: 0.1,
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("0.25");
    expect(content[0].text).toContain("4");
  });

  it("returns error for speed above 4.0", async () => {
    const uploaded = await uploadVideo(client, "speed-proj", videoPath);

    const result = await client.callTool({
      name: "change_video_speed",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "speed-proj",
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
        project_slug: "speed-proj",
        speed: 2.0,
      },
    });

    expect(result.isError).toBe(true);
  });

  it("returns error when asset has no video file", async () => {
    const data = Buffer.from("fake-png-data").toString("base64");
    const uploadResult = await client.callTool({
      name: "upload_file",
      arguments: { project_slug: "speed-proj", filename: "photo.png", data },
    });
    const uploaded = JSON.parse((uploadResult.content as TextContent)[0].text);

    const result = await client.callTool({
      name: "change_video_speed",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "speed-proj",
        speed: 2.0,
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("No video file");
  });

  it("enqueues job for valid speed change", async () => {
    const uploaded = await uploadVideo(client, "speed-proj", videoPath);

    const result = await client.callTool({
      name: "change_video_speed",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "speed-proj",
        speed: 2.0,
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.asset_id).toBe(uploaded.assetId);
    expect(parsed.job_id).toMatch(/^speed-/);
    expect(parsed.status).toBe("enqueued");
  });
});
