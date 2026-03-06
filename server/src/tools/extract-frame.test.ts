import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
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

describe("extract_first_frame / extract_last_frame tools", () => {
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
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-extract-frame-test-"));
    videoPath = join(tempDir, "test-source.mp4");
    await generateTestVideo(videoPath);
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { slug: "frame-proj" },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("extracts first frame as a new image asset", async () => {
    const uploaded = await uploadVideo(client, "frame-proj", videoPath);

    const result = await client.callTool({
      name: "extract_first_frame",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "frame-proj",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.image_asset_id).toMatch(/^img-/);
    expect(parsed.source_video).toBe(uploaded.assetId);
    expect(parsed.status).toBe("enqueued");

    await waitForJob(parsed.job_id);

    // Verify the image file exists and is non-empty
    const manifest = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: parsed.image_asset_id, project_slug: "frame-proj" },
    });
    const manifestData = JSON.parse((manifest.content as TextContent)[0].text);
    const jpgFile = manifestData.files.find((f: { name: string }) => f.name === "original.jpg");
    expect(jpgFile).toBeDefined();

    const jpgStat = await stat(join(manifestData.path, "original.jpg"));
    expect(jpgStat.size).toBeGreaterThan(0);
  });

  it("extracts last frame as a new image asset", async () => {
    const uploaded = await uploadVideo(client, "frame-proj", videoPath);

    const result = await client.callTool({
      name: "extract_last_frame",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "frame-proj",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.image_asset_id).toMatch(/^img-/);
    expect(parsed.source_video).toBe(uploaded.assetId);
    expect(parsed.status).toBe("enqueued");

    await waitForJob(parsed.job_id);

    const manifest = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: parsed.image_asset_id, project_slug: "frame-proj" },
    });
    const manifestData = JSON.parse((manifest.content as TextContent)[0].text);
    const jpgFile = manifestData.files.find((f: { name: string }) => f.name === "original.jpg");
    expect(jpgFile).toBeDefined();
  });

  it("returns error for nonexistent asset", async () => {
    const result = await client.callTool({
      name: "extract_first_frame",
      arguments: {
        asset_id: "vid-does-not-exist",
        project_slug: "frame-proj",
      },
    });

    expect(result.isError).toBe(true);
  });

  it("returns error when no video file in asset", async () => {
    const data = Buffer.from("fake-png-data").toString("base64");
    const uploadResult = await client.callTool({
      name: "upload_file",
      arguments: { project_slug: "frame-proj", filename: "photo.png", data },
    });
    const uploaded = JSON.parse((uploadResult.content as TextContent)[0].text);

    const result = await client.callTool({
      name: "extract_first_frame",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "frame-proj",
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("No video file");
  });

  it("writes .origin.json with correct metadata", async () => {
    const uploaded = await uploadVideo(client, "frame-proj", videoPath);

    const result = await client.callTool({
      name: "extract_first_frame",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "frame-proj",
      },
    });

    const parsed = JSON.parse((result.content as TextContent)[0].text);
    await waitForJob(parsed.job_id);

    const manifest = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: parsed.image_asset_id, project_slug: "frame-proj" },
    });
    const manifestData = JSON.parse((manifest.content as TextContent)[0].text);

    const { readFile } = await import("node:fs/promises");
    const originJson = JSON.parse(await readFile(join(manifestData.path, ".origin.json"), "utf-8"));
    expect(originJson.origin).toBe("first_frame");
    expect(originJson.source_asset).toBe(uploaded.assetId);
    expect(originJson.timestamp).toBe(0.1);
    expect(originJson.width).toBe(320);
    expect(originJson.height).toBe(240);
  });
});
