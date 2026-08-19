import { createEngineForTest } from "../engine.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/client";
import type { ArtifactKind, Engine } from "videobook-engine";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { queue } from "../queue.js";

type TextContent = Array<{ type: string; text: string }>;

describe("clean_video_audio tool", () => {
  let client: Client;
  let tempDir: string;
  let fs: Engine;

  async function createArtifact(kind: ArtifactKind, label: string): Promise<string> {
    const created = await fs.artifacts.create({ kind, label });
    if (!created.ok) throw new Error(created.error.message);
    return created.value.artifactId;
  }

  beforeAll(async () => {
    await queue.start();
  });

  afterAll(async () => {
    await queue.stop();
  });

  beforeEach(async () => {
    delete process.env.ELEVENLABS_API_KEY;
    tempDir = await mkdtemp(join(tmpdir(), "videocity-clean-video-audio-test-"));
    client = await createTestClient(tempDir);
    fs = createEngineForTest(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "clean-audio-proj" },
    });
  });

  afterEach(async () => {
    delete process.env.ELEVENLABS_API_KEY;
    await client.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("requires the ElevenLabs key", async () => {
    const assetId = await createArtifact("video", "needs-key");
    const result = await client.callTool({
      name: "clean_video_audio",
      arguments: { asset_id: assetId, book_id: "clean-audio-proj" },
    });

    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("ELEVENLABS_API_KEY");
  });

  it("rejects artifacts that are not video", async () => {
    process.env.ELEVENLABS_API_KEY = "test-key";
    const assetId = await createArtifact("audio", "not-a-video");
    const result = await client.callTool({
      name: "clean_video_audio",
      arguments: { asset_id: assetId, book_id: "clean-audio-proj" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as TextContent)[0].text;
    expect(text).toContain("requires video media");
    expect(text).toContain(assetId);
  });

  it("returns a structured error for a missing asset", async () => {
    process.env.ELEVENLABS_API_KEY = "test-key";
    const result = await client.callTool({
      name: "clean_video_audio",
      arguments: {
        asset_id: "019fcc6b-46ed-71ce-8f32-2b79cc4dfbbf",
        book_id: "clean-audio-proj",
      },
    });

    expect(result.isError).toBe(true);
  });

  it("rejects an asset without a video file", async () => {
    process.env.ELEVENLABS_API_KEY = "test-key";
    const assetId = await createArtifact("video", "no-video");
    const written = await fs.files.write(assetId, "notes.txt", "hello");
    if (!written.ok) throw new Error(written.error.message);

    const result = await client.callTool({
      name: "clean_video_audio",
      arguments: { asset_id: assetId, book_id: "clean-audio-proj" },
    });

    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("No video file");
  });

  it("enforces music and mix limits in the MCP schema", async () => {
    process.env.ELEVENLABS_API_KEY = "test-key";
    const assetId = await createArtifact("video", "schema-limits");
    const result = await client.callTool({
      name: "clean_video_audio",
      arguments: {
        asset_id: assetId,
        book_id: "clean-audio-proj",
        source_mix: 0.8,
        music_volume: 0.5,
      },
    });

    expect(result.isError).toBe(true);
  });
});
