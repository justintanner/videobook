import { createEngineForTest } from "../fs.js";
import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { queue } from "../queue.js";
import type { Client } from "@modelcontextprotocol/client";

type TextContent = Array<{ type: string; text: string }>;

describe("translate_subtitles tool", () => {
  let client: Client;
  let tempDir: string;
  const originalKey = process.env.OPENAI_API_KEY;

  beforeAll(async () => {
    await queue.start();
  });

  afterAll(async () => {
    await queue.stop();
  });

  beforeEach(async () => {
    delete process.env.OPENAI_API_KEY;
    tempDir = await mkdtemp(join(tmpdir(), "videocity-translate-subs-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "test-proj" },
    });
  });

  afterEach(async () => {
    if (originalKey) {
      process.env.OPENAI_API_KEY = originalKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("returns error when OPENAI_API_KEY is not set", async () => {
    const result = await client.callTool({
      name: "translate_subtitles",
      arguments: { asset_id: "vid-test", book_id: "test-proj", language: "en" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("not set");
  });

  it("rejects asset ids that are not vid- or aud-", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const result = await client.callTool({
      name: "translate_subtitles",
      arguments: { asset_id: "img-test", book_id: "test-proj", language: "en" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("vid- or aud-");
  });

  it("returns error when the asset has no elevenlabs.json", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const fs = createEngineForTest(tempDir);
    const asset = await fs.artifacts.create("vid", "untranscribed");
    if (!asset.ok) throw new Error("Failed to create asset");
    await fs.files.write(asset.value.slug, "original.mp4", Buffer.from("fake-video"));

    const result = await client.callTool({
      name: "translate_subtitles",
      arguments: { asset_id: asset.value.slug, book_id: "test-proj", language: "en" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("Transcribe the asset first");
  });

  it("enqueues the translate job for a transcribed asset", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const fs = createEngineForTest(tempDir);
    const asset = await fs.artifacts.create("vid", "transcribed");
    if (!asset.ok) throw new Error("Failed to create asset");
    await fs.files.write(asset.value.slug, "elevenlabs.json", JSON.stringify({ words: [] }));

    const result = await client.callTool({
      name: "translate_subtitles",
      arguments: { asset_id: asset.value.slug, book_id: "test-proj", language: "en" },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.language).toBe("en");
    expect(parsed.job_id).toContain(`translate-${asset.value.slug}-en`);
  });
});
