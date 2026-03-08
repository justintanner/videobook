import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

describe("duplicate_asset tool", () => {
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

  it("duplicates an asset with same files", async () => {
    const data = Buffer.from("fake-png-data").toString("base64");
    const uploadResult = await client.callTool({
      name: "upload_file",
      arguments: { project_slug: "test-proj", filename: "photo.png", data },
    });
    const uploaded = JSON.parse(
      (uploadResult.content as Array<{ type: string; text: string }>)[0].text
    );

    const result = await client.callTool({
      name: "duplicate_asset",
      arguments: { asset_id: uploaded.assetId, project_slug: "test-proj" },
    });

    const parsed = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text
    );
    expect(parsed.source_asset_id).toBe(uploaded.assetId);
    expect(parsed.new_asset_id).toMatch(/^img-/);
    expect(parsed.new_asset_id).not.toBe(uploaded.assetId);

    // Verify copy has the same file
    const manifest = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: parsed.new_asset_id, project_slug: "test-proj" },
    });
    const manifestParsed = JSON.parse(
      (manifest.content as Array<{ type: string; text: string }>)[0].text
    );
    expect(manifestParsed.files.some((f: { name: string }) => f.name === "original.png")).toBe(true);
  });

  it("duplicates with a custom name", async () => {
    const data = Buffer.from("fake-png-data").toString("base64");
    const uploadResult = await client.callTool({
      name: "upload_file",
      arguments: { project_slug: "test-proj", filename: "photo.png", data },
    });
    const uploaded = JSON.parse(
      (uploadResult.content as Array<{ type: string; text: string }>)[0].text
    );

    const result = await client.callTool({
      name: "duplicate_asset",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "test-proj",
        new_name: "my custom copy",
      },
    });

    const parsed = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text
    );
    expect(parsed.new_asset_id).toMatch(/^img-/);
  });

  it("returns error for nonexistent asset", async () => {
    const result = await client.callTool({
      name: "duplicate_asset",
      arguments: { asset_id: "img-no-such-asset", project_slug: "test-proj" },
    });
    expect(result.isError).toBe(true);
  });
});
