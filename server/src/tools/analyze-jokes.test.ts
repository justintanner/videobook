import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { createFs } from "videobook-engine";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

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
      arguments: { project_slug: "jokes-proj" },
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
      arguments: { asset_id: "vid-anything", project_slug: "jokes-proj" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("OPENAI_API_KEY");
  });

  it("returns error when asset has no ElevenLabs transcript", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    const fs = createFs({ projectsDir: tempDir });
    const asset = await fs.createAsset("vid", "no-transcript", "jokes-proj");
    if (!asset.ok) throw new Error("Failed to create asset");
    await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from([0]), "jokes-proj");

    const result = await client.callTool({
      name: "analyze_jokes",
      arguments: { asset_id: asset.value.assetId, project_slug: "jokes-proj" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("No ElevenLabs transcript");
    expect(content[0].text).toContain("/transcribe");
  });

  it("returns error when transcript has no spoken words", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    const fs = createFs({ projectsDir: tempDir });
    const asset = await fs.createAsset("vid", "empty-words", "jokes-proj");
    if (!asset.ok) throw new Error("Failed to create asset");
    await fs.writeFile(
      asset.value.assetId,
      "elevenlabs.json",
      JSON.stringify({ text: "", words: [] }),
      "jokes-proj",
    );

    const result = await client.callTool({
      name: "analyze_jokes",
      arguments: { asset_id: asset.value.assetId, project_slug: "jokes-proj" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("No ElevenLabs transcript");
  });

  it("accepts an @-prefixed asset id and still requires a transcript", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    const fs = createFs({ projectsDir: tempDir });
    const asset = await fs.createAsset("vid", "prefixed", "jokes-proj");
    if (!asset.ok) throw new Error("Failed to create asset");

    const result = await client.callTool({
      name: "analyze_jokes",
      arguments: { asset_id: `@${asset.value.assetId}`, project_slug: "jokes-proj" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain(asset.value.assetId);
  });
});
