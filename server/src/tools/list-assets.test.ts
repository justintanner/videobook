import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/client";
import { isUuidV7 } from "videobook-engine";

const MINIMAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
  "base64",
);

describe("list_assets tool", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-test-"));
    client = await createTestClient(tempDir);
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("returns no artifacts for a new book", async () => {
    const slug = "list-empty";
    await client.callTool({
      name: "create_project",
      arguments: { book_id: slug },
    });

    const result = await client.callTool({
      name: "list_assets",
      arguments: { book_id: slug },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text);
    expect(data.assets).toEqual([]);
    expect(data.page).toEqual({
      offset: 0,
      limit: 200,
      total: 0,
      hasMore: false,
    });
  });

  it("lists uploaded assets", async () => {
    const slug = "list-uploaded";
    await client.callTool({
      name: "create_project",
      arguments: { book_id: slug },
    });

    const pngData = MINIMAL_PNG.toString("base64");
    await client.callTool({
      name: "upload_file",
      arguments: { book_id: slug, filename: "photo.png", data: pngData },
    });
    await client.callTool({
      name: "upload_file",
      arguments: { book_id: slug, filename: "script.md", data: Buffer.from("# Hello").toString("base64") },
    });

    const result = await client.callTool({
      name: "list_assets",
      arguments: { book_id: slug },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text);
    expect(data.assets).toHaveLength(2);
    // Ids are UUIDv7 artifact ids now — media kind lives on `type`, never in a
    // prefix.
    const rows = data.assets as Array<{ id: string; artifact_id: string; type: string }>;
    for (const row of rows) {
      expect(isUuidV7(row.id)).toBe(true);
      expect(row.artifact_id).toBe(row.id);
    }
    const types = rows.map((row) => row.type);
    expect(types).toContain("image");
    expect(types).toContain("script");
    const pageResult = await client.callTool({
      name: "list_assets",
      arguments: { book_id: slug, sort: "newest", limit: 1, offset: 1 },
    });
    const pageContent = pageResult.content as Array<{ type: string; text: string }>;
    const page = JSON.parse(pageContent[0].text);
    expect(page.assets).toHaveLength(1);
    expect(page.page).toEqual({
      offset: 1,
      limit: 1,
      total: 2,
      hasMore: false,
    });
  });

  it("sorts newest vs oldest", async () => {
    const slug = "list-sort";
    await client.callTool({
      name: "create_project",
      arguments: { book_id: slug },
    });

    const pngData = MINIMAL_PNG.toString("base64");
    const firstResult = await client.callTool({
      name: "upload_file",
      arguments: { book_id: slug, filename: "first.png", data: pngData },
    });
    const firstParsed = JSON.parse(
      (firstResult.content as Array<{ type: string; text: string }>)[0].text,
    );
    await new Promise((resolve) => setTimeout(resolve, 2));
    const secondResult = await client.callTool({
      name: "upload_file",
      arguments: { book_id: slug, filename: "second.png", data: pngData },
    });
    const secondParsed = JSON.parse(
      (secondResult.content as Array<{ type: string; text: string }>)[0].text,
    );

    const newestResult = await client.callTool({
      name: "list_assets",
      arguments: { book_id: slug, sort: "newest" },
    });
    const newestContent = newestResult.content as Array<{ type: string; text: string }>;
    const newestData = JSON.parse(newestContent[0].text);
    const newestIds = newestData.assets
      .filter((a: { type: string }) => a.type !== "notebook")
      .map((a: { id: string }) => a.id);

    const oldestResult = await client.callTool({
      name: "list_assets",
      arguments: { book_id: slug, sort: "oldest" },
    });
    const oldestContent = oldestResult.content as Array<{ type: string; text: string }>;
    const oldestData = JSON.parse(oldestContent[0].text);
    const oldestIds = oldestData.assets
      .filter((a: { type: string }) => a.type !== "notebook")
      .map((a: { id: string }) => a.id);

    // Newest should have second asset first, oldest should have first asset first
    expect(newestIds[0]).toBe(secondParsed.assetId);
    expect(newestIds[1]).toBe(firstParsed.assetId);
    expect(oldestIds[0]).toBe(firstParsed.assetId);
    expect(oldestIds[1]).toBe(secondParsed.assetId);
    expect(newestIds).toEqual([...oldestIds].reverse());
  });

  it("include_referenced backfills outputVersionArtifactIds and providerArtifactId", async () => {
    const { createEngineForTest, closeEngineForTest } = await import("../fs.js");
    const { listAssetsDef } = await import("./list-assets.js");
    const root = await mkdtemp(join(tmpdir(), "list-assets-ref-"));
    const engine = createEngineForTest(root);
    try {
      const bookId = engine.book.get().bookId;
      const current = (await engine.artifacts.create("image", "current")).value!;
      const historical = (await engine.artifacts.create("image", "historical")).value!;
      const provider = (await engine.artifacts.create("image", "provider")).value!;
      const png = MINIMAL_PNG;
      for (const artifact of [current, historical, provider]) {
        const written = await engine.files.write(
          artifact.artifactId,
          "original.png",
          png,
        );
        if (!written.ok) throw new Error(written.error.message);
      }
      const notebook = (await engine.notebooks.create("Refs")).value!;
      const cell = engine.notebooks.createCell({
        type: "image",
        slot: { row: 0, column: 0 },
        outputArtifactId: current.artifactId,
        inputs: {
          outputVersionArtifactIds: [
            historical.artifactId,
            current.artifactId,
          ],
          providerArtifactId: provider.artifactId,
        },
      });
      const writtenNotebook = await engine.notebooks.write({
        ...notebook,
        cells: [cell],
        edges: [],
      });
      if (!writtenNotebook.ok) throw new Error(writtenNotebook.error.message);

      // Page only the current artifact; historical + provider must still resolve
      // via include_referenced notebook backfill.
      const pageOnly = await listAssetsDef(engine).handler({
        book_id: bookId,
        sort: "newest",
        limit: 1,
        offset: 0,
        include_referenced: false,
      });
      const pageOnlyData = JSON.parse(
        (pageOnly.content as Array<{ type: string; text: string }>)[0]!.text,
      ) as { assets: Array<{ artifact_id: string }> };
      expect(pageOnlyData.assets).toHaveLength(1);

      const withRefs = await listAssetsDef(engine).handler({
        book_id: bookId,
        sort: "newest",
        limit: 1,
        offset: 0,
        include_referenced: true,
      });
      const withRefsData = JSON.parse(
        (withRefs.content as Array<{ type: string; text: string }>)[0]!.text,
      ) as { assets: Array<{ artifact_id: string }> };
      const ids = new Set(withRefsData.assets.map((asset) => asset.artifact_id));
      expect(ids.has(current.artifactId)).toBe(true);
      expect(ids.has(historical.artifactId)).toBe(true);
      expect(ids.has(provider.artifactId)).toBe(true);
    } finally {
      closeEngineForTest(root, engine);
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
