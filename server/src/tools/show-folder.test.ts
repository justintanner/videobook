import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { createFsForTest } from "../fs.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ClipfirstFs } from "clipfirst-engine";

describe("show_folder tool", () => {
  let client: Client;
  let tempDir: string;
  let fs: ClipfirstFs;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-test-"));
    fs = createFsForTest(tempDir);
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("show folder for nonexistent asset returns error", async () => {
    client = await createTestClient(tempDir);
    await fs.createProject("test");
    const result = await client.callTool({
      name: "show_folder",
      arguments: { asset_id: "img-nonexistent", project_slug: "test" },
    });
    expect(result.isError).toBe(true);
  });

  it("show folder for existing asset returns a result without throwing", async () => {
    client = await createTestClient(tempDir);
    await fs.createProject("test");
    const assetResult = await fs.createAsset("img", "landscape-photo", "test");
    if (!assetResult.ok) throw new Error(assetResult.error.message);
    const assetId = assetResult.value.assetId;

    const result = await client.callTool({
      name: "show_folder",
      arguments: { asset_id: assetId, project_slug: "test" },
    });
    // On CI/headless, open -R may fail, but the tool should still return a result
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
    expect(content[0].text).toBeDefined();
  });
});
