import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { createEngineForTest } from "../fs.js";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine } from "videobook-engine";

describe("duplicate_asset tool", () => {
  let client: Client;
  let tempDir: string;
  let fs: Engine;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-test-"));
    client = await createTestClient(tempDir);
    fs = createEngineForTest(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "test-proj" },
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
      arguments: { book_id: "test-proj", filename: "photo.png", data },
    });
    const uploaded = JSON.parse(
      (uploadResult.content as Array<{ type: string; text: string }>)[0].text
    );

    const result = await client.callTool({
      name: "duplicate_asset",
      arguments: { asset_id: uploaded.assetId, book_id: "test-proj" },
    });

    const parsed = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text
    );
    expect(parsed.source_asset_id).toBe(uploaded.assetId);
    const copy = fs.artifacts.get(parsed.new_asset_id);
    expect(copy.ok && copy.value.kind).toBe("image");
    expect(parsed.new_asset_id).not.toBe(uploaded.assetId);

    // Verify copy has the same file
    const manifest = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: parsed.new_asset_id, book_id: "test-proj" },
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
      arguments: { book_id: "test-proj", filename: "photo.png", data },
    });
    const uploaded = JSON.parse(
      (uploadResult.content as Array<{ type: string; text: string }>)[0].text
    );

    const result = await client.callTool({
      name: "duplicate_asset",
      arguments: {
        asset_id: uploaded.assetId,
        book_id: "test-proj",
        new_name: "my custom copy",
      },
    });

    const parsed = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text
    );
    const copy = fs.artifacts.get(parsed.new_asset_id);
    expect(copy.ok && copy.value.kind).toBe("image");
    expect(copy.ok && copy.value.label).toBe("my custom copy");
  });

  it("returns error for nonexistent asset", async () => {
    const result = await client.callTool({
      name: "duplicate_asset",
      arguments: { asset_id: "img-no-such-asset", book_id: "test-proj" },
    });
    expect(result.isError).toBe(true);
  });

  it("video duplicate skips in-flight job markers", async () => {
    const created = await fs.artifacts.create("vid", "in-flight-source");
    if (!created.ok) throw new Error(created.error.message);
    const sourceId = created.value.artifactId;
    await fs.files.write(sourceId, "original.mp4", "fake");
    await fs.files.write(sourceId, ".kie-task.json", "{}");
    await fs.files.write(sourceId, ".generation-error.json", "{}");

    const result = await client.callTool({
      name: "duplicate_asset",
      arguments: { asset_id: sourceId, book_id: "test-proj" },
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

