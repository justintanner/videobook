import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { createEngineForTest } from "../fs.js";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine } from "videobook-engine";

describe("show_folder tool", () => {
  let client: Client;
  let tempDir: string;
  let fs: Engine;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-test-"));
    fs = createEngineForTest(tempDir);
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("show folder for nonexistent asset returns error", async () => {
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "test" },
    });
    const result = await client.callTool({
      name: "show_folder",
      arguments: { asset_id: "img-nonexistent", book_id: "test" },
    });
    expect(result.isError).toBe(true);
  });

  it("show folder for existing asset returns a result without throwing", async () => {
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "test" },
    });
    const assetResult = await fs.artifacts.create("img", "landscape-photo");
    if (!assetResult.ok) throw new Error(assetResult.error.message);
    const assetId = assetResult.value.slug;

    const result = await client.callTool({
      name: "show_folder",
      arguments: { asset_id: assetId, book_id: "test" },
    });
    // On CI/headless, open -R may fail, but the tool should still return a result
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
    expect(content[0].text).toBeDefined();
  });
});
