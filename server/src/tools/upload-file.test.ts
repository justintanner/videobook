import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

describe("upload_file tool", () => {
  let client: Client;
  let tempDir: string;

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
    await rm(tempDir, { recursive: true, force: true });
  });

  it("uploads an image file", async () => {
    const data = Buffer.from("fake-png-data").toString("base64");
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
    expect(written.toString()).toBe("fake-png-data");
  });

  it("creates .origin.json after media upload", async () => {
    const data = Buffer.from("fake-png-data").toString("base64");
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

    const originData = await readFile(join(tempDir, "test-proj", parsed.assetId, ".origin.json"), "utf-8");
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
