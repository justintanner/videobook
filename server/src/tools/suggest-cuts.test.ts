import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { queue } from "../queue.js";
import { createFs } from "vc-engine";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

type TextContent = Array<{ type: string; text: string }>;

describe("suggest_cuts tool", () => {
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
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-suggest-cuts-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "cuts-proj" },
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
      name: "suggest_cuts",
      arguments: { asset_id: "vid-anything", project_slug: "cuts-proj" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("OPENAI_API_KEY");
  });

  it("returns error for nonexistent asset", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    const result = await client.callTool({
      name: "suggest_cuts",
      arguments: { asset_id: "vid-does-not-exist", project_slug: "cuts-proj" },
    });

    expect(result.isError).toBe(true);
  });

  it("returns error when asset has no video file", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    const fs = createFs({ projectsDir: tempDir });
    const asset = await fs.createAsset("vid", "empty-vid", "cuts-proj");
    if (!asset.ok) throw new Error("Failed to create asset");
    await fs.writeFile(asset.value.assetId, "notes.txt", "hello", "cuts-proj");

    const result = await client.callTool({
      name: "suggest_cuts",
      arguments: { asset_id: asset.value.assetId, project_slug: "cuts-proj" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("No video file");
  });

  it("returns error when asset has no frames", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    const fs = createFs({ projectsDir: tempDir });
    const asset = await fs.createAsset("vid", "no-frames-vid", "cuts-proj");
    if (!asset.ok) throw new Error("Failed to create asset");
    await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from([0]), "cuts-proj");

    const result = await client.callTool({
      name: "suggest_cuts",
      arguments: { asset_id: asset.value.assetId, project_slug: "cuts-proj" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("no frames");
  });

  it("returns error when asset has frames but no transcript", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    const fs = createFs({ projectsDir: tempDir });
    const asset = await fs.createAsset("vid", "no-transcript-vid", "cuts-proj");
    if (!asset.ok) throw new Error("Failed to create asset");
    await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from([0]), "cuts-proj");
    const framesDir = join(tempDir, "cuts-proj", asset.value.assetId, "original_frames");
    await mkdir(framesDir, { recursive: true });
    await writeFile(join(framesDir, "0.000.jpg"), Buffer.from([0xff, 0xd8, 0xff]));

    const result = await client.callTool({
      name: "suggest_cuts",
      arguments: { asset_id: asset.value.assetId, project_slug: "cuts-proj" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("No transcript");
  });
});
