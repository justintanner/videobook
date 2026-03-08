import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

describe("rename_asset tool", () => {
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
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("renames an existing asset", async () => {
    const data = Buffer.from("fake-png-data").toString("base64");
    const uploadResult = await client.callTool({
      name: "upload_file",
      arguments: { project_slug: "test-proj", filename: "photo.png", data },
    });
    const uploaded = JSON.parse(
      (uploadResult.content as Array<{ type: string; text: string }>)[0].text
    );

    const result = await client.callTool({
      name: "rename_asset",
      arguments: {
        asset_id: uploaded.assetId,
        new_name: "sunset beach",
        project_slug: "test-proj",
      },
    });

    const parsed = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text
    );
    expect(parsed.old_asset_id).toBe(uploaded.assetId);
    expect(parsed.new_asset_id).toMatch(/^img-/);
    expect(parsed.new_asset_id).not.toBe(uploaded.assetId);

    // Old asset should be gone
    const oldManifest = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: uploaded.assetId, project_slug: "test-proj" },
    });
    expect(oldManifest.isError).toBe(true);

    // New asset should exist
    const newManifest = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: parsed.new_asset_id, project_slug: "test-proj" },
    });
    const newParsed = JSON.parse(
      (newManifest.content as Array<{ type: string; text: string }>)[0].text
    );
    expect(newParsed.asset_id).toBe(parsed.new_asset_id);
  });

  it("returns error for nonexistent asset", async () => {
    const result = await client.callTool({
      name: "rename_asset",
      arguments: {
        asset_id: "img-no-such-asset",
        new_name: "whatever",
        project_slug: "test-proj",
      },
    });
    expect(result.isError).toBe(true);
  });
});
