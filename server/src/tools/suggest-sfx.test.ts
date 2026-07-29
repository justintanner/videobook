import { createEngineForTest } from "../fs.js";
import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { queue } from "../queue.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

type TextContent = Array<{ type: string; text: string }>;

describe("suggest_sfx tool", () => {
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
    tempDir = await mkdtemp(join(tmpdir(), "videocity-suggest-sfx-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "sfx-proj" },
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
      name: "suggest_sfx",
      arguments: { asset_id: "vid-anything", book_id: "sfx-proj" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("OPENAI_API_KEY");
  });

  it("returns error for nonexistent asset", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    const result = await client.callTool({
      name: "suggest_sfx",
      arguments: { asset_id: "vid-does-not-exist", book_id: "sfx-proj" },
    });

    expect(result.isError).toBe(true);
  });

  it("returns error when asset has no video file", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    const fs = createEngineForTest(tempDir);
    const asset = await fs.artifacts.create("vid", "empty-vid");
    if (!asset.ok) throw new Error("Failed to create asset");
    await fs.files.write(asset.value.slug, "notes.txt", "hello");

    const result = await client.callTool({
      name: "suggest_sfx",
      arguments: { asset_id: asset.value.slug, book_id: "sfx-proj" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("No video file");
  });

  it("returns error when asset has no frames", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    const fs = createEngineForTest(tempDir);
    const asset = await fs.artifacts.create("vid", "no-frames-vid");
    if (!asset.ok) throw new Error("Failed to create asset");
    await fs.files.write(asset.value.slug, "original.mp4", Buffer.from([0]));

    const result = await client.callTool({
      name: "suggest_sfx",
      arguments: { asset_id: asset.value.slug, book_id: "sfx-proj" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("no frames");
  });

  it("returns error when asset has frames but no transcript", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    const fs = createEngineForTest(tempDir);
    const asset = await fs.artifacts.create("vid", "no-transcript-vid");
    if (!asset.ok) throw new Error("Failed to create asset");
    await fs.files.write(asset.value.slug, "original.mp4", Buffer.from([0]));
    await fs.files.write(asset.value.slug, "original_frames/0.000.jpg", Buffer.from([0xff, 0xd8, 0xff])
    );

    const result = await client.callTool({
      name: "suggest_sfx",
      arguments: { asset_id: asset.value.slug, book_id: "sfx-proj" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("No transcript");
  });
});
