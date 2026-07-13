import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll } from "vitest";
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
    "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=10",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest",
    outputPath,
  ]);
}

async function generateVideoNoAudio(outputPath: string): Promise<void> {
  await execFileAsync(FFMPEG, [
    "-y",
    "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=10",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-an",
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

describe("extract_audio tool", () => {
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
    tempDir = await mkdtemp(join(tmpdir(), "videocity-extract-audio-test-"));
    videoPath = join(tempDir, "test-source.mp4");
    await generateTestVideo(videoPath);
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "audio-proj" },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("extracts audio as a new aud- asset", async () => {
    const uploaded = await uploadVideo(client, "audio-proj", videoPath);

    const result = await client.callTool({
      name: "extract_audio",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "audio-proj",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.audio_asset_id).toMatch(/^aud-/);
    expect(parsed.source_video).toBe(uploaded.assetId);
    expect(parsed.status).toBe("enqueued");

    await waitForJob(parsed.job_id);

    // Verify the audio file exists and is non-empty
    const manifest = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: parsed.audio_asset_id, project_slug: "audio-proj" },
    });
    const manifestData = JSON.parse((manifest.content as TextContent)[0].text);
    const mp3File = manifestData.files.find((f: { name: string }) => f.name === "original.mp3");
    expect(mp3File).toBeDefined();

    const mp3Stat = await stat(join(manifestData.path, "original.mp3"));
    expect(mp3Stat.size).toBeGreaterThan(0);
  });

  it("returns error for nonexistent asset", async () => {
    const result = await client.callTool({
      name: "extract_audio",
      arguments: {
        asset_id: "vid-does-not-exist",
        project_slug: "audio-proj",
      },
    });

    expect(result.isError).toBe(true);
  });

  it("returns error when no video file in asset", async () => {
    const data = Buffer.from("fake-png-data").toString("base64");
    const uploadResult = await client.callTool({
      name: "upload_file",
      arguments: { project_slug: "audio-proj", filename: "photo.png", data },
    });
    const uploaded = JSON.parse((uploadResult.content as TextContent)[0].text);

    const result = await client.callTool({
      name: "extract_audio",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "audio-proj",
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("No video file");
  });

  it("returns error when video has no audio stream", async () => {
    const noAudioPath = join(tempDir, "no-audio.mp4");
    await generateVideoNoAudio(noAudioPath);

    const data = (await readFile(noAudioPath)).toString("base64");
    const uploadResult = await client.callTool({
      name: "upload_file",
      arguments: { project_slug: "audio-proj", filename: "original.mp4", data },
    });
    const uploaded = JSON.parse((uploadResult.content as TextContent)[0].text);

    const result = await client.callTool({
      name: "extract_audio",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "audio-proj",
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("no audio stream");
  });

  it("writes .original.json with correct metadata", async () => {
    const uploaded = await uploadVideo(client, "audio-proj", videoPath);

    const result = await client.callTool({
      name: "extract_audio",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "audio-proj",
      },
    });

    const parsed = JSON.parse((result.content as TextContent)[0].text);
    await waitForJob(parsed.job_id);

    const manifest = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: parsed.audio_asset_id, project_slug: "audio-proj" },
    });
    const manifestData = JSON.parse((manifest.content as TextContent)[0].text);

    const originJson = JSON.parse(await readFile(join(manifestData.path, ".original.json"), "utf-8"));
    expect(originJson.origin).toBe("extract_audio");
    expect(originJson.source_asset).toBe(uploaded.assetId);
    expect(typeof originJson.duration).toBe("number");
    expect(originJson.duration).toBeGreaterThan(0);
  });

  describe("destination mode", () => {
    it("writes mp3 as a sibling file inside an existing asset", async () => {
      const uploaded = await uploadVideo(client, "audio-proj", videoPath);
      // Use the source asset itself as destination — `original.mp4` is a
      // pre-existing file; the new sibling `s1.mp3` won't collide.
      const result = await client.callTool({
        name: "extract_audio",
        arguments: {
          asset_id: uploaded.assetId,
          project_slug: "audio-proj",
          destination: { asset_id: uploaded.assetId, filename: "s1.mp3" },
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as TextContent)[0].text);
      expect(parsed.status).toBe("completed");
      expect(parsed.destination.asset_id).toBe(uploaded.assetId);
      expect(parsed.destination.filename).toBe("s1.mp3");
      expect(parsed.audio_asset_id).toBeUndefined();

      const manifest = await client.callTool({
        name: "asset_manifest",
        arguments: { asset_id: uploaded.assetId, project_slug: "audio-proj" },
      });
      const manifestData = JSON.parse((manifest.content as TextContent)[0].text);
      const mp3 = (manifestData.files as Array<{ name: string }>).find((f) => f.name === "s1.mp3");
      expect(mp3).toBeDefined();
      const mp3Stat = await stat(join(manifestData.path, "s1.mp3"));
      expect(mp3Stat.size).toBeGreaterThan(0);
    });

    it("rejects when destination filename already exists", async () => {
      const uploaded = await uploadVideo(client, "audio-proj", videoPath);
      const result = await client.callTool({
        name: "extract_audio",
        arguments: {
          asset_id: uploaded.assetId,
          project_slug: "audio-proj",
          destination: { asset_id: uploaded.assetId, filename: "original.mp4" },
        },
      });

      expect(result.isError).toBe(true);
      expect((result.content as TextContent)[0].text).toContain("Refusing silent overwrite");
    });

    it("rejects when destination asset does not exist", async () => {
      const uploaded = await uploadVideo(client, "audio-proj", videoPath);
      const result = await client.callTool({
        name: "extract_audio",
        arguments: {
          asset_id: uploaded.assetId,
          project_slug: "audio-proj",
          destination: { asset_id: "vid-does-not-exist", filename: "s1.mp3" },
        },
      });

      expect(result.isError).toBe(true);
      expect((result.content as TextContent)[0].text).toContain("not found");
    });

    it("clips to range when provided so per-scene mp3s stay short", async () => {
      // generateTestVideo produces a 2s source. Clip the middle 0.5s and
      // verify the resulting mp3 reflects that, not the full source length.
      const uploaded = await uploadVideo(client, "audio-proj", videoPath);
      const result = await client.callTool({
        name: "extract_audio",
        arguments: {
          asset_id: uploaded.assetId,
          project_slug: "audio-proj",
          destination: { asset_id: uploaded.assetId, filename: "s1-range.mp3" },
          range: { start_s: 0.5, duration_s: 0.5 },
        },
      });

      expect(result.isError).toBeFalsy();

      const manifest = await client.callTool({
        name: "asset_manifest",
        arguments: { asset_id: uploaded.assetId, project_slug: "audio-proj" },
      });
      const manifestData = JSON.parse((manifest.content as TextContent)[0].text);
      const mp3Path = join(manifestData.path, "s1-range.mp3");

      const FFPROBE: string = require("ffprobe-static").path;
      const { stdout } = await execFileAsync(FFPROBE, [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=nw=1:nk=1",
        mp3Path,
      ]);
      const duration = Number(stdout.trim());
      // mp3 framing slop adds a hair; the range is 0.5s, full source is 2s.
      // Anything under 0.9s confirms the range clip took effect.
      expect(duration).toBeLessThan(0.9);
      expect(duration).toBeGreaterThan(0.3);
    });
  });
});
