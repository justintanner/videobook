import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { queue } from "../queue.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const MINIMAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
  "base64",
);

// Per-test createTestClient + create_project under parallel test load was
// racing on the queue's global projectsDir, intermittently failing with
// ENOENT on .project.lock. Mirror asset-manifest.test.ts: a single
// beforeAll/afterAll, with a unique project slug per test for isolation.
describe("list_assets tool", () => {
  let client: Client;
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-test-"));
    client = await createTestClient(tempDir);
    await queue.start();
  });

  afterAll(async () => {
    await queue.stop();
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("returns the scratch notebook for a new project", async () => {
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
    expect(data.assets).toHaveLength(1);
    expect(data.assets[0]).toMatchObject({
      type: "notebook",
    });
    expect(data.assets[0].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
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
    expect(data.assets).toHaveLength(3);
    const ids = data.assets.map((a: { id: string }) => a.id);
    expect(ids.some((id: string) => id.startsWith("img-"))).toBe(true);
    expect(ids.some((id: string) => id.startsWith("script-"))).toBe(true);
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
