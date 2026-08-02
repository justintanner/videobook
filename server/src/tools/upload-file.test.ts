import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "videobook-engine";
import { createEngineForTest } from "../fs.js";
import { createTestClient } from "../test-client.js";
import { queue } from "../queue.js";
import type { Client } from "@modelcontextprotocol/client";

// Minimal valid 1x1 red PNG (67 bytes)
const MINIMAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
  "base64",
);

describe("upload_file tool", () => {
  let client: Client;
  let tempDir: string;
  let fs: Engine;

  beforeAll(async () => {
    await queue.start();
  });

  afterAll(async () => {
    await queue.stop();
  });

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-test-"));
    fs = createEngineForTest(tempDir);
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "test-proj" },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("uploads an image file", async () => {
    const data = MINIMAL_PNG.toString("base64");
    const result = await client.callTool({
      name: "upload_file",
      arguments: {
        book_id: "test-proj",
        filename: "photo.png",
        data,
      },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.assetId).toMatch(/^img-/);
    expect(parsed.filename).toBe("original.png");

    const written = await fs.files.read(parsed.assetId, "original.png");
    expect(written.ok && written.value.equals(MINIMAL_PNG)).toBe(true);
  });

  it("stores original metadata after media upload", async () => {
    const data = MINIMAL_PNG.toString("base64");
    const result = await client.callTool({
      name: "upload_file",
      arguments: {
        book_id: "test-proj",
        filename: "photo.png",
        data,
      },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);

    const origin = await fs.metadata.artifacts.read<{
      origin: string;
      processed_at: string;
    }>(parsed.assetId, "original");
    expect(origin.ok && origin.value.origin).toBe("upload");
    expect(origin.ok && origin.value.processed_at).toBeDefined();
  });

  it("uploads a markdown file", async () => {
    const data = Buffer.from("# Hello").toString("base64");
    const result = await client.callTool({
      name: "upload_file",
      arguments: {
        book_id: "test-proj",
        filename: "script.md",
        data,
      },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.assetId).toMatch(/^script-/);
  });

  it("rejects unsupported extension", async () => {
    const data = Buffer.from("hello").toString("base64");
    const result = await client.callTool({
      name: "upload_file",
      arguments: {
        book_id: "test-proj",
        filename: "notes.txt",
        data,
      },
    });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain(".txt");
  });

  it("rejects nonexistent project", async () => {
    const data = Buffer.from("data").toString("base64");
    const result = await client.callTool({
      name: "upload_file",
      arguments: {
        book_id: "no-such-project",
        filename: "photo.png",
        data,
      },
    });
    expect(result.isError).toBe(true);
  });
});
