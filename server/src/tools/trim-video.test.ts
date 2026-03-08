import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { createTestClient } from "../test-client.js";
import { queue, waitForJob } from "../queue.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const FFMPEG: string = require("ffmpeg-static");

type TextContent = Array<{ type: string; text: string }>;

async function generateTestVideo(outputPath: string): Promise<void> {
  await execFileAsync(FFMPEG, [
    "-y",
    "-f", "lavfi", "-i", "testsrc=duration=3:size=320x240:rate=10",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
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
  const { readFile } = await import("node:fs/promises");
  const data = (await readFile(videoPath)).toString("base64");
  const result = await client.callTool({
    name: "upload_file",
    arguments: { project_slug: projectSlug, filename: "original.mp4", data },
  });
  return JSON.parse((result.content as TextContent)[0].text);
}

describe("trim_video tool", () => {
  let client: Client;
  let tempDir: string;
  let videoPath: string;

  beforeAll(async () => {
    await queue.start();
  });

  afterAll(async () => {
    await queue.stop();
  });

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-trim-test-"));
    videoPath = join(tempDir, "test-source.mp4");
    await generateTestVideo(videoPath);
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "trim-proj" },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("trims with trim_start only", async () => {
    const uploaded = await uploadVideo(client, "trim-proj", videoPath);

    const result = await client.callTool({
      name: "trim_video",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "trim-proj",
        trim_start: 1,
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.asset_id).toBe(uploaded.assetId);
    expect(parsed.status).toBe("enqueued");
    await waitForJob(parsed.job_id);
  });

  it("trims with trim_start and trim_end", async () => {
    const uploaded = await uploadVideo(client, "trim-proj", videoPath);

    const result = await client.callTool({
      name: "trim_video",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "trim-proj",
        trim_start: 0.5,
        trim_end: 2.5,
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("enqueued");
    await waitForJob(parsed.job_id);
  });

  it("cuts middle section", async () => {
    const uploaded = await uploadVideo(client, "trim-proj", videoPath);

    const result = await client.callTool({
      name: "trim_video",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "trim-proj",
        cut_start: 1,
        cut_end: 2,
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("enqueued");
    await waitForJob(parsed.job_id);
  });

  it("returns error for nonexistent asset", async () => {
    const result = await client.callTool({
      name: "trim_video",
      arguments: {
        asset_id: "vid-does-not-exist",
        project_slug: "trim-proj",
        trim_start: 1,
      },
    });

    expect(result.isError).toBe(true);
  });

  it("returns error when no video file in asset", async () => {
    const data = Buffer.from("fake-png-data").toString("base64");
    const uploadResult = await client.callTool({
      name: "upload_file",
      arguments: { project_slug: "trim-proj", filename: "photo.png", data },
    });
    const uploaded = JSON.parse((uploadResult.content as TextContent)[0].text);

    const result = await client.callTool({
      name: "trim_video",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "trim-proj",
        trim_start: 1,
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("No video file");
  });

  it("returns error for conflicting params", async () => {
    const uploaded = await uploadVideo(client, "trim-proj", videoPath);

    const result = await client.callTool({
      name: "trim_video",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "trim-proj",
        trim_start: 1,
        cut_start: 1,
        cut_end: 2,
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("Cannot specify both");
  });

  it("returns error when cut_start >= cut_end", async () => {
    const uploaded = await uploadVideo(client, "trim-proj", videoPath);

    const result = await client.callTool({
      name: "trim_video",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "trim-proj",
        cut_start: 2,
        cut_end: 1,
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("cut_start must be less than cut_end");
  });
});
