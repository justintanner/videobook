import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { queue } from "../queue.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const MINIMAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
  "base64",
);

describe("list_assets tool", () => {
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

  it("returns empty assets array for empty project", async () => {
    const result = await client.callTool({
      name: "list_assets",
      arguments: { project_slug: "test-proj" },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text);
    expect(data.assets).toEqual([]);
  });

  it("lists uploaded assets", async () => {
    const pngData = MINIMAL_PNG.toString("base64");
    await client.callTool({
      name: "upload_file",
      arguments: { project_slug: "test-proj", filename: "photo.png", data: pngData },
    });
    await client.callTool({
      name: "upload_file",
      arguments: { project_slug: "test-proj", filename: "script.md", data: Buffer.from("# Hello").toString("base64") },
    });

    const result = await client.callTool({
      name: "list_assets",
      arguments: { project_slug: "test-proj" },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text);
    expect(data.assets).toHaveLength(2);
    const ids = data.assets.map((a: { id: string }) => a.id);
    expect(ids.some((id: string) => id.startsWith("img-"))).toBe(true);
    expect(ids.some((id: string) => id.startsWith("script-"))).toBe(true);
  });

  it("sorts newest vs oldest", async () => {
    const pngData = MINIMAL_PNG.toString("base64");
    const firstResult = await client.callTool({
      name: "upload_file",
      arguments: { project_slug: "test-proj", filename: "first.png", data: pngData },
    });
    const firstParsed = JSON.parse(
      (firstResult.content as Array<{ type: string; text: string }>)[0].text,
    );
    const secondResult = await client.callTool({
      name: "upload_file",
      arguments: { project_slug: "test-proj", filename: "second.png", data: pngData },
    });
    const secondParsed = JSON.parse(
      (secondResult.content as Array<{ type: string; text: string }>)[0].text,
    );

    // Force distinct timestamps so sort order is deterministic
    const now = Math.floor(Date.now() / 1000);
    await writeFile(join(tempDir, "test-proj", firstParsed.assetId, ".created_at"), String(now - 100));
    await writeFile(join(tempDir, "test-proj", secondParsed.assetId, ".created_at"), String(now));

    const newestResult = await client.callTool({
      name: "list_assets",
      arguments: { project_slug: "test-proj", sort: "newest" },
    });
    const newestContent = newestResult.content as Array<{ type: string; text: string }>;
    const newestData = JSON.parse(newestContent[0].text);
    const newestIds = newestData.assets.map((a: { id: string }) => a.id);

    const oldestResult = await client.callTool({
      name: "list_assets",
      arguments: { project_slug: "test-proj", sort: "oldest" },
    });
    const oldestContent = oldestResult.content as Array<{ type: string; text: string }>;
    const oldestData = JSON.parse(oldestContent[0].text);
    const oldestIds = oldestData.assets.map((a: { id: string }) => a.id);

    // Newest should have second asset first, oldest should have first asset first
    expect(newestIds[0]).toBe(secondParsed.assetId);
    expect(newestIds[1]).toBe(firstParsed.assetId);
    expect(oldestIds[0]).toBe(firstParsed.assetId);
    expect(oldestIds[1]).toBe(secondParsed.assetId);
    expect(newestIds).toEqual([...oldestIds].reverse());
  });
});
