import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createTestClient } from "../test-client.js";
import { queue } from "../queue.js";
import { createFs } from "videobook-engine";
import { FFMPEG, FFPROBE } from "../ffmpeg.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const execFileAsync = promisify(execFile);
type TextContent = Array<{ type: string; text: string }>;

async function probeAudioDuration(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync(FFPROBE, [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    filePath,
  ]);
  const data = JSON.parse(stdout) as {
    streams?: Array<{ codec_type?: string; duration?: string }>;
    format?: { duration?: string };
  };
  const formatDuration = Number(data.format?.duration ?? 0);
  const audioStream = data.streams?.find((s) => s.codec_type === "audio");
  const streamDuration = audioStream ? Number(audioStream.duration ?? formatDuration) : formatDuration;
  return Number.isFinite(streamDuration) && streamDuration > 0 ? streamDuration : formatDuration;
}

async function generateTestMp3(outputPath: string, durationSeconds: number): Promise<void> {
  await execFileAsync(FFMPEG, [
    "-y",
    "-f", "lavfi",
    "-i", `sine=frequency=440:duration=${durationSeconds}`,
    "-c:a", "libmp3lame",
    "-q:a", "2",
    outputPath,
  ]);
}

describe("trim_audio tool", () => {
  let client: Client;
  let tempDir: string;

  beforeAll(async () => {
    await queue.start();
  });

  afterAll(async () => {
    await queue.stop();
  });

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-trim-audio-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "test-proj" },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("returns error for invalid trim params (both trim and cut)", async () => {
    const result = await client.callTool({
      name: "trim_audio",
      arguments: {
        asset_id: "aud-test",
        project_slug: "test-proj",
        trim_start: 1,
        cut_start: 2,
        cut_end: 3,
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("Cannot specify both trim");
  });

  it("returns error for nonexistent asset", async () => {
    const result = await client.callTool({
      name: "trim_audio",
      arguments: {
        asset_id: "aud-does-not-exist",
        project_slug: "test-proj",
        trim_start: 1,
      },
    });

    expect(result.isError).toBe(true);
  });

  it("returns error when asset has no audio file", async () => {
    const fs = createFs({ projectsDir: tempDir });
    const asset = await fs.createAsset("aud", "empty", "test-proj");
    if (!asset.ok) throw new Error("Failed to create asset");
    await fs.writeFile(asset.value.assetId, "notes.txt", "hello", "test-proj");

    const result = await client.callTool({
      name: "trim_audio",
      arguments: {
        asset_id: asset.value.assetId,
        project_slug: "test-proj",
        trim_start: 1,
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("No audio file found");
  });

  it("rejects vid-* assets and directs callers to trim_video", async () => {
    const fs = createFs({ projectsDir: tempDir });
    const asset = await fs.createAsset("vid", "video-clip", "test-proj");
    if (!asset.ok) throw new Error("Failed to create asset");

    const result = await client.callTool({
      name: "trim_audio",
      arguments: {
        asset_id: asset.value.assetId,
        project_slug: "test-proj",
        trim_start: 0.5,
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("requires an aud-* asset");
    expect(content[0].text).toContain("trim_video");
  });

  it("trims real aud-* MP3 in keep mode", async () => {
    const fs = createFs({ projectsDir: tempDir });
    const asset = await fs.createAsset("aud", "music-clip", "test-proj");
    if (!asset.ok) throw new Error("Failed to create asset");

    const genPath = join(tempDir, "temp-sine.mp3");
    await generateTestMp3(genPath, 3.0);
    const audioData = await readFile(genPath);
    await fs.writeFile(asset.value.assetId, "original.mp3", audioData, "test-proj");

    const result = await client.callTool({
      name: "trim_audio",
      arguments: {
        asset_id: asset.value.assetId,
        project_slug: "test-proj",
        trim_start: 0.5,
        trim_end: 2.0,
      },
    });

    if (result.isError) {
      console.log("TOOL ERROR TEXT:", (result.content as TextContent)[0].text);
    }
    expect(result.isError).toBeFalsy();

    const manifestResult = await fs.getManifest(asset.value.assetId, "test-proj");
    expect(manifestResult.ok).toBe(true);
    if (!manifestResult.ok) return;

    const trimmedPath = join(manifestResult.value.path, "original.mp3");
    const duration = await probeAudioDuration(trimmedPath);
    expect(duration).toBeGreaterThan(1.3);
    expect(duration).toBeLessThan(1.7);
    const provenance = await fs.readMetadata<Record<string, unknown>>(
      asset.value.assetId,
      "original",
      "test-proj",
    );
    expect(provenance.ok).toBe(true);
    if (provenance.ok) {
      expect(provenance.value).toMatchObject({
        origin: "trim_audio",
        source_asset_id: asset.value.assetId,
        mode: "keep",
        trim_start: 0.5,
        trim_end: 2,
      });
    }
  });

  it("trims real aud-* MP3 in cut mode", async () => {
    const fs = createFs({ projectsDir: tempDir });
    const asset = await fs.createAsset("aud", "podcast-clip", "test-proj");
    if (!asset.ok) throw new Error("Failed to create asset");

    const genPath = join(tempDir, "temp-sine.mp3");
    await generateTestMp3(genPath, 3.0);
    const audioData = await readFile(genPath);
    await fs.writeFile(asset.value.assetId, "original.mp3", audioData, "test-proj");

    const result = await client.callTool({
      name: "trim_audio",
      arguments: {
        asset_id: asset.value.assetId,
        project_slug: "test-proj",
        cut_start: 1.0,
        cut_end: 2.0,
      },
    });

    expect(result.isError).toBeFalsy();

    const manifestResult = await fs.getManifest(asset.value.assetId, "test-proj");
    expect(manifestResult.ok).toBe(true);
    if (!manifestResult.ok) return;

    const trimmedPath = join(manifestResult.value.path, "original.mp3");
    const duration = await probeAudioDuration(trimmedPath);
    expect(duration).toBeGreaterThan(1.8);
    expect(duration).toBeLessThan(2.3);
  });

  it("leaves the original intact when the requested range exceeds duration", async () => {
    const fs = createFs({ projectsDir: tempDir });
    const asset = await fs.createAsset("aud", "rollback-clip", "test-proj");
    if (!asset.ok) throw new Error("Failed to create asset");

    const genPath = join(tempDir, "temp-sine.mp3");
    await generateTestMp3(genPath, 2.0);
    const originalData = await readFile(genPath);
    await fs.writeFile(asset.value.assetId, "original.mp3", originalData, "test-proj");

    const result = await client.callTool({
      name: "trim_audio",
      arguments: {
        asset_id: asset.value.assetId,
        project_slug: "test-proj",
        trim_start: 0.5,
        trim_end: 8,
      },
    });

    expect(result.isError).toBe(true);
    const restored = await fs.readFile(asset.value.assetId, "original.mp3", "test-proj");
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.value.equals(originalData)).toBe(true);
  });
});
