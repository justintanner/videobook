import { createEngineForTest } from "../fs.js";
import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { createTestClient } from "../test-client.js";
import { queue } from "../queue.js";
import type { Client } from "@modelcontextprotocol/client";
import { findApplySfxSourceFile } from "./apply-sfx.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const FFMPEG: string = require("ffmpeg-static");

type TextContent = Array<{ type: string; text: string }>;

async function generateTestVideo(outputPath: string): Promise<void> {
  await execFileAsync(FFMPEG, [
    "-y",
    "-f", "lavfi", "-i", "testsrc=duration=3:size=320x240:rate=10",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest",
    outputPath,
  ]);
}

async function uploadVideo(
  client: Client,
  bookId: string,
  videoPath: string,
): Promise<{ assetId: string; path: string }> {
  const data = (await readFile(videoPath)).toString("base64");
  const result = await client.callTool({
    name: "upload_file",
    arguments: { book_id: bookId, filename: "original.mp4", data },
  });
  return JSON.parse((result.content as TextContent)[0].text);
}

describe("apply_sfx tool", () => {
  let client: Client;
  let tempDir: string;
  let fixtureDir: string;
  let videoPath: string;
  const originalKey = process.env.ELEVENLABS_API_KEY;

  beforeAll(async () => {
    await queue.start();
    fixtureDir = await mkdtemp(join(tmpdir(), "videocity-apply-sfx-fixture-"));
    videoPath = join(fixtureDir, "test-source.mp4");
    await generateTestVideo(videoPath);
  }, 60_000);

  afterAll(async () => {
    await queue.stop();
    await rm(fixtureDir, { recursive: true, force: true, maxRetries: 3 });
  }, 30_000);

  beforeEach(async () => {
    delete process.env.ELEVENLABS_API_KEY;
    tempDir = await mkdtemp(join(tmpdir(), "videocity-apply-sfx-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "sfx-proj" },
    });
  });

  afterEach(async () => {
    if (originalKey) {
      process.env.ELEVENLABS_API_KEY = originalKey;
    } else {
      delete process.env.ELEVENLABS_API_KEY;
    }
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("returns error when ELEVENLABS_API_KEY is not set", async () => {
    const result = await client.callTool({
      name: "apply_sfx",
      arguments: {
        asset_id: "vid-anything",
        book_id: "sfx-proj",
        sfx: [{ timestamp: 1, type: "whoosh", description: "test" }],
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("ELEVENLABS_API_KEY");
  });

  it("prefers the canonical video over a stale partial SFX output", () => {
    const file = findApplySfxSourceFile([
      { name: "original_sfx.mp4", size_bytes: 10, extension: ".mp4", mtimeMs: 2 },
      { name: "original.mp4", size_bytes: 10, extension: ".mp4", mtimeMs: 1 },
    ]);
    expect(file?.name).toBe("original.mp4");
  });

  it("returns error for nonexistent asset", async () => {
    process.env.ELEVENLABS_API_KEY = "test-key";

    const result = await client.callTool({
      name: "apply_sfx",
      arguments: {
        asset_id: "vid-does-not-exist",
        book_id: "sfx-proj",
        sfx: [{ timestamp: 1, type: "whoosh", description: "test" }],
      },
    });

    expect(result.isError).toBe(true);
  });

  it("returns error when asset has no video", async () => {
    process.env.ELEVENLABS_API_KEY = "test-key";
    const fs = createEngineForTest(tempDir);
    const asset = await fs.artifacts.create("vid", "no-video");
    if (!asset.ok) throw new Error("Failed to create asset");
    await fs.files.write(asset.value.slug, "notes.txt", "hello");

    const result = await client.callTool({
      name: "apply_sfx",
      arguments: {
        asset_id: asset.value.slug,
        book_id: "sfx-proj",
        sfx: [{ timestamp: 1, type: "whoosh", description: "test" }],
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("No video file");
  });

  it("returns error when all entries are past duration", async () => {
    process.env.ELEVENLABS_API_KEY = "test-key";
    const uploaded = await uploadVideo(client, "sfx-proj", videoPath);
    const fs = createEngineForTest(tempDir);
    await fs.metadata.artifacts.write(uploaded.assetId, "original", { width: 320, height: 240, duration: 3, hasAudio: true }
    );

    const result = await client.callTool({
      name: "apply_sfx",
      arguments: {
        asset_id: uploaded.assetId,
        book_id: "sfx-proj",
        sfx: [{ timestamp: 99, type: "whoosh", description: "after-end" }],
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("rejected");
  }, 60_000);

  it("rejects schema with more than 8 entries", async () => {
    process.env.ELEVENLABS_API_KEY = "test-key";

    const sfx = Array.from({ length: 9 }, (_, i) => ({
      timestamp: i * 0.1,
      type: "tick",
      description: `tick ${i}`,
    }));

    const result = await client.callTool({
      name: "apply_sfx",
      arguments: {
        asset_id: "vid-any",
        book_id: "sfx-proj",
        sfx,
      },
    });

    expect(result.isError).toBe(true);
  });

  it("rejects schema with empty sfx array", async () => {
    process.env.ELEVENLABS_API_KEY = "test-key";

    const result = await client.callTool({
      name: "apply_sfx",
      arguments: {
        asset_id: "vid-any",
        book_id: "sfx-proj",
        sfx: [],
      },
    });

    expect(result.isError).toBe(true);
  });
});
