import { createEngineForTest } from "../fs.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { queue } from "../queue.js";

type TextContent = Array<{ type: string; text: string }>;

describe("clean_video_audio tool", () => {
  let client: Client;
  let tempDir: string;

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
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "clean-audio-proj" },
    });
  });

  afterEach(async () => {
    delete process.env.ELEVENLABS_API_KEY;
    await client.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("requires the ElevenLabs key", async () => {
    const result = await client.callTool({
      name: "clean_video_audio",
      arguments: { asset_id: "vid-test", project_slug: "clean-audio-proj" },
    });

    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("ELEVENLABS_API_KEY");
  });

  it("rejects non-video asset ids", async () => {
    process.env.ELEVENLABS_API_KEY = "test-key";
    const result = await client.callTool({
      name: "clean_video_audio",
      arguments: { asset_id: "aud-test", project_slug: "clean-audio-proj" },
    });

    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("vid-*");
  });

  it("returns a structured error for a missing asset", async () => {
    process.env.ELEVENLABS_API_KEY = "test-key";
    const result = await client.callTool({
      name: "clean_video_audio",
      arguments: { asset_id: "vid-missing", project_slug: "clean-audio-proj" },
    });

    expect(result.isError).toBe(true);
  });

  it("rejects an asset without a video file", async () => {
    process.env.ELEVENLABS_API_KEY = "test-key";
    const fs = createEngineForTest(tempDir);
    const created = await fs.artifacts.create("vid", "no-video", "clean-audio-proj");
    if (!created.ok) throw new Error(created.error.message);
    const written = await fs.files.write(created.value.slug, "notes.txt", "hello", "clean-audio-proj");
    if (!written.ok) throw new Error(written.error.message);

    const result = await client.callTool({
      name: "clean_video_audio",
      arguments: { asset_id: created.value.slug, project_slug: "clean-audio-proj" },
    });

    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("No video file");
  });

  it("enforces music and mix limits in the MCP schema", async () => {
    process.env.ELEVENLABS_API_KEY = "test-key";
    const result = await client.callTool({
      name: "clean_video_audio",
      arguments: {
        asset_id: "vid-test",
        project_slug: "clean-audio-proj",
        source_mix: 0.8,
        music_volume: 0.5,
      },
    });

    expect(result.isError).toBe(true);
  });
});
