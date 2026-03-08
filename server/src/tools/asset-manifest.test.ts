import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

describe("asset_manifest tool", () => {
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

  it("returns file list for an asset", async () => {
    const data = Buffer.from("fake-png-data").toString("base64");
    const uploadResult = await client.callTool({
      name: "upload_file",
      arguments: { project_slug: "test-proj", filename: "photo.png", data },
    });
    const uploaded = JSON.parse(
      (uploadResult.content as Array<{ type: string; text: string }>)[0].text
    );

    const result = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: uploaded.assetId, project_slug: "test-proj" },
    });

    const parsed = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text
    );
    expect(parsed.asset_id).toBe(uploaded.assetId);
    expect(parsed.file_count).toBeGreaterThanOrEqual(1);
    expect(parsed.files.some((f: { name: string }) => f.name === "original.png")).toBe(true);
  });

  it("returns error for nonexistent asset", async () => {
    const result = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: "img-no-such-asset", project_slug: "test-proj" },
    });
    expect(result.isError).toBe(true);
  });
});
