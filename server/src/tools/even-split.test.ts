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
import { planEvenSplit } from "./even-split.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const FFMPEG: string = require("ffmpeg-static");

type TextContent = Array<{ type: string; text: string }>;

async function generateTestVideo(outputPath: string, durationSec: number): Promise<void> {
  await execFileAsync(FFMPEG, [
    "-y",
    "-f", "lavfi", "-i", `testsrc=duration=${durationSec}:size=320x240:rate=10`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${durationSec}`,
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

describe("planEvenSplit (pure)", () => {
  it("normal case: D=30, target=10 → first 10s, second 20s", () => {
    const r = planEvenSplit(30, 10);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.first.duration).toBe(10);
    expect(r.second.duration).toBe(20);
    expect(r.usedTarget).toBe(10);
  });

  it("D=20, target=10 → [10, 10]", () => {
    const r = planEvenSplit(20, 10);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.first.duration).toBe(10);
    expect(r.second.duration).toBe(10);
  });

  it("D=10.5, target=10 → exact 10s split, tiny 0.5s tail", () => {
    const r = planEvenSplit(10.5, 10);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.first.duration).toBe(10);
    expect(r.second.duration).toBeCloseTo(0.5, 5);
    expect(r.usedTarget).toBe(10);
  });

  it("D=10.4, target=10 → falls back to 9s (10s would leave a sub-MIN tail)", () => {
    const r = planEvenSplit(10.4, 10);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.first.duration).toBe(9);
    expect(r.second.duration).toBeCloseTo(1.4, 5);
    expect(r.usedTarget).toBe(9);
  });

  it("D=9.5, target=10 → 9s backup, 0.5s tail", () => {
    const r = planEvenSplit(9.5, 10);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.first.duration).toBe(9);
    expect(r.second.duration).toBeCloseTo(0.5, 5);
    expect(r.usedTarget).toBe(9);
  });

  it("D=8, target=10 → error (too short for either)", () => {
    const r = planEvenSplit(8, 10);
    expect(r.ok).toBe(false);
  });

  it("D=20, target=15 → exact 15s + 5s rest", () => {
    const r = planEvenSplit(20, 15);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.first.duration).toBe(15);
    expect(r.second.duration).toBe(5);
  });

  it("default target_sec is 10", () => {
    const r = planEvenSplit(30);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.first.duration).toBe(10);
  });

  it("rejects invalid input", () => {
    expect(planEvenSplit(0, 10).ok).toBe(false);
    expect(planEvenSplit(-1, 10).ok).toBe(false);
    expect(planEvenSplit(NaN, 10).ok).toBe(false);
    expect(planEvenSplit(30, 0).ok).toBe(false);
    expect(planEvenSplit(30, -1).ok).toBe(false);
  });

  it("cumulative ranges cover the whole source", () => {
    for (const [D, target] of [[30, 10], [20, 10], [10.5, 10], [10.4, 10], [9.5, 10], [20, 15]] as const) {
      const r = planEvenSplit(D, target);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.first.start).toBe(0);
      expect(r.second.start).toBeCloseTo(r.first.end, 5);
      expect(r.second.end).toBeCloseTo(D, 5);
    }
  });
});

describe("even_split tool (integration)", () => {
  let client: Client;
  let tempDir: string;
  let fixtureDir: string;

  beforeAll(async () => {
    await queue.start();
    fixtureDir = await mkdtemp(join(tmpdir(), "clipfirst-even-split-fixture-"));
  }, 60_000);

  afterAll(async () => {
    await queue.stop();
    await rm(fixtureDir, { recursive: true, force: true, maxRetries: 3 });
  }, 30_000);

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-even-split-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "even-split-proj" },
    });
  }, 120_000);

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  }, 120_000);

  it("rejects sources too short for any split", async () => {
    const videoPath = join(fixtureDir, "short-4s.mp4");
    await generateTestVideo(videoPath, 4);
    const uploaded = await uploadVideo(client, "even-split-proj", videoPath);

    const result = await client.callTool({
      name: "even_split",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "even-split-proj",
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("too short");
  }, 60_000);

  it("splits a 20s source into [10, 10] with default target", async () => {
    const videoPath = join(fixtureDir, "twenty-20s.mp4");
    await generateTestVideo(videoPath, 20);
    const uploaded = await uploadVideo(client, "even-split-proj", videoPath);

    const result = await client.callTool({
      name: "even_split",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "even-split-proj",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.chunk_a_duration).toBe(10);
    expect(parsed.chunk_b_duration).toBe(10);
    expect(parsed.used_first_chunk_sec).toBe(10);

    // Verify on-disk durations stay at or under the requested cap.
    for (const chunkId of [parsed.chunk_a_asset_id, parsed.chunk_b_asset_id]) {
      const manifest = await client.callTool({
        name: "asset_manifest",
        arguments: { asset_id: chunkId, project_slug: "even-split-proj" },
      });
      const path = join(JSON.parse((manifest.content as TextContent)[0].text).path, "original.mp4");
      const dur = await probeDuration(path);
      expect(dur).toBeLessThanOrEqual(10);
      expect(dur).toBeGreaterThan(9.5);
    }

    // Source asset preserved.
    const sourceManifest = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: uploaded.assetId, project_slug: "even-split-proj" },
    });
    expect(sourceManifest.isError).toBeFalsy();
  }, 120_000);

  it("accepts target_sec as a string with 's' suffix (chat-style)", async () => {
    const videoPath = join(fixtureDir, "twenty-20s-string.mp4");
    await generateTestVideo(videoPath, 20);
    const uploaded = await uploadVideo(client, "even-split-proj", videoPath);

    const result = await client.callTool({
      name: "even_split",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "even-split-proj",
        target_sec: "10s",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.target_sec).toBe(10);
  }, 120_000);

  it("returns error for nonexistent asset", async () => {
    const result = await client.callTool({
      name: "even_split",
      arguments: {
        asset_id: "vid-does-not-exist",
        project_slug: "even-split-proj",
      },
    });

    expect(result.isError).toBe(true);
  });

  it("returns error when no video file in asset", async () => {
    const data = Buffer.from("fake-png-data").toString("base64");
    const uploadResult = await client.callTool({
      name: "upload_file",
      arguments: { project_slug: "even-split-proj", filename: "photo.png", data },
    });
    const uploaded = JSON.parse((uploadResult.content as TextContent)[0].text);

    const result = await client.callTool({
      name: "even_split",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "even-split-proj",
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("No video file");
  });
});
