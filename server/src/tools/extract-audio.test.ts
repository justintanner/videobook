import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "videobook-engine";
import { createEngineForTest } from "../engine.js";
import { createTestClient } from "../test-client.js";
import { queue, waitForJob } from "../queue.js";
import { probeVideo } from "../ffmpeg.js";
import { COMMON_VIDEO_FIXTURES, copyVideoFixture } from "../test-media-fixtures.js";
import type { Client } from "@modelcontextprotocol/client";

type TextContent = Array<{ type: string; text: string }>;

async function generateTestVideo(outputPath: string): Promise<void> {
  await copyVideoFixture(COMMON_VIDEO_FIXTURES.extractAudio, outputPath);
}

async function generateVideoNoAudio(outputPath: string): Promise<void> {
  await copyVideoFixture(COMMON_VIDEO_FIXTURES.extractAudioSilent, outputPath);
}

async function uploadVideo(
  client: Client,
  bookId: string,
  videoPath: string,
): Promise<{ assetId: string; path: string }> {
  const data = (await readFile(videoPath)).toString("base64");
  const result = await client.callTool({
    name: "upload_file",
    arguments: { book_id: bookId, filename: "original.mp4", data },
  });
  return JSON.parse((result.content as TextContent)[0].text);
}

describe("extract_audio tool", () => {
  let client: Client;
  let tempDir: string;
  let videoPath: string;
  let fs: Engine;

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
    fs = createEngineForTest(tempDir);
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "audio-proj" },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("extracts audio as a new audio asset", async () => {
    const uploaded = await uploadVideo(client, "audio-proj", videoPath);

    const result = await client.callTool({
      name: "extract_audio",
      arguments: {
        asset_id: uploaded.assetId,
        book_id: "audio-proj",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    const audioArtifact = fs.artifacts.get(parsed.audio_asset_id);
    expect(audioArtifact.ok && audioArtifact.value.kind).toBe("audio");
    expect(parsed.source_video).toBe(uploaded.assetId);
    expect(parsed.status).toBe("enqueued");

    await waitForJob(parsed.job_id);

    // Verify the audio file exists and is non-empty
    const manifest = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: parsed.audio_asset_id, book_id: "audio-proj" },
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
        book_id: "audio-proj",
      },
    });

    expect(result.isError).toBe(true);
  });

  it("returns error when no video file in asset", async () => {
    const data = Buffer.from("fake-png-data").toString("base64");
    const uploadResult = await client.callTool({
      name: "upload_file",
      arguments: { book_id: "audio-proj", filename: "photo.png", data },
    });
    const uploaded = JSON.parse((uploadResult.content as TextContent)[0].text);

    const result = await client.callTool({
      name: "extract_audio",
      arguments: {
        asset_id: uploaded.assetId,
        book_id: "audio-proj",
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
      arguments: { book_id: "audio-proj", filename: "original.mp4", data },
    });
    const uploaded = JSON.parse((uploadResult.content as TextContent)[0].text);

    const result = await client.callTool({
      name: "extract_audio",
      arguments: {
        asset_id: uploaded.assetId,
        book_id: "audio-proj",
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("no audio stream");
  });

  it("writes native original metadata", async () => {
    const uploaded = await uploadVideo(client, "audio-proj", videoPath);

    const result = await client.callTool({
      name: "extract_audio",
      arguments: {
        asset_id: uploaded.assetId,
        book_id: "audio-proj",
      },
    });

    const parsed = JSON.parse((result.content as TextContent)[0].text);
    await waitForJob(parsed.job_id);

    const origin = await fs.metadata.artifacts.read<{
      origin: string;
      source_asset: string;
      duration: number;
    }>(parsed.audio_asset_id, "original");
    expect(origin.ok && origin.value.origin).toBe("extract_audio");
    expect(origin.ok && origin.value.source_asset).toBe(uploaded.assetId);
    expect(origin.ok && typeof origin.value.duration).toBe("number");
    expect(origin.ok && origin.value.duration).toBeGreaterThan(0);
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
          book_id: "audio-proj",
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
        arguments: { asset_id: uploaded.assetId, book_id: "audio-proj" },
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
          book_id: "audio-proj",
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
          book_id: "audio-proj",
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
          book_id: "audio-proj",
          destination: { asset_id: uploaded.assetId, filename: "s1-range.mp3" },
          range: { start_s: 0.5, duration_s: 0.5 },
        },
      });

      expect(result.isError).toBeFalsy();

      const manifest = await client.callTool({
        name: "asset_manifest",
        arguments: { asset_id: uploaded.assetId, book_id: "audio-proj" },
      });
      const manifestData = JSON.parse((manifest.content as TextContent)[0].text);
      const mp3Path = join(manifestData.path, "s1-range.mp3");

      const duration = (await probeVideo(mp3Path)).duration;
      // mp3 framing slop adds a hair; the range is 0.5s, full source is 2s.
      // Anything under 0.9s confirms the range clip took effect.
      expect(duration).toBeLessThan(0.9);
      expect(duration).toBeGreaterThan(0.3);
    });
  });
});
