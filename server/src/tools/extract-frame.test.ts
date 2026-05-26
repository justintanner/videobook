import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
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

// Video stream is 2.0s (20 frames @ 10fps); audio is 2.5s. The container
// duration reports 2.5s, so naive `format.duration - 0.1` would seek past
// the last decodable video frame and ffmpeg-static silently exits 0 with
// no output. Used to regression-test the stream-duration probe.
async function generateAudioLongerThanVideo(outputPath: string): Promise<void> {
  await execFileAsync(FFMPEG, [
    "-y",
    "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=10",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2.5",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    outputPath,
  ]);
}

async function uploadVideo(
  client: Client,
  projectSlug: string,
  videoPath: string,
  filename = "original.mp4",
): Promise<{ assetId: string; path: string }> {
  const data = (await readFile(videoPath)).toString("base64");
  const result = await client.callTool({
    name: "upload_file",
    arguments: { project_slug: projectSlug, filename, data },
  });
  return JSON.parse((result.content as TextContent)[0].text);
}

// Single shared client/project/source video across the suite. Per-test
// `beforeEach` setup (mkdtemp + createTestClient + create_project) under
// parallel test load was timing out the 60s hook budget; pinning everything
// to `beforeAll` removes the per-test stamping of the queue's global
// projectsDir and the per-test MCP transport churn.
describe("extract_first_frame / extract_last_frame tools", () => {
  let client: Client;
  let tempDir: string;
  let videoPath: string;
  let sharedUpload: { assetId: string; path: string };

  beforeAll(async () => {
    await queue.start();
    tempDir = await mkdtemp(join(tmpdir(), "videocity-extract-frame-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "frame-proj" },
    });
    videoPath = join(tempDir, "test-source.mp4");
    await generateTestVideo(videoPath);
    sharedUpload = await uploadVideo(client, "frame-proj", videoPath);
  });

  afterAll(async () => {
    await client?.close();
    await queue.stop();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("extracts first frame as a new image asset", async () => {
    const result = await client.callTool({
      name: "extract_first_frame",
      arguments: {
        asset_id: sharedUpload.assetId,
        project_slug: "frame-proj",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.image_asset_id).toMatch(/^img-/);
    expect(parsed.source_video).toBe(sharedUpload.assetId);
    expect(parsed.status).toBe("enqueued");

    await waitForJob(parsed.job_id);

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
    const result = await client.callTool({
      name: "extract_last_frame",
      arguments: {
        asset_id: sharedUpload.assetId,
        project_slug: "frame-proj",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.image_asset_id).toMatch(/^img-/);
    expect(parsed.source_video).toBe(sharedUpload.assetId);
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

  it("extracts last frame when audio stream is longer than video stream", async () => {
    const skewedPath = join(tempDir, "audio-longer.mp4");
    await generateAudioLongerThanVideo(skewedPath);
    const uploaded = await uploadVideo(client, "frame-proj", skewedPath, "skewed.mp4");

    const result = await client.callTool({
      name: "extract_last_frame",
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
    const jpgFile = manifestData.files.find((f: { name: string }) => f.name === "original.jpg");
    expect(jpgFile).toBeDefined();
    const jpgStat = await stat(join(manifestData.path, "original.jpg"));
    expect(jpgStat.size).toBeGreaterThan(0);
  });

  it("commits original.jpg through fs.writeFile so it's tracked by git", async () => {
    // Regression: extract_frame used to invoke ffmpeg with a destination path
    // inside the asset dir, bypassing fs.writeFile. The file landed on disk
    // (so manifests + UI worked) but git never saw it, breaking the engine's
    // version-history invariant.
    const result = await client.callTool({
      name: "extract_first_frame",
      arguments: {
        asset_id: sharedUpload.assetId,
        project_slug: "frame-proj",
      },
    });

    const parsed = JSON.parse((result.content as TextContent)[0].text);
    await waitForJob(parsed.job_id);

    const projectDir = join(tempDir, "frame-proj");
    const tracked = await execFileAsync("git", [
      "-C", projectDir,
      "ls-files", `${parsed.image_asset_id}/original.jpg`,
    ]);
    expect(tracked.stdout.trim()).toBe(`${parsed.image_asset_id}/original.jpg`);
  });

  it("writes .original.json with correct metadata", async () => {
    const result = await client.callTool({
      name: "extract_first_frame",
      arguments: {
        asset_id: sharedUpload.assetId,
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

    const originJson = JSON.parse(await readFile(join(manifestData.path, ".original.json"), "utf-8"));
    expect(originJson.origin).toBe("first_frame");
    expect(originJson.source_asset).toBe(sharedUpload.assetId);
    expect(originJson.timestamp).toBe(0.1);
    expect(originJson.width).toBe(320);
    expect(originJson.height).toBe(240);
  });
});
