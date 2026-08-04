import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/client";

const MINIMAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
  "base64",
);

describe("list_assets tool", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-test-"));
    client = await createTestClient(tempDir);
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("returns no artifacts for a new book", async () => {
    const slug = "list-empty";
    await client.callTool({
      name: "create_project",
      arguments: { book_id: slug },
    });

    const result = await client.callTool({
      name: "list_assets",
      arguments: { book_id: slug },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text);
    expect(data.assets).toEqual([]);
    expect(data.page).toEqual({
      offset: 0,
      limit: 200,
      total: 0,
      hasMore: false,
    });
  });

  it("lists uploaded assets", async () => {
    const slug = "list-uploaded";
    await client.callTool({
      name: "create_project",
      arguments: { book_id: slug },
    });

    const pngData = MINIMAL_PNG.toString("base64");
    await client.callTool({
      name: "upload_file",
      arguments: { book_id: slug, filename: "photo.png", data: pngData },
    });
    await client.callTool({
      name: "upload_file",
      arguments: { book_id: slug, filename: "script.md", data: Buffer.from("# Hello").toString("base64") },
    });

    const result = await client.callTool({
      name: "list_assets",
      arguments: { book_id: slug },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text);
    expect(data.assets).toHaveLength(2);
    const ids = data.assets.map((a: { id: string }) => a.id);
    expect(ids.some((id: string) => id.startsWith("img-"))).toBe(true);
    expect(ids.some((id: string) => id.startsWith("script-"))).toBe(true);
    const pageResult = await client.callTool({
      name: "list_assets",
      arguments: { book_id: slug, sort: "newest", limit: 1, offset: 1 },
    });
    const pageContent = pageResult.content as Array<{ type: string; text: string }>;
    const page = JSON.parse(pageContent[0].text);
    expect(page.assets).toHaveLength(1);
    expect(page.page).toEqual({
      offset: 1,
      limit: 1,
      total: 2,
      hasMore: false,
    });
  });

  it("sorts newest vs oldest", async () => {
    const slug = "list-sort";
    await client.callTool({
      name: "create_project",
      arguments: { book_id: slug },
    });

    const pngData = MINIMAL_PNG.toString("base64");
    const firstResult = await client.callTool({
      name: "upload_file",
      arguments: { book_id: slug, filename: "first.png", data: pngData },
    });
    const firstParsed = JSON.parse(
      (firstResult.content as Array<{ type: string; text: string }>)[0].text,
    );
    await new Promise((resolve) => setTimeout(resolve, 2));
    const secondResult = await client.callTool({
      name: "upload_file",
      arguments: { book_id: slug, filename: "second.png", data: pngData },
    });
    const secondParsed = JSON.parse(
      (secondResult.content as Array<{ type: string; text: string }>)[0].text,
    );

    const newestResult = await client.callTool({
      name: "list_assets",
      arguments: { book_id: slug, sort: "newest" },
    });
    const newestContent = newestResult.content as Array<{ type: string; text: string }>;
    const newestData = JSON.parse(newestContent[0].text);
    const newestIds = newestData.assets
      .filter((a: { type: string }) => a.type !== "notebook")
      .map((a: { id: string }) => a.id);

    const oldestResult = await client.callTool({
      name: "list_assets",
      arguments: { book_id: slug, sort: "oldest" },
    });
    const oldestContent = oldestResult.content as Array<{ type: string; text: string }>;
    const oldestData = JSON.parse(oldestContent[0].text);
    const oldestIds = oldestData.assets
      .filter((a: { type: string }) => a.type !== "notebook")
      .map((a: { id: string }) => a.id);

    // Newest should have second asset first, oldest should have first asset first
    expect(newestIds[0]).toBe(secondParsed.assetId);
    expect(newestIds[1]).toBe(firstParsed.assetId);
    expect(oldestIds[0]).toBe(firstParsed.assetId);
    expect(oldestIds[1]).toBe(secondParsed.assetId);
    expect(newestIds).toEqual([...oldestIds].reverse());
  });
});
