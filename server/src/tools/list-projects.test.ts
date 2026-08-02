import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/client";

describe("list_projects tool", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-test-"));
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("returns empty array when no projects exist", async () => {
    client = await createTestClient(tempDir);
    const result = await client.callTool({
      name: "list_projects",
      arguments: {},
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text);
    expect(data).toEqual([]);
  });

  it("returns all created projects", async () => {
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "alpha" },
    });
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "beta" },
    });
    const result = await client.callTool({
      name: "list_projects",
      arguments: {},
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text);
    const slugs = data.map((p: { slug: string }) => p.slug).sort();
    expect(slugs).toEqual(["alpha", "beta"]);
  });

  it("returns projects with sort parameter", async () => {
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "alpha" },
    });
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "beta" },
    });
    const result = await client.callTool({
      name: "list_projects",
      arguments: { sort: "newest" },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text);
    expect(data.length).toBe(2);
    // Both projects returned regardless of sort order
    const slugs = data.map((p: { slug: string }) => p.slug).sort();
    expect(slugs).toEqual(["alpha", "beta"]);
  });

  it("returns asset counts for each project", async () => {
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "empty" },
    });
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "with-assets" },
    });
    await client.callTool({
      name: "upload_file",
      arguments: {
        book_id: "with-assets",
        filename: "note.md",
        data: Buffer.from("hello").toString("base64"),
      },
    });
    const result = await client.callTool({
      name: "list_projects",
      arguments: {},
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text) as Array<{
      slug: string;
      asset_count: number;
    }>;
    const counts = new Map(data.map((project) => [project.slug, project.asset_count]));
    expect(counts.get("empty")).toBe(1);
    expect(counts.get("with-assets")).toBe(2);
  });
});
