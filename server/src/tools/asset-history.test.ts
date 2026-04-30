import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { createFsForTest } from "../fs.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

// Single shared client/project. Tests use unique asset ids and only read
// history; no test mutates state visible to another. Per-test setup under
// parallel test load was burning ~63s (16s/test).
describe("asset_history tool", () => {
  let client: Client;
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "test-proj" },
    });
  });

  afterAll(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("returns commit history scoped to an asset", async () => {
    const data = Buffer.from("fake-png-data").toString("base64");
    const uploadResult = await client.callTool({
      name: "upload_file",
      arguments: { project_slug: "test-proj", filename: "photo.png", data },
    });
    const uploaded = JSON.parse(
      (uploadResult.content as Array<{ type: string; text: string }>)[0].text
    );

    const result = await client.callTool({
      name: "asset_history",
      arguments: { asset_id: uploaded.assetId, project_slug: "test-proj" },
    });

    const commits = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text
    );
    expect(Array.isArray(commits)).toBe(true);
    expect(commits.length).toBeGreaterThan(0);
    expect(commits[0]).toHaveProperty("hash");
    expect(commits[0]).toHaveProperty("message");
  });

  it("attaches rewrite metadata when .original.json exists for a script asset", async () => {
    // Seed a script asset with markdown + .original.json via the fs layer directly.
    const fs = createFsForTest(tempDir);
    const createResult = await fs.createAsset("script", "desc-x-pig-1", "test-proj");
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;
    const scriptAssetId = createResult.value.assetId;

    await fs.writeFile(scriptAssetId, "original.md", "a pig sits upright", "test-proj");
    await fs.writeMetadata(
      scriptAssetId,
      "original",
      {
        origin: "describe_image",
        sourceAssetId: "img-source-1",
        model: "gpt-5.2",
        variant: "tldr",
        platform: "ig",
        customPrompt: "replace the pig with a man in a blue suit",
        processed_at: "2026-04-22T10:00:00.000Z",
      },
      "test-proj",
    );

    const result = await client.callTool({
      name: "asset_history",
      arguments: { asset_id: scriptAssetId, project_slug: "test-proj" },
    });
    const commits = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text
    );
    expect(Array.isArray(commits)).toBe(true);
    expect(commits.length).toBeGreaterThan(0);

    // The most recent commit (HEAD) should carry the rewrite metadata we seeded.
    const head = commits[0];
    expect(head.rewrite).toBeDefined();
    expect(head.rewrite).toMatchObject({
      model: "gpt-5.2",
      variant: "tldr",
      platform: "ig",
      customPrompt: "replace the pig with a man in a blue suit",
      processedAt: "2026-04-22T10:00:00.000Z",
    });
  });

  it("omits rewrite metadata for non-script assets", async () => {
    const data = Buffer.from("fake-png-data").toString("base64");
    const uploadResult = await client.callTool({
      name: "upload_file",
      arguments: { project_slug: "test-proj", filename: "photo.png", data },
    });
    const uploaded = JSON.parse(
      (uploadResult.content as Array<{ type: string; text: string }>)[0].text
    );
    const result = await client.callTool({
      name: "asset_history",
      arguments: { asset_id: uploaded.assetId, project_slug: "test-proj" },
    });
    const commits = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text
    );
    for (const commit of commits) {
      expect(commit.rewrite).toBeUndefined();
    }
  });

  it("returns empty or throws for nonexistent asset", async () => {
    const result = await client.callTool({
      name: "asset_history",
      arguments: { asset_id: "img-nonexistent-asset", project_slug: "test-proj" },
    });
    // asset_history calls fs.getAssetHistory which returns empty array for missing assets
    const content = result.content as Array<{ type: string; text: string }>;
    const commits = JSON.parse(content[0].text);
    expect(Array.isArray(commits)).toBe(true);
    expect(commits.length).toBe(0);
  });
});
