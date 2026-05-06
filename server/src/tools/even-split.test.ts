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
  it("single target, normal case: D=30, [10] → [10, 20]", () => {
    const r = planEvenSplit(30, [10]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.chunks.map((c) => c.duration)).toEqual([10, 20]);
    expect(r.chunks.map((c) => c.exact)).toEqual([true, false]);
    expect(r.usedTargets).toEqual([10]);
    expect(r.hasLeftover).toBe(true);
  });

  it("single target, exact fit: D=20, [10] → [10, 10]", () => {
    const r = planEvenSplit(20, [10]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.chunks.map((c) => c.duration)).toEqual([10, 10]);
    expect(r.hasLeftover).toBe(true);
  });

  it("D=10.5, [10] → exact 10s split, tiny 0.5s tail", () => {
    const r = planEvenSplit(10.5, [10]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.chunks[0].duration).toBe(10);
    expect(r.chunks[1].duration).toBeCloseTo(0.5, 5);
    expect(r.usedTargets).toEqual([10]);
  });

  it("D=10.4, [10] → backup last target to 9 (10s would leave a sub-MIN tail)", () => {
    const r = planEvenSplit(10.4, [10]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.chunks[0].duration).toBe(9);
    expect(r.chunks[1].duration).toBeCloseTo(1.4, 5);
    expect(r.usedTargets).toEqual([9]);
  });

  it("D=9.5, [10] → 9s backup, 0.5s tail", () => {
    const r = planEvenSplit(9.5, [10]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.chunks[0].duration).toBe(9);
    expect(r.chunks[1].duration).toBeCloseTo(0.5, 5);
    expect(r.usedTargets).toEqual([9]);
  });

  it("D=8, [10] → error (sum exceeds source)", () => {
    const r = planEvenSplit(8, [10]);
    expect(r.ok).toBe(false);
  });

  it("default-shaped call: D=30, [10] → first chunk is 10s", () => {
    const r = planEvenSplit(30, [10]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.chunks[0].duration).toBe(10);
  });

  it("rejects invalid input", () => {
    expect(planEvenSplit(0, [10]).ok).toBe(false);
    expect(planEvenSplit(-1, [10]).ok).toBe(false);
    expect(planEvenSplit(NaN, [10]).ok).toBe(false);
    expect(planEvenSplit(30, []).ok).toBe(false);
    expect(planEvenSplit(30, [0]).ok).toBe(false);
    expect(planEvenSplit(30, [-1]).ok).toBe(false);
    expect(planEvenSplit(30, [10, NaN]).ok).toBe(false);
  });

  it("two targets: D=40, [10, 15] → [10, 15, 15]", () => {
    const r = planEvenSplit(40, [10, 15]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.chunks.map((c) => c.duration)).toEqual([10, 15, 15]);
    expect(r.chunks.map((c) => c.exact)).toEqual([true, true, false]);
    expect(r.usedTargets).toEqual([10, 15]);
    expect(r.hasLeftover).toBe(true);
  });

  it("two targets that exhaust source: D=25, [10, 15] → [10, 15], no leftover", () => {
    const r = planEvenSplit(25, [10, 15]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.chunks.map((c) => c.duration)).toEqual([10, 15]);
    expect(r.chunks.map((c) => c.exact)).toEqual([true, true]);
    expect(r.hasLeftover).toBe(false);
  });

  it("two targets, sub-MIN leftover: D=25.4, [10, 15] → backup last → [10, 14] + 1.4s", () => {
    const r = planEvenSplit(25.4, [10, 15]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.chunks[0].duration).toBe(10);
    expect(r.chunks[1].duration).toBe(14);
    expect(r.chunks[2].duration).toBeCloseTo(1.4, 5);
    expect(r.usedTargets).toEqual([10, 14]);
    expect(r.hasLeftover).toBe(true);
  });

  it("two targets, sum exceeds source: D=12, [10, 15] → error", () => {
    const r = planEvenSplit(12, [10, 15]);
    expect(r.ok).toBe(false);
  });

  it("7s default-style target: D=14, [7] → [7, 7]", () => {
    const r = planEvenSplit(14, [7]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.chunks.map((c) => c.duration)).toEqual([7, 7]);
    expect(r.chunks.map((c) => c.exact)).toEqual([true, false]);
    expect(r.usedTargets).toEqual([7]);
    expect(r.hasLeftover).toBe(true);
  });

  it("7s per-scene plan-vis pattern: D=21, [7, 7, 7] → [7, 7, 7], no leftover", () => {
    const r = planEvenSplit(21, [7, 7, 7]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.chunks.map((c) => c.duration)).toEqual([7, 7, 7]);
    expect(r.chunks.map((c) => c.exact)).toEqual([true, true, true]);
    expect(r.hasLeftover).toBe(false);
  });

  it("7s with short trailing scene: D=17, [7, 7, 3] → [7, 7, 3], no leftover", () => {
    const r = planEvenSplit(17, [7, 7, 3]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.chunks.map((c) => c.duration)).toEqual([7, 7, 3]);
    expect(r.hasLeftover).toBe(false);
  });

  it("three targets: D=35, [10, 10, 10] → [10, 10, 10, 5]", () => {
    const r = planEvenSplit(35, [10, 10, 10]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.chunks.map((c) => c.duration)).toEqual([10, 10, 10, 5]);
    expect(r.chunks.map((c) => c.exact)).toEqual([true, true, true, false]);
  });

  it("cumulative ranges cover the whole source", () => {
    const cases: Array<[number, number[]]> = [
      [30, [10]],
      [20, [10]],
      [10.5, [10]],
      [10.4, [10]],
      [9.5, [10]],
      [40, [10, 15]],
      [25, [10, 15]],
      [25.4, [10, 15]],
      [35, [10, 10, 10]],
    ];
    for (const [D, targets] of cases) {
      const r = planEvenSplit(D, targets);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.chunks[0].start).toBe(0);
      for (let i = 1; i < r.chunks.length; i++) {
        expect(r.chunks[i].start).toBeCloseTo(r.chunks[i - 1].end, 5);
      }
      expect(r.chunks[r.chunks.length - 1].end).toBeCloseTo(D, 5);
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
    const videoPath = join(fixtureDir, "short-2s.mp4");
    // Default target is 7s; a 2s source can't be split with the [7] backup
    // (last - 1 = 6 still > 2). Sub-default-and-sub-backup → error path.
    await generateTestVideo(videoPath, 2);
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

  it("splits a 14s source into [7, 7] with default target", async () => {
    const videoPath = join(fixtureDir, "fourteen-14s.mp4");
    await generateTestVideo(videoPath, 14);
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
    expect(parsed.chunks).toHaveLength(2);
    expect(parsed.chunks[0].duration).toBe(7);
    expect(parsed.chunks[1].duration).toBe(7);
    expect(parsed.used_target_secs).toEqual([7]);
    expect(parsed.has_leftover).toBe(true);

    // Verify on-disk durations stay at or under the requested cap.
    for (const chunk of parsed.chunks) {
      const manifest = await client.callTool({
        name: "asset_manifest",
        arguments: { asset_id: chunk.asset_id, project_slug: "even-split-proj" },
      });
      const path = join(JSON.parse((manifest.content as TextContent)[0].text).path, "original.mp4");
      const dur = await probeDuration(path);
      expect(dur).toBeLessThanOrEqual(7);
      expect(dur).toBeGreaterThan(6.5);
    }

    // Source asset preserved.
    const sourceManifest = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: uploaded.assetId, project_slug: "even-split-proj" },
    });
    expect(sourceManifest.isError).toBeFalsy();
  }, 120_000);

  it("splits a 21s source into [7, 7, 7] with explicit per-scene targets", async () => {
    const videoPath = join(fixtureDir, "twenty-one-21s.mp4");
    await generateTestVideo(videoPath, 21);
    const uploaded = await uploadVideo(client, "even-split-proj", videoPath);

    const result = await client.callTool({
      name: "even_split",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "even-split-proj",
        target_secs: [7, 7, 7],
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.chunks).toHaveLength(3);
    expect(parsed.chunks.map((c: { duration: number }) => c.duration)).toEqual([7, 7, 7]);
    expect(parsed.has_leftover).toBe(false);

    for (const chunk of parsed.chunks) {
      const manifest = await client.callTool({
        name: "asset_manifest",
        arguments: { asset_id: chunk.asset_id, project_slug: "even-split-proj" },
      });
      const path = join(JSON.parse((manifest.content as TextContent)[0].text).path, "original.mp4");
      const dur = await probeDuration(path);
      expect(dur).toBeLessThanOrEqual(7);
      expect(dur).toBeGreaterThan(6.5);
    }
  }, 180_000);

  it("accepts target_secs as strings with 's' suffix (chat-style)", async () => {
    const videoPath = join(fixtureDir, "twenty-20s-string.mp4");
    await generateTestVideo(videoPath, 20);
    const uploaded = await uploadVideo(client, "even-split-proj", videoPath);

    const result = await client.callTool({
      name: "even_split",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "even-split-proj",
        target_secs: ["10s"],
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.used_target_secs).toEqual([10]);
  }, 120_000);

  it("splits a 30s source with two targets [10, 15] into 3 chunks", async () => {
    const videoPath = join(fixtureDir, "thirty-30s-multi.mp4");
    await generateTestVideo(videoPath, 30);
    const uploaded = await uploadVideo(client, "even-split-proj", videoPath);

    const result = await client.callTool({
      name: "even_split",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "even-split-proj",
        target_secs: ["10", "15"],
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.chunks).toHaveLength(3);
    expect(parsed.chunks[0].duration).toBe(10);
    expect(parsed.chunks[1].duration).toBe(15);
    expect(parsed.chunks[2].duration).toBeCloseTo(5, 1);
    expect(parsed.chunks[0].exact).toBe(true);
    expect(parsed.chunks[1].exact).toBe(true);
    expect(parsed.chunks[2].exact).toBe(false);
    expect(parsed.used_target_secs).toEqual([10, 15]);
    expect(parsed.has_leftover).toBe(true);

    const expectedDurations = [10, 15, 5];
    for (let i = 0; i < parsed.chunks.length; i++) {
      const chunk = parsed.chunks[i];
      const manifest = await client.callTool({
        name: "asset_manifest",
        arguments: { asset_id: chunk.asset_id, project_slug: "even-split-proj" },
      });
      const path = join(JSON.parse((manifest.content as TextContent)[0].text).path, "original.mp4");
      const dur = await probeDuration(path);
      expect(dur).toBeLessThanOrEqual(expectedDurations[i] + 0.05);
      expect(dur).toBeGreaterThan(expectedDurations[i] - 0.5);
    }
  }, 180_000);

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

  describe("destination mode", () => {
    it("writes chunks as sibling files inside an existing asset", async () => {
      const videoPath = join(fixtureDir, "dest-21s.mp4");
      await generateTestVideo(videoPath, 21);
      const source = await uploadVideo(client, "even-split-proj", videoPath);
      // Use a second uploaded asset as destination — `original.mp4` won't
      // collide with `s1.mp4` / `s2.mp4` / `s3.mp4`.
      const destVideoPath = join(fixtureDir, "dest-empty-3s.mp4");
      await generateTestVideo(destVideoPath, 3);
      const dest = await uploadVideo(client, "even-split-proj", destVideoPath);

      const result = await client.callTool({
        name: "even_split",
        arguments: {
          asset_id: source.assetId,
          project_slug: "even-split-proj",
          target_secs: [7, 7, 7],
          destination: { asset_id: dest.assetId, filenames: ["s1.mp4", "s2.mp4", "s3.mp4"] },
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as TextContent)[0].text);
      expect(parsed.destination.asset_id).toBe(dest.assetId);
      expect(parsed.destination.filenames).toEqual(["s1.mp4", "s2.mp4", "s3.mp4"]);
      expect(parsed.chunks).toBeUndefined();

      const manifest = await client.callTool({
        name: "asset_manifest",
        arguments: { asset_id: dest.assetId, project_slug: "even-split-proj" },
      });
      const data = JSON.parse((manifest.content as TextContent)[0].text);
      const names = new Set((data.files as Array<{ name: string }>).map((f) => f.name));
      expect(names.has("s1.mp4")).toBe(true);
      expect(names.has("s2.mp4")).toBe(true);
      expect(names.has("s3.mp4")).toBe(true);
      expect(names.has("original.mp4")).toBe(true); // pre-existing untouched

      for (const name of ["s1.mp4", "s2.mp4", "s3.mp4"]) {
        const dur = await probeDuration(join(data.path, name));
        expect(dur).toBeLessThanOrEqual(7.05);
        expect(dur).toBeGreaterThan(6.5);
      }
    }, 180_000);

    it("rejects filenames length mismatch with target_secs", async () => {
      const videoPath = join(fixtureDir, "dest-mismatch-21s.mp4");
      await generateTestVideo(videoPath, 21);
      const source = await uploadVideo(client, "even-split-proj", videoPath);
      const destVideoPath = join(fixtureDir, "dest-mismatch-empty-3s.mp4");
      await generateTestVideo(destVideoPath, 3);
      const dest = await uploadVideo(client, "even-split-proj", destVideoPath);

      const result = await client.callTool({
        name: "even_split",
        arguments: {
          asset_id: source.assetId,
          project_slug: "even-split-proj",
          target_secs: [7, 7, 7],
          destination: { asset_id: dest.assetId, filenames: ["s1.mp4", "s2.mp4"] },
        },
      });

      expect(result.isError).toBe(true);
      expect((result.content as TextContent)[0].text).toContain("must equal target_secs length");
    }, 60_000);

    it("rejects when a destination filename already exists", async () => {
      const videoPath = join(fixtureDir, "dest-collide-14s.mp4");
      await generateTestVideo(videoPath, 14);
      const source = await uploadVideo(client, "even-split-proj", videoPath);
      const destVideoPath = join(fixtureDir, "dest-collide-empty-3s.mp4");
      await generateTestVideo(destVideoPath, 3);
      const dest = await uploadVideo(client, "even-split-proj", destVideoPath);

      // dest already has `original.mp4`; pick that as a collision filename.
      const result = await client.callTool({
        name: "even_split",
        arguments: {
          asset_id: source.assetId,
          project_slug: "even-split-proj",
          target_secs: [7, 7],
          destination: { asset_id: dest.assetId, filenames: ["s1.mp4", "original.mp4"] },
        },
      });

      expect(result.isError).toBe(true);
      expect((result.content as TextContent)[0].text).toContain("Refusing silent overwrite");
    }, 60_000);

    it("rejects when destination asset does not exist", async () => {
      const videoPath = join(fixtureDir, "dest-missing-14s.mp4");
      await generateTestVideo(videoPath, 14);
      const source = await uploadVideo(client, "even-split-proj", videoPath);

      const result = await client.callTool({
        name: "even_split",
        arguments: {
          asset_id: source.assetId,
          project_slug: "even-split-proj",
          target_secs: [7, 7],
          destination: { asset_id: "vid-does-not-exist", filenames: ["s1.mp4", "s2.mp4"] },
        },
      });

      expect(result.isError).toBe(true);
      expect((result.content as TextContent)[0].text).toContain("not found");
    }, 60_000);
  });
});
