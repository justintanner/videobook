import { createEngineForTest } from "../fs.js";
import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { queue } from "../queue.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

type TextContent = Array<{ type: string; text: string }>;

describe("isolate_vocals tool", () => {
  let client: Client;
  let tempDir: string;
  const originalKey = process.env.KIE_API_KEY;

  beforeAll(async () => {
    await queue.start();
  });

  afterAll(async () => {
    await queue.stop();
  });

  beforeEach(async () => {
    delete process.env.KIE_API_KEY;
    tempDir = await mkdtemp(join(tmpdir(), "videocity-isolate-vocals-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "test-proj" },
    });
  });

  afterEach(async () => {
    if (originalKey) {
      process.env.KIE_API_KEY = originalKey;
    } else {
      delete process.env.KIE_API_KEY;
    }
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("returns error when KIE_API_KEY is not set", async () => {
    const result = await client.callTool({
      name: "isolate_vocals",
      arguments: {
        asset_id: "vid-test",
        project_slug: "test-proj",
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("not set");
  });

  it("returns error for nonexistent asset", async () => {
    process.env.KIE_API_KEY = "test-key";

    const result = await client.callTool({
      name: "isolate_vocals",
      arguments: {
        asset_id: "vid-does-not-exist",
        project_slug: "test-proj",
      },
    });

    expect(result.isError).toBe(true);
  });

  it("returns error when asset has no audio file", async () => {
    process.env.KIE_API_KEY = "test-key";

    const fs = createEngineForTest(tempDir);
    const asset = await fs.artifacts.create("vid", "no-audio", "test-proj");
    if (!asset.ok) throw new Error("Failed to create asset");

    // Write a non-audio file so the asset exists but has no audio
    await fs.files.write(asset.value.slug, "notes.txt", "hello", "test-proj");

    const result = await client.callTool({
      name: "isolate_vocals",
      arguments: {
        asset_id: asset.value.slug,
        project_slug: "test-proj",
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("No audio file");
  });

  it("enqueues job with valid vid asset containing audio", async () => {
    process.env.KIE_API_KEY = "test-key";

    const fs = createEngineForTest(tempDir);
    const asset = await fs.artifacts.create("vid", "has-audio", "test-proj");
    if (!asset.ok) throw new Error("Failed to create asset");

    // Write a dummy audio_original.mp3 file
    await fs.files.write(asset.value.slug, "audio_original.mp3", Buffer.from("fake-mp3-data"), "test-proj");

    const result = await client.callTool({
      name: "isolate_vocals",
      arguments: {
        asset_id: asset.value.slug,
        project_slug: "test-proj",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.asset_id).toBe(asset.value.slug);
    expect(parsed.job_id).toBeDefined();
  });
});
