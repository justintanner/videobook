import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

// Per-test createTestClient + create_project under parallel test load was
// blowing past the 60s hook budget — every per-test call stomps the queue's
// global projectsDir, so concurrent suites race into ENOENT on .project.lock.
describe("asset_manifest tool", () => {
  let client: Client;
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-test-"));
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
    expect(parsed.slug).toBe(uploaded.assetId);
    expect(parsed.fileCount).toBeGreaterThanOrEqual(1);
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
