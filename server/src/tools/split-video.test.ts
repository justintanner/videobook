import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
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
  await execFileAsync(FFMPEG, [
    "-y",
    "-f", "lavfi", "-i", "testsrc=duration=4:size=320x240:rate=10",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
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

async function probeDuration(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync(FFPROBE, [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);
  return Number(stdout.trim());
}

describe("split_video tool", () => {
  let client: Client;
  let tempDir: string;
  let fixtureDir: string;
  let videoPath: string;

  beforeAll(async () => {
    await queue.start();
    fixtureDir = await mkdtemp(join(tmpdir(), "clipfirst-split-fixture-"));
    videoPath = join(fixtureDir, "test-source.mp4");
    await generateTestVideo(videoPath);
  }, 60_000);

  afterAll(async () => {
    await queue.stop();
    await rm(fixtureDir, { recursive: true, force: true, maxRetries: 3 });
  }, 30_000);

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-split-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "split-proj" },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("clean split (no overlap) produces two chunks summing to the source duration", async () => {
    const uploaded = await uploadVideo(client, "split-proj", videoPath);

    const result = await client.callTool({
      name: "split_video",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "split-proj",
        chunk_a_end: 1.5,
        chunk_b_start: 1.5,
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.source_asset_id).toBe(uploaded.assetId);
    expect(parsed.chunk_a_asset_id).toMatch(/^vid-/);
    expect(parsed.chunk_b_asset_id).toMatch(/^vid-/);
    expect(parsed.chunk_a_asset_id).not.toBe(parsed.chunk_b_asset_id);
    expect(parsed.overlap_sec).toBe(0);

    const manifestA = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: parsed.chunk_a_asset_id, project_slug: "split-proj" },
    });
    const manifestB = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: parsed.chunk_b_asset_id, project_slug: "split-proj" },
    });
    const aPath = join(JSON.parse((manifestA.content as TextContent)[0].text).path, "original.mp4");
    const bPath = join(JSON.parse((manifestB.content as TextContent)[0].text).path, "original.mp4");

    const durA = await probeDuration(aPath);
    const durB = await probeDuration(bPath);
    // Chunk A's actual duration must be ≤ the requested cut point. ffmpeg's
    // boundary alignment normally overshoots by 10–50ms; trimRange's safety
    // margin ensures the output stays under any downstream duration cap.
    expect(durA).toBeGreaterThan(1.0);
    expect(durA).toBeLessThanOrEqual(1.5);
    expect(durB).toBeGreaterThan(2.0);
    expect(durB).toBeLessThan(3.0);
    expect(durA + durB).toBeGreaterThan(3.0);
    expect(durA + durB).toBeLessThan(4.5);

    // Source asset should still exist.
    const sourceManifest = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: uploaded.assetId, project_slug: "split-proj" },
    });
    expect(sourceManifest.isError).toBeFalsy();
  }, 60_000);

  it("overlap split produces two chunks with combined duration > source", async () => {
    const uploaded = await uploadVideo(client, "split-proj", videoPath);

    const result = await client.callTool({
      name: "split_video",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "split-proj",
        chunk_a_end: 2.5,
        chunk_b_start: 1.5,
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.overlap_sec).toBeCloseTo(1.0, 5);

    const manifestA = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: parsed.chunk_a_asset_id, project_slug: "split-proj" },
    });
    const manifestB = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: parsed.chunk_b_asset_id, project_slug: "split-proj" },
    });
    const aPath = join(JSON.parse((manifestA.content as TextContent)[0].text).path, "original.mp4");
    const bPath = join(JSON.parse((manifestB.content as TextContent)[0].text).path, "original.mp4");

    const durA = await probeDuration(aPath);
    const durB = await probeDuration(bPath);
    expect(durA).toBeGreaterThan(2.0);
    expect(durA).toBeLessThan(3.0);
    expect(durB).toBeGreaterThan(2.0);
    expect(durB).toBeLessThan(3.0);
    // 1s overlap means combined > source.
    expect(durA + durB).toBeGreaterThan(4.5);
  }, 60_000);

  it("rejects splits that produce a chunk under 0.5s", async () => {
    const uploaded = await uploadVideo(client, "split-proj", videoPath);

    // Source is 4s; splitting at 3.9s would leave chunk B = 0.1s (< MIN_CHUNK_SEC).
    const result = await client.callTool({
      name: "split_video",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "split-proj",
        chunk_a_end: 3.9,
        chunk_b_start: 3.9,
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("too short");
  });

  it("rejects chunk_a_end past source duration", async () => {
    const uploaded = await uploadVideo(client, "split-proj", videoPath);

    const result = await client.callTool({
      name: "split_video",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "split-proj",
        chunk_a_end: 99,
        chunk_b_start: 99,
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("exceeds source duration");
  });

  it("rejects gap (chunk_b_start > chunk_a_end)", async () => {
    const uploaded = await uploadVideo(client, "split-proj", videoPath);

    const result = await client.callTool({
      name: "split_video",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "split-proj",
        chunk_a_end: 1.0,
        chunk_b_start: 2.0,
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("Gaps are not supported");
  });

  it("returns error for nonexistent asset", async () => {
    const result = await client.callTool({
      name: "split_video",
      arguments: {
        asset_id: "vid-does-not-exist",
        project_slug: "split-proj",
        chunk_a_end: 1.0,
        chunk_b_start: 1.0,
      },
    });

    expect(result.isError).toBe(true);
  });

  it("returns error when no video file in asset", async () => {
    const data = Buffer.from("fake-png-data").toString("base64");
    const uploadResult = await client.callTool({
      name: "upload_file",
      arguments: { project_slug: "split-proj", filename: "photo.png", data },
    });
    const uploaded = JSON.parse((uploadResult.content as TextContent)[0].text);

    const result = await client.callTool({
      name: "split_video",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "split-proj",
        chunk_a_end: 1.0,
        chunk_b_start: 1.0,
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("No video file");
  });
});
