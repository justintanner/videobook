import { createEngineForTest } from "../fs.js";
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/client";

type TextContent = Array<{ type: string; text: string }>;

describe("analyze_jokes tool", () => {
  let client: Client;
  let tempDir: string;
  const originalKey = process.env.OPENAI_API_KEY;

  beforeEach(async () => {
    delete process.env.OPENAI_API_KEY;
    tempDir = await mkdtemp(join(tmpdir(), "videocity-analyze-jokes-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "jokes-proj" },
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
      name: "analyze_jokes",
      arguments: { asset_id: "vid-anything", book_id: "jokes-proj" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("OPENAI_API_KEY");
  });

  it("returns error when asset has no ElevenLabs transcript", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    const fs = createEngineForTest(tempDir);
    const asset = await fs.artifacts.create("vid", "no-transcript");
    if (!asset.ok) throw new Error("Failed to create asset");
    await fs.files.write(asset.value.artifactId, "original.mp4", Buffer.from([0]));

    const result = await client.callTool({
      name: "analyze_jokes",
      arguments: { asset_id: asset.value.artifactId, book_id: "jokes-proj" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("No ElevenLabs transcript");
    expect(content[0].text).toContain("/transcribe");
  });

  it("returns error when transcript has no spoken words", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    const fs = createEngineForTest(tempDir);
    const asset = await fs.artifacts.create("vid", "empty-words");
    if (!asset.ok) throw new Error("Failed to create asset");
    await fs.files.write(asset.value.artifactId, "elevenlabs.json", JSON.stringify({ text: "", words: [] })
    );

    const result = await client.callTool({
      name: "analyze_jokes",
      arguments: { asset_id: asset.value.artifactId, book_id: "jokes-proj" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("No ElevenLabs transcript");
  });

  it("accepts an @-prefixed asset id and still requires a transcript", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    const fs = createEngineForTest(tempDir);
    const asset = await fs.artifacts.create("vid", "prefixed");
    if (!asset.ok) throw new Error("Failed to create asset");

    const result = await client.callTool({
      name: "analyze_jokes",
      arguments: { asset_id: `@${asset.value.artifactId}`, book_id: "jokes-proj" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain(asset.value.artifactId);
  });
});
