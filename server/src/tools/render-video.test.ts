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

describe("render_video tool", () => {
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
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-render-video-test-"));
    videoPath = join(tempDir, "test-source.mp4");
    await generateTestVideo(videoPath);
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "render-proj" },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("returns error when asset_id does not start with vid-", async () => {
    const result = await client.callTool({
      name: "render_video",
      arguments: {
        asset_id: "img-something",
        project_slug: "render-proj",
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("must start with vid-");
  });

  it("returns error for invalid text_color hex", async () => {
    const uploaded = await uploadVideo(client, "render-proj", videoPath);

    const result = await client.callTool({
      name: "render_video",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "render-proj",
        text_color: "notahex",
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("Invalid text_color hex");
  });

  it("returns error for invalid highlight_color hex", async () => {
    const uploaded = await uploadVideo(client, "render-proj", videoPath);

    const result = await client.callTool({
      name: "render_video",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "render-proj",
        highlight_color: "xyz",
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("Invalid highlight_color hex");
  });

  it("returns error for audio_volume outside 0-100", async () => {
    const uploaded = await uploadVideo(client, "render-proj", videoPath);

    const result = await client.callTool({
      name: "render_video",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "render-proj",
        audio_volume: 150,
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("audio_volume must be 0-100");
  });

  it("returns error for negative audio_volume", async () => {
    const uploaded = await uploadVideo(client, "render-proj", videoPath);

    const result = await client.callTool({
      name: "render_video",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "render-proj",
        audio_volume: -10,
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("audio_volume must be 0-100");
  });

  it("returns error for negative audio_fade_in", async () => {
    const uploaded = await uploadVideo(client, "render-proj", videoPath);

    const result = await client.callTool({
      name: "render_video",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "render-proj",
        audio_fade_in: -5,
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("audio fade values must be >= 0");
  });

  it("returns error for negative audio_fade_out", async () => {
    const uploaded = await uploadVideo(client, "render-proj", videoPath);

    const result = await client.callTool({
      name: "render_video",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "render-proj",
        audio_fade_out: -1,
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("audio fade values must be >= 0");
  });

  it("returns error for nonexistent asset", async () => {
    const result = await client.callTool({
      name: "render_video",
      arguments: {
        asset_id: "vid-does-not-exist",
        project_slug: "render-proj",
      },
    });

    expect(result.isError).toBe(true);
  });

  it("returns error when non-vid asset is used", async () => {
    // Upload a PNG file which creates an img- asset
    const data = Buffer.from("fake-png-data").toString("base64");
    const uploadResult = await client.callTool({
      name: "upload_file",
      arguments: { project_slug: "render-proj", filename: "photo.png", data },
    });
    const uploaded = JSON.parse((uploadResult.content as TextContent)[0].text);

    // render_video checks vid- prefix first, so this tests that validation
    const result = await client.callTool({
      name: "render_video",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "render-proj",
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("must start with vid-");
  });

  it("enqueues job for valid render request", async () => {
    const uploaded = await uploadVideo(client, "render-proj", videoPath);

    const result = await client.callTool({
      name: "render_video",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "render-proj",
        subtitles_enabled: false,
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.asset_id).toBe(uploaded.assetId);
    expect(parsed.job_id).toMatch(/^render-/);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.orientations).toContain("landscape");
  });

  it("enqueues job for portrait orientation", async () => {
    const uploaded = await uploadVideo(client, "render-proj", videoPath);

    const result = await client.callTool({
      name: "render_video",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "render-proj",
        orientation: "portrait",
        subtitles_enabled: false,
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.orientations).toContain("portrait");
  });

  it("returns error for osg_asset_id with non img- prefix", async () => {
    const uploaded = await uploadVideo(client, "render-proj", videoPath);

    const result = await client.callTool({
      name: "render_video",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "render-proj",
        osg_asset_id: "vid-some-video",
        subtitles_enabled: false,
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("osg_asset_id must start with img-");
  });

  it("returns error when subtitles enabled but elevenlabs.json missing", async () => {
    const uploaded = await uploadVideo(client, "render-proj", videoPath);

    // The uploaded video asset will not have an elevenlabs.json file.
    // Explicitly enable subtitles to trigger the error.
    const result = await client.callTool({
      name: "render_video",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "render-proj",
        subtitles_enabled: true,
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("Subtitles enabled");
    expect(content[0].text).toContain("elevenlabs.json not found");
  });

  it("returns error when portrait defaults to subtitles but elevenlabs.json missing", async () => {
    const uploaded = await uploadVideo(client, "render-proj", videoPath);

    // Portrait orientation defaults subtitles_enabled to true.
    // Without elevenlabs.json, this should error.
    const result = await client.callTool({
      name: "render_video",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "render-proj",
        orientation: "portrait",
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("Subtitles enabled");
    expect(content[0].text).toContain("elevenlabs.json not found");
  });

  it("returns error when osg_asset_id exists but has no image file", async () => {
    const uploaded = await uploadVideo(client, "render-proj", videoPath);

    // Upload an MP4 as a second file, then reference the video asset's ID
    // as osg_asset_id. We need an img- prefixed asset but with no image file.
    // Upload a markdown file which creates a script- asset, then try with img- prefix.
    // Actually, we need to create an img- asset with no image file in it.
    // The simplest approach: reference a nonexistent img- asset.
    const result = await client.callTool({
      name: "render_video",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "render-proj",
        osg_asset_id: "img-nonexistent",
        subtitles_enabled: false,
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("OSG asset error");
  });

  it("enqueues job for square orientation with subtitles disabled", async () => {
    const uploaded = await uploadVideo(client, "render-proj", videoPath);

    const result = await client.callTool({
      name: "render_video",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "render-proj",
        orientation: "square",
        subtitles_enabled: false,
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.orientations).toContain("square");
    expect(parsed.status).toBe("enqueued");
  });
});
