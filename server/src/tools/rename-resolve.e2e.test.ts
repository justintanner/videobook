import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { queue } from "../queue.js";
import type { Client } from "@modelcontextprotocol/client";
import { createEngineForTest } from "../fs.js";
import type { Engine } from "videobook-engine";

const PROJECT = "e2e-rename-resolve";

describe("rename and resolve e2e", () => {
  let client: Client;
  let tempDir: string;
  let fs: Engine;

  beforeAll(async () => {
    await queue.start();
    tempDir = await mkdtemp(join(tmpdir(), "videocity-e2e-rename-"));
    client = await createTestClient(tempDir);
    fs = createEngineForTest(tempDir);

    const createResult = await client.callTool({
      name: "create_project",
      arguments: { book_id: PROJECT },
    });
    expect(createResult.isError).toBeFalsy();
  });

  afterAll(async () => {
    await client?.close();
    await queue.stop();
    if (tempDir) await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("keeps stable identity while replacing the active slug", async () => {
    const assetRes = await fs.artifacts.create("img", "original-name");
    expect(assetRes.ok).toBe(true);
    const originalId = assetRes.ok ? assetRes.value.slug : "";
    const artifactId = assetRes.ok ? assetRes.value.artifactId : "";

    await fs.files.write(originalId, "original.png", Buffer.from("fake data"));

    const renameRes = await client.callTool({
      name: "rename_asset",
      arguments: {
        asset_id: originalId,
        new_name: "new name",
        book_id: PROJECT,
      },
    });
    expect(renameRes.isError).toBeFalsy();
    const parsed = JSON.parse((renameRes.content as Array<Record<string, unknown>>)[0].text as string);
    const newId = parsed.new_asset_id;
    expect(newId).not.toBe(originalId);

    expect(fs.artifacts.resolveSlug(PROJECT).ok).toBe(false);
    const renamed = fs.artifacts.get(PROJECT);
    expect(renamed.ok).toBe(true);
    expect(renamed.ok && renamed.value.slug).toBe(newId);

    const readRes = await fs.files.read(artifactId, "original.png");
    expect(readRes.ok).toBe(true);
    expect(readRes.ok && readRes.value.toString()).toBe("fake data");

    const manifest = await fs.files.manifest(artifactId);
    expect(manifest.ok).toBe(true);
  });
});
