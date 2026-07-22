import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { createTestClient } from "../test-client.js";
import { queue, waitForJob } from "../queue.js";
import { probeVideo } from "../ffmpeg.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const FFMPEG: string = require("ffmpeg-static");

type TextContent = Array<{ type: string; text: string }>;

const PROJECT = "e2e-trim-render";

function parse(result: { content: unknown }): Record<string, unknown> {
  return JSON.parse((result.content as TextContent)[0].text);
}

async function fileExists(p: string): Promise<boolean> {
  return stat(p).then((s) => s.isFile(), () => false);
}

async function readJson(p: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(p, "utf-8"));
}

async function generateTestVideo(outputPath: string): Promise<void> {
  await execFileAsync(FFMPEG, [
    "-y",
    "-f", "lavfi", "-i", "testsrc=duration=5:size=320x240:rate=10",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=5",
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
  return parse(result) as unknown as { assetId: string; path: string };
}

async function pollForFile(
  filePath: string,
  timeoutMs = 30_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fileExists(filePath)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${filePath} not found after ${timeoutMs}ms`);
}

async function pollForDuration(
  metaPath: string,
  maxDuration: number,
  timeoutMs = 60_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const meta = await readJson(metaPath);
      if (typeof meta.duration === 'number' && meta.duration <= maxDuration) return;
    } catch { /* file not ready */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Duration in ${metaPath} did not drop below ${maxDuration}s after ${timeoutMs}ms`);
}

describe("trim video in place and re-render e2e", () => {
  let client: Client;
  let tempDir: string;
  let videoPath: string;
  let assetId: string;
  let assetDir: string;

  beforeAll(async () => {
    await queue.start();
    tempDir = await mkdtemp(join(tmpdir(), "videocity-e2e-trim-render-"));
    videoPath = join(tempDir, "test-source.mp4");
    await generateTestVideo(videoPath);
    client = await createTestClient(tempDir);

    // Create project
    const createResult = await client.callTool({
      name: "create_project",
      arguments: { project_slug: PROJECT },
    });
    expect(createResult.isError).toBeFalsy();

    // Upload video
    const uploaded = await uploadVideo(client, PROJECT, videoPath);
    assetId = uploaded.assetId;
    assetDir = join(tempDir, PROJECT, assetId);

    // Wait for process_video job to finish (triggered by upload)
    await pollForFile(join(assetDir, ".original.json"), 60_000);
  });

  afterAll(async () => {
    await client?.close();
    await queue.stop();
    if (tempDir) await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("original video is ~5s before trimming", async () => {
    const probe = await probeVideo(join(assetDir, "original.mp4"));
    expect(probe.duration).toBeGreaterThanOrEqual(4.5);
    expect(probe.duration).toBeLessThanOrEqual(5.5);
  });

  it("trims video in place (keep 1s–3s)", async () => {
    const result = await client.callTool({
      name: "trim_video",
      arguments: {
        asset_id: assetId,
        project_slug: PROJECT,
        trim_start: 1,
        trim_end: 3,
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = parse(result);
    expect(parsed.status).toBe("completed");
    expect(parsed.asset_id).toBe(assetId);

    // process_video runs async after trim — poll until metadata reflects shorter duration
    await pollForDuration(join(assetDir, ".original.json"), 2.5, 60_000);
  });

  it("video file still exists at the same asset path", async () => {
    expect(await fileExists(join(assetDir, "original.mp4"))).toBe(true);
  });

  it("trimmed video duration is ~2s", async () => {
    const probe = await probeVideo(join(assetDir, "original.mp4"));
    expect(probe.duration).toBeGreaterThanOrEqual(1.5);
    expect(probe.duration).toBeLessThanOrEqual(2.5);
  });

  it("metadata reflects new duration", async () => {
    const meta = await readJson(join(assetDir, ".original.json"));
    const duration = meta.duration as number;
    expect(duration).toBeGreaterThanOrEqual(1.5);
    expect(duration).toBeLessThanOrEqual(2.5);
  });

  it("renders the trimmed video", async () => {
    const result = await client.callTool({
      name: "render_video",
      arguments: {
        asset_id: assetId,
        project_slug: PROJECT,
        orientation: "landscape",
        subtitles_enabled: false,
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = parse(result);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.orientations).toEqual(["landscape"]);

    const jobs = parsed.jobs as Array<{ job_id: string; orientation: string }>;
    expect(jobs).toHaveLength(1);

    await waitForJob(jobs[0].job_id);
  });

  it("rendered output exists in asset directory", async () => {
    expect(await fileExists(join(assetDir, "landscape.mp4"))).toBe(true);
  });

  it("rendered video has correct duration (~2s matching trimmed source)", async () => {
    const probe = await probeVideo(join(assetDir, "landscape.mp4"));
    expect(probe.duration).toBeGreaterThanOrEqual(1.5);
    expect(probe.duration).toBeLessThanOrEqual(2.5);
  });
});
