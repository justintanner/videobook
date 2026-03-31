import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { createTestClient } from "../test-client.js";
import { createFsForTest } from "../fs.js";
import { queue } from "../queue.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const FFMPEG: string = require("ffmpeg-static");

type TextContent = Array<{ type: string; text: string }>;

async function generateTestVideo(outputPath: string, width = 1920, height = 1080): Promise<void> {
  await execFileAsync(FFMPEG, [
    "-y",
    "-f", "lavfi", "-i", `testsrc=duration=1:size=${width}x${height}:rate=10`,
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast",
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

describe("render_timeline tool", () => {
  let client: Client;
  let tempDir: string;
  let videoPath: string;

  beforeAll(async () => {
    await queue.start();
  });

  afterAll(async () => {
    await queue.stop();
  }, 30_000);

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-render-timeline-test-"));
    videoPath = join(tempDir, "test-source.mp4");
    await generateTestVideo(videoPath);
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "timeline-proj" },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("returns error when timeline has no assets", async () => {
    const result = await client.callTool({
      name: "render_timeline",
      arguments: {
        project_slug: "timeline-proj",
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("no slots");
  });

  it("returns error when timeline has no slots with assets", async () => {
    const fs = createFsForTest(tempDir);
    // Write an empty slots array as timeline data (render_timeline expects an array)
    await fs.writeProjectMeta("timeline", [{ slug: "" }, { slug: "" }], "timeline-proj");

    const result = await client.callTool({
      name: "render_timeline",
      arguments: {
        project_slug: "timeline-proj",
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("no slots");
  });

  it("returns error when slot references nonexistent asset", async () => {
    const fs = createFsForTest(tempDir);
    await fs.writeProjectMeta(
      "timeline",
      [{ slug: "vid-nonexistent" }],
      "timeline-proj",
    );

    const result = await client.callTool({
      name: "render_timeline",
      arguments: {
        project_slug: "timeline-proj",
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("vid-nonexistent");
    expect(content[0].text).toContain("not found");
  });

  it("returns error when slot asset is missing rendered file", async () => {
    // Upload a video to create a real asset (it won't have the rendered mp4)
    const uploaded = await uploadVideo(client, "timeline-proj", videoPath);

    const fs = createFsForTest(tempDir);
    await fs.writeProjectMeta(
      "timeline",
      [{ slug: uploaded.assetId }],
      "timeline-proj",
    );

    const result = await client.callTool({
      name: "render_timeline",
      arguments: {
        project_slug: "timeline-proj",
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("missing");
    expect(content[0].text).toContain("landscape.mp4");
  });

  it("enqueues job when rendered files exist", async () => {
    // Upload a video to create a real asset
    const uploaded = await uploadVideo(client, "timeline-proj", videoPath);

    // Copy the test video as the rendered landscape file in the asset dir
    const renderedPath = join(uploaded.path, "landscape.mp4");
    await copyFile(videoPath, renderedPath);

    const fs = createFsForTest(tempDir);
    await fs.writeProjectMeta(
      "timeline",
      [{ slug: uploaded.assetId }],
      "timeline-proj",
    );

    const result = await client.callTool({
      name: "render_timeline",
      arguments: {
        project_slug: "timeline-proj",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.job_id).toMatch(/^render-timeline-/);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.slot_count).toBe(1);
    expect(parsed.orientation).toBe("landscape");
  });
});
