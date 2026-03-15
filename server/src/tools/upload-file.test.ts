import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { queue } from "../queue.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

// Minimal valid 1x1 red PNG (67 bytes)
const MINIMAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
  "base64",
);

async function waitForFile(filePath: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await access(filePath);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

describe("upload_file tool", () => {
  let client: Client;
  let tempDir: string;

  beforeAll(async () => {
    await queue.start();
  });

  afterAll(async () => {
    await queue.stop();
  });

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-test-"));
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

  it("uploads an image file", async () => {
    const data = MINIMAL_PNG.toString("base64");
    const result = await client.callTool({
      name: "upload_file",
      arguments: {
        project_slug: "test-proj",
        filename: "photo.png",
        data,
      },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.assetId).toMatch(/^img-/);
    expect(parsed.filename).toBe("original.png");

    const written = await readFile(join(tempDir, "test-proj", parsed.assetId, "original.png"));
    expect(written.equals(MINIMAL_PNG)).toBe(true);
  });

  it("creates .original.json after media upload", async () => {
    const data = MINIMAL_PNG.toString("base64");
    const result = await client.callTool({
      name: "upload_file",
      arguments: {
        project_slug: "test-proj",
        filename: "photo.png",
        data,
      },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);

    const metaPath = join(tempDir, "test-proj", parsed.assetId, ".original.json");
    await waitForFile(metaPath);

    const originData = await readFile(metaPath, "utf-8");
    const origin = JSON.parse(originData);
    expect(origin.origin).toBe("upload");
    expect(origin.processed_at).toBeDefined();
  });

  it("uploads a markdown file", async () => {
    const data = Buffer.from("# Hello").toString("base64");
    const result = await client.callTool({
      name: "upload_file",
      arguments: {
        project_slug: "test-proj",
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
        project_slug: "test-proj",
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
        project_slug: "no-such-project",
        filename: "photo.png",
        data,
      },
    });
    expect(result.isError).toBe(true);
  });
});
