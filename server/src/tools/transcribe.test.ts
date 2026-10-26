import { createEngineForTest } from "../engine.js";
import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { queue } from "../queue.js";
import type { Client } from "@modelcontextprotocol/client";
import { testBudget } from "../test-budget.js";

type TextContent = Array<{ type: string; text: string }>;

describe("transcribe tool", () => {
  let client: Client;
  let tempDir: string;
  const originalKey = process.env.ELEVENLABS_API_KEY;
  const originalOpenAiKey = process.env.OPENAI_API_KEY;

  beforeAll(async () => {
    await queue.start();
  });

  afterAll(async () => {
    await queue.stop();
  });

  beforeEach(async () => {
    delete process.env.ELEVENLABS_API_KEY;
    delete process.env.OPENAI_API_KEY;
    tempDir = await mkdtemp(join(tmpdir(), "videocity-transcribe-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "test-proj" },
    });
  });

  afterEach(async () => {
    if (originalKey) {
      process.env.ELEVENLABS_API_KEY = originalKey;
    } else {
      delete process.env.ELEVENLABS_API_KEY;
    }
    if (originalOpenAiKey) {
      process.env.OPENAI_API_KEY = originalOpenAiKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("returns error when no speech-to-text provider key is set", async () => {
    const result = await client.callTool({
      name: "transcribe",
      arguments: {
        asset_id: "vid-test",
        book_id: "test-proj",
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("neither is set");
  });

  it("falls back to OpenAI speech-to-text for a video without an audio track file", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    const fs = createEngineForTest(tempDir);
    const asset = await fs.artifacts.create("video", "no-audio-sidecar");
    if (!asset.ok) throw new Error("Failed to create asset");

    await fs.files.write(asset.value.artifactId, "original.mp4", Buffer.from("fake-mp4"));

    const result = await client.callTool({
      name: "transcribe",
      arguments: {
        asset_id: asset.value.artifactId,
        book_id: "test-proj",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.provider).toBe("openai");
    expect(parsed.status).toBe("queued");
  });

  it("returns error for nonexistent asset", async () => {
    process.env.ELEVENLABS_API_KEY = "test-key";

    const result = await client.callTool({
      name: "transcribe",
      arguments: {
        asset_id: "vid-does-not-exist",
        book_id: "test-proj",
      },
    });

    expect(result.isError).toBe(true);
  });

  it("returns error when aud- asset has no audio file", async () => {
    process.env.ELEVENLABS_API_KEY = "test-key";

    const fs = createEngineForTest(tempDir);
    const asset = await fs.artifacts.create("aud", "silent");
    if (!asset.ok) throw new Error("Failed to create asset");

    // Write a non-audio file so the asset exists but has no audio
    await fs.files.write(asset.value.artifactId, "notes.txt", "hello");

    const result = await client.callTool({
      name: "transcribe",
      arguments: {
        asset_id: asset.value.artifactId,
        book_id: "test-proj",
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("No audio file");
  });

  it("enqueues job with valid aud- asset containing audio", async () => {
    process.env.ELEVENLABS_API_KEY = "test-key";

    const fs = createEngineForTest(tempDir);
    const asset = await fs.artifacts.create("aud", "podcast");
    if (!asset.ok) throw new Error("Failed to create asset");

    await fs.files.write(asset.value.artifactId, "original.mp3", Buffer.from("fake-mp3"));

    const result = await client.callTool({
      name: "transcribe",
      arguments: {
        asset_id: asset.value.artifactId,
        book_id: "test-proj",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("queued");
    expect(parsed.asset_id).toBe(asset.value.artifactId);
    expect(parsed.job_id).toBeDefined();
  });

  it("wait: true surfaces the job failure as a tool error", async () => {
    // "test-key" matches the placeholder pattern, so the job's requireApiKey
    // throws before any outbound API call — failing the job deterministically.
    process.env.ELEVENLABS_API_KEY = "test-key";

    const fs = createEngineForTest(tempDir);
    const asset = await fs.artifacts.create("aud", "waitcase");
    if (!asset.ok) throw new Error("Failed to create asset");

    await fs.files.write(asset.value.artifactId, "original.mp3", Buffer.from("fake-mp3"));

    const result = await client.callTool({
      name: "transcribe",
      arguments: {
        asset_id: asset.value.artifactId,
        book_id: "test-proj",
        wait: true,
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("Transcription failed");
  }, testBudget(60_000));
});
