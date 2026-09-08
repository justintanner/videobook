import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Client } from "@modelcontextprotocol/client";
import { createTestClient } from "../test-client.js";

type ToolContent = Array<{ type: string; text: string }>;

function payload(result: { content: unknown }): Record<string, never> & {
  [key: string]: unknown;
} {
  return JSON.parse((result.content as ToolContent)[0].text);
}

/** Every file under the book's content store, by bare hex name. */
async function storedObjects(root: string): Promise<Set<string>> {
  const found = new Set<string>();
  const walk = async (path: string): Promise<void> => {
    const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
        continue;
      }
      if (path.includes(`${join("data", "objects")}`)) found.add(entry.name);
    }
  };
  await walk(root);
  return found;
}

function bareHash(objectHash: string): string {
  return objectHash.includes(":")
    ? objectHash.slice(objectHash.lastIndexOf(":") + 1)
    : objectHash;
}

describe("forget_asset tool", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videobook-forget-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "test-proj" },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function upload(filename: string, bytes: string): Promise<{
    assetId: string;
    artifactId: string;
  }> {
    const result = await client.callTool({
      name: "upload_file",
      arguments: {
        book_id: "test-proj",
        filename,
        data: Buffer.from(bytes).toString("base64"),
      },
    });
    return payload(result) as unknown as { assetId: string; artifactId: string };
  }

  async function manifestHashes(assetId: string): Promise<string[]> {
    const result = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: assetId, book_id: "test-proj" },
    });
    const manifest = payload(result) as unknown as {
      files: Array<{ objectHash: string }>;
    };
    return manifest.files.map((file) => bareHash(file.objectHash));
  }

  async function forget(
    assetId: string,
    clearReferences = false,
  ): Promise<Record<string, unknown>> {
    const result = await client.callTool({
      name: "forget_asset",
      arguments: {
        book_id: "test-proj",
        asset_id: assetId,
        ...(clearReferences ? { clear_references: true } : {}),
      },
    });
    expect(result.isError, (result.content as ToolContent)[0]?.text).toBeFalsy();
    return payload(result);
  }

  it("destroys the content behind an unreferenced asset", async () => {
    const uploaded = await upload("photo.png", "forget-me-bytes");
    const hashes = await manifestHashes(uploaded.assetId);
    expect(hashes.length).toBeGreaterThan(0);
    const before = await storedObjects(tempDir);
    expect(hashes.every((hash) => before.has(hash))).toBe(true);

    const outcome = await forget(uploaded.assetId);
    expect(outcome.status).toBe("forgotten");
    expect(outcome.artifact_id).toBe(uploaded.artifactId);
    expect(outcome.forgotten_objects).toBe(hashes.length);
    expect(outcome.shared_objects).toBe(0);
    expect(outcome.reclaimed_bytes as number).toBeGreaterThan(0);

    const after = await storedObjects(tempDir);
    expect(hashes.some((hash) => after.has(hash))).toBe(false);
    const manifest = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: uploaded.assetId, book_id: "test-proj" },
    });
    expect(manifest.isError).toBe(true);
  });

  it("keeps bytes a second asset stores", async () => {
    const kept = await upload("first.png", "shared-bytes");
    const doomed = await upload("second.png", "shared-bytes");
    const keptHashes = await manifestHashes(kept.assetId);
    const doomedHashes = await manifestHashes(doomed.assetId);
    expect(doomedHashes).toEqual(keptHashes);

    const outcome = await forget(doomed.assetId);
    expect(outcome.status).toBe("forgotten");
    expect(outcome.shared_objects).toBe(keptHashes.length);
    expect(outcome.forgotten_objects).toBe(0);
    expect(outcome.reclaimed_bytes).toBe(0);

    const after = await storedObjects(tempDir);
    expect(keptHashes.every((hash) => after.has(hash))).toBe(true);
    const manifest = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: kept.assetId, book_id: "test-proj" },
    });
    expect(manifest.isError).toBeFalsy();
  });

  it("reports the notebook cell holding an asset, then forgets it on request", async () => {
    const uploaded = await upload("held.png", "cell-held-bytes");
    const hashes = await manifestHashes(uploaded.assetId);
    const notebook = payload(await client.callTool({
      name: "create_notebook",
      arguments: { book_id: "test-proj", name: "holder" },
    })) as unknown as { id: string };
    const cell = payload(await client.callTool({
      name: "create_notebook_cell",
      arguments: {
        book_id: "test-proj",
        notebook_id: notebook.id,
        cell: { type: "image", slot: { row: 1, column: 1 } },
      },
    })) as unknown as { cell_id?: string; id?: string };
    const cellId = cell.cell_id ?? cell.id ?? "";
    expect(cellId).not.toBe("");
    await client.callTool({
      name: "update_notebook_cell",
      arguments: {
        book_id: "test-proj",
        notebook_id: notebook.id,
        cell_id: cellId,
        cell: { output_artifact_id: uploaded.artifactId },
      },
    });

    const refused = await forget(uploaded.assetId);
    expect(refused.status).toBe("in_use");
    expect(refused.cleared_cells).toBe(0);
    expect(refused.references).toContainEqual({
      kind: "cell.outputArtifact",
      id: `${notebook.id}/${cellId}`,
    });
    const stillThere = await storedObjects(tempDir);
    expect(hashes.every((hash) => stillThere.has(hash))).toBe(true);

    const forgotten = await forget(uploaded.assetId, true);
    expect(forgotten.status).toBe("forgotten");
    expect(forgotten.cleared_cells).toBe(1);
    const after = await storedObjects(tempDir);
    expect(hashes.some((hash) => after.has(hash))).toBe(false);
    const document = payload(await client.callTool({
      name: "get_notebook",
      arguments: { book_id: "test-proj", notebook_id: notebook.id },
    })) as unknown as {
      cells: Array<{ id: string; outputArtifactId?: string }>;
    };
    expect(document.cells.find((entry) => entry.id === cellId)?.outputArtifactId)
      .toBeUndefined();
  });

  it("clears a timeline clip before forgetting", async () => {
    const uploaded = await upload("clip.png", "timeline-bytes");
    const assigned = await client.callTool({
      name: "assign_slot",
      arguments: { book_id: "test-proj", slot: "s01", asset_id: uploaded.assetId },
    });
    expect(assigned.isError).toBeFalsy();
    const refused = await forget(uploaded.assetId);
    expect(refused.status).toBe("in_use");
    expect((refused.references as Array<{ kind: string }>).some((reference) =>
      reference.kind === "sequenceClip")).toBe(true);

    const forgotten = await forget(uploaded.assetId, true);
    expect(forgotten.status).toBe("forgotten");
    const timeline = payload(await client.callTool({
      name: "get_timeline",
      arguments: { book_id: "test-proj" },
    })) as unknown as { slots: unknown[] };
    expect(timeline.slots).toEqual([]);
  });

  it("lets the same bytes be imported again after a forget", async () => {
    const first = await upload("again.png", "reimported-bytes");
    const hashes = await manifestHashes(first.assetId);
    const forgotten = await forget(first.assetId);
    expect(forgotten.status).toBe("forgotten");

    const second = await upload("again.png", "reimported-bytes");
    expect(second.artifactId).not.toBe(first.artifactId);
    expect(await manifestHashes(second.assetId)).toEqual(hashes);
    const stored = await storedObjects(tempDir);
    expect(hashes.every((hash) => stored.has(hash))).toBe(true);
  });

  it("leaves the workspace directory gone", async () => {
    const uploaded = await upload("gone.png", "workspace-bytes");
    const outcome = await forget(uploaded.assetId);
    expect(outcome.status).toBe("forgotten");
    const workspaces = join(tempDir, "workspaces", uploaded.artifactId);
    await expect(stat(workspaces)).rejects.toThrow();
  });
});
