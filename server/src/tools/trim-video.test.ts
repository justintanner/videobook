import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { createTestClient } from "../test-client.js";
import { createFsForTest } from "../fs.js";
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
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function createVideoAsset(projectSlug: string): Promise<string> {
    const fs = createFsForTest(tempDir);
    await fs.createProject(projectSlug);
    const asset = await fs.createAsset("vid", "original", projectSlug);
    if (!asset.ok) throw new Error(asset.error.message);
    const data = await readFile(videoPath);
    await fs.writeFile(asset.value.assetId, "original.mp4", data, projectSlug);
    return asset.value.assetId;
  }

  it("trims with trim_start only", async () => {
    const assetId = await createVideoAsset("trim-proj");

    // Verify file exists before trim
    const filePath = join(tempDir, "trim-proj", assetId, "original.mp4");
    await access(filePath);
    console.log("FILE EXISTS before trim_video call");

    const result = await client.callTool({
      name: "trim_video",
      arguments: {
        asset_id: assetId,
        project_slug: "trim-proj",
        trim_start: 1,
      },
    });

    console.log("trim_video result:", JSON.stringify(result));

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.asset_id).toBe(assetId);
    expect(parsed.status).toBe("enqueued");
    await waitForJob(parsed.job_id);
  });

  it("trims with trim_start and trim_end", async () => {
    const assetId = await createVideoAsset("trim-proj");

    const result = await client.callTool({
      name: "trim_video",
      arguments: {
        asset_id: assetId,
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
    const assetId = await createVideoAsset("trim-proj");

    const result = await client.callTool({
      name: "trim_video",
      arguments: {
        asset_id: assetId,
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
    await createVideoAsset("trim-proj");

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
    const fs = createFsForTest(tempDir);
    await fs.createProject("trim-proj");
    const asset = await fs.createAsset("img", "photo", "trim-proj");
    if (!asset.ok) throw new Error(asset.error.message);
    await fs.writeFile(asset.value.assetId, "original.png", Buffer.from("fake-png-data"), "trim-proj");

    const result = await client.callTool({
      name: "trim_video",
      arguments: {
        asset_id: asset.value.assetId,
        project_slug: "trim-proj",
        trim_start: 1,
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("No video file");
  });

  it("returns error for conflicting params", async () => {
    const assetId = await createVideoAsset("trim-proj");

    const result = await client.callTool({
      name: "trim_video",
      arguments: {
        asset_id: assetId,
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
    const assetId = await createVideoAsset("trim-proj");

    const result = await client.callTool({
      name: "trim_video",
      arguments: {
        asset_id: assetId,
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
