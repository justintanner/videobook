import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { queue } from "../queue.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createFsForTest } from "../fs.js";
import type { VideocityFs } from "videocity-engine";

const PROJECT = "e2e-rename-resolve";

describe("rename and resolve e2e", () => {
  let client: Client;
  let tempDir: string;
  let fs: VideocityFs;

  beforeAll(async () => {
    await queue.start();
    tempDir = await mkdtemp(join(tmpdir(), "videocity-e2e-rename-"));
    client = await createTestClient(tempDir);
    fs = createFsForTest(tempDir);

    const createResult = await client.callTool({
      name: "create_project",
      arguments: { project_slug: PROJECT },
    });
    expect(createResult.isError).toBeFalsy();
  });

  afterAll(async () => {
    await client?.close();
    await queue.stop();
    if (tempDir) await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("can resolve a renamed asset directory", async () => {
    // Create an asset
    const assetRes = await fs.createAsset("img", "original-name", PROJECT);
    expect(assetRes.ok).toBe(true);
    const originalId = assetRes.ok ? assetRes.value.assetId : "";

    // Write a dummy file
    await fs.writeFile(originalId, "original.png", Buffer.from("fake data"), PROJECT);

    // Rename it via tool
    const renameRes = await client.callTool({
      name: "rename_asset",
      arguments: {
        asset_id: originalId,
        new_name: "new name",
        project_slug: PROJECT,
      },
    });
    expect(renameRes.isError).toBeFalsy();
    const parsed = JSON.parse((renameRes.content as Array<Record<string, unknown>>)[0].text as string);
    const newId = parsed.new_asset_id;
    expect(newId).not.toBe(originalId);

    // Now try to read the file using the ORIGINAL id.
    // The engine's resolveAssetDir should transparently follow the alias.
    const readRes = await fs.readFile(originalId, "original.png", PROJECT);
    if (!readRes.ok) console.error(readRes.error);
    expect(readRes.ok).toBe(true);
    expect(readRes.ok && readRes.value.toString()).toBe("fake data");
    
    // Also check getManifest
    const manifest = await fs.getManifest(originalId, PROJECT);
    expect(manifest.ok).toBe(true);
  });
});
