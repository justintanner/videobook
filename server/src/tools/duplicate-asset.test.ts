import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { createFsForTest } from "../fs.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { VideocityFs } from "vc-engine";

describe("duplicate_asset tool", () => {
  let client: Client;
  let tempDir: string;
  let fs: VideocityFs;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-test-"));
    client = await createTestClient(tempDir);
    fs = createFsForTest(tempDir);
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

  it("video duplicate skips in-flight job markers", async () => {
    const created = await fs.createAsset("vid", "in-flight-source", "test-proj");
    if (!created.ok) throw new Error(created.error.message);
    const sourceId = created.value.assetId;
    await fs.writeFile(sourceId, "original.mp4", "fake", "test-proj");
    await fs.writeFile(sourceId, ".kie-task.json", "{}", "test-proj");
    await fs.writeFile(sourceId, ".generation-error.json", "{}", "test-proj");

    const result = await client.callTool({
      name: "duplicate_asset",
      arguments: { asset_id: sourceId, project_slug: "test-proj" },
    });
    const parsed = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text,
    );
    const newId = parsed.new_asset_id as string;
    const newDir = join(tempDir, "test-proj", newId);
    await expect(access(join(newDir, ".kie-task.json"))).rejects.toThrow();
    await expect(access(join(newDir, ".generation-error.json"))).rejects.toThrow();
  });
});

