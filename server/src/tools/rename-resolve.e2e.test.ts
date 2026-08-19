import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { queue } from "../queue.js";
import type { Client } from "@modelcontextprotocol/client";
import { createEngineForTest } from "../engine.js";
import type { Engine } from "videobook-engine";

const PROJECT = "e2e-rename-resolve";

type TextContent = Array<{ type: string; text: string }>;

interface RenamePayload {
  artifact_id: string;
  label: string;
}

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

  it("relabels in place so the artifact id and every reference still resolve", async () => {
    const assetRes = await fs.artifacts.create("img", "original-name");
    expect(assetRes.ok).toBe(true);
    if (!assetRes.ok) throw new Error(assetRes.error.message);
    const artifactId = assetRes.value.artifactId;

    const written = await fs.files.write(artifactId, "original.png", Buffer.from("fake data"));
    expect(written.ok).toBe(true);

    const renameRes = await client.callTool({
      name: "rename_asset",
      arguments: {
        asset_id: artifactId,
        new_name: "new name",
        book_id: PROJECT,
      },
    });
    expect(renameRes.isError).toBeFalsy();
    const parsed = JSON.parse(
      (renameRes.content as TextContent)[0].text,
    ) as RenamePayload;

    // A rename is a display-label change only: the id is the reference handle
    // and never moves, so nothing downstream has to be re-resolved.
    expect(parsed.artifact_id).toBe(artifactId);
    expect(parsed.label).toBe("new name");

    const renamed = fs.artifacts.get(artifactId);
    expect(renamed.ok).toBe(true);
    expect(renamed.ok && renamed.value.artifactId).toBe(artifactId);
    expect(renamed.ok && renamed.value.label).toBe("new name");
    expect(renamed.ok && renamed.value.kind).toBe("image");

    const readRes = await fs.files.read(artifactId, "original.png");
    expect(readRes.ok).toBe(true);
    expect(readRes.ok && readRes.value.toString()).toBe("fake data");

    const manifest = await fs.files.manifest(artifactId);
    expect(manifest.ok).toBe(true);
    expect(manifest.ok && manifest.value.files.map((file) => file.name))
      .toContain("original.png");

    // The catalog still lists exactly one artifact for this id — a relabel
    // never forks a second catalog row.
    expect(fs.artifacts.list().filter((artifact) => artifact.artifactId === artifactId))
      .toHaveLength(1);
  });
});
