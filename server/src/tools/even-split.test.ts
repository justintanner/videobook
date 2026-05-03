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
  function lengths(D: number): number[] {
    return planEvenSplit(D).map((c) => c.duration);
  }

  it("magic 10s for D=30", () => {
    expect(lengths(30)).toEqual([10, 10, 10]);
  });

  it("magic 10s wins over 15s for D=30", () => {
    // Both fit, but 10 has priority.
    const out = lengths(30);
    expect(out).toEqual([10, 10, 10]);
  });

  it("magic 15s for D=45", () => {
    expect(lengths(45)).toEqual([15, 15, 15]);
  });

  it("equal-ish [9, 9] for D=18", () => {
    expect(lengths(18)).toEqual([9, 9]);
  });

  it("equal-ish [10, 9] for D=19", () => {
    expect(lengths(19)).toEqual([10, 9]);
  });

  it("equal-ish [9, 9, 9, 8] for D=35", () => {
    expect(lengths(35)).toEqual([9, 9, 9, 8]);
  });

  it("absorbs fractional remainder into last chunk for D=35.4", () => {
    const out = lengths(35.4);
    expect(out.slice(0, 3)).toEqual([9, 9, 9]);
    expect(out[3]).toBeCloseTo(8.4, 5);
  });

  it("fallback for D=21", () => {
    expect(lengths(21)).toEqual([7, 7, 7]);
  });

  it("returns single-chunk plan for D=8 (caller decides whether to refuse)", () => {
    expect(lengths(8)).toEqual([8]);
  });

  it("cumulative ranges cover the source exactly", () => {
    for (const D of [30, 45, 18, 19, 35, 35.4, 21, 8]) {
      const chunks = planEvenSplit(D);
      expect(chunks[0].start).toBe(0);
      expect(chunks[chunks.length - 1].end).toBeCloseTo(D, 5);
      for (let i = 1; i < chunks.length; i++) {
        expect(chunks[i].start).toBeCloseTo(chunks[i - 1].end, 5);
      }
    }
  });

  it("returns [] for invalid input", () => {
    expect(planEvenSplit(0)).toEqual([]);
    expect(planEvenSplit(-1)).toEqual([]);
    expect(planEvenSplit(NaN)).toEqual([]);
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

  it("rejects sources already short enough to skip splitting", async () => {
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
    expect(content[0].text).toContain("already short enough");
  }, 60_000);

  it("splits a 30s source into 3 chunks of ~10s each", async () => {
    const videoPath = join(fixtureDir, "thirty-30s.mp4");
    await generateTestVideo(videoPath, 30);
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
    expect(parsed.chunk_count).toBe(3);
    expect(parsed.chunk_asset_ids).toHaveLength(3);
    expect(parsed.chunk_durations).toEqual([10, 10, 10]);

    for (const chunkId of parsed.chunk_asset_ids) {
      const manifest = await client.callTool({
        name: "asset_manifest",
        arguments: { asset_id: chunkId, project_slug: "even-split-proj" },
      });
      const path = join(JSON.parse((manifest.content as TextContent)[0].text).path, "original.mp4");
      const dur = await probeDuration(path);
      // trimRange's safety margin guarantees ≤ requested.
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
