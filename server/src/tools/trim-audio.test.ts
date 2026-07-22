import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { queue } from "../queue.js";
import { createFs } from "videocity-engine";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

type TextContent = Array<{ type: string; text: string }>;

describe("trim_audio tool", () => {
  let client: Client;
  let tempDir: string;

  beforeAll(async () => {
    await queue.start();
  });

  afterAll(async () => {
    await queue.stop();
  });

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-trim-audio-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "test-proj" },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("returns error for invalid trim params (both trim and cut)", async () => {
    const result = await client.callTool({
      name: "trim_audio",
      arguments: {
        asset_id: "aud-test",
        project_slug: "test-proj",
        trim_start: 1,
        cut_start: 2,
        cut_end: 3,
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("Cannot specify both trim");
  });

  it("returns error for nonexistent asset", async () => {
    const result = await client.callTool({
      name: "trim_audio",
      arguments: {
        asset_id: "aud-does-not-exist",
        project_slug: "test-proj",
        trim_start: 1,
      },
    });

    expect(result.isError).toBe(true);
  });

  it("returns error when asset has no audio or video file", async () => {
    const fs = createFs({ projectsDir: tempDir });
    const asset = await fs.createAsset("aud", "empty", "test-proj");
    if (!asset.ok) throw new Error("Failed to create asset");
    await fs.writeFile(asset.value.assetId, "notes.txt", "hello", "test-proj");

    const result = await client.callTool({
      name: "trim_audio",
      arguments: {
        asset_id: asset.value.assetId,
        project_slug: "test-proj",
        trim_start: 1,
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("No audio or video file found");
  });
});
