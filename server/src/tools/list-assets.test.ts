import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/client";
import { isUuidV7 } from "videobook-engine";
import { seedMixedStatusCatalog } from "../../../tests/v2/library-browse-fixture.js";
import { testBudget } from "../test-budget.js";

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
    const rows = data.assets as Array<{
      id: string;
      artifact_id: string;
      type: string;
      object_hash: string | null;
    }>;
    for (const row of rows) {
      expect(isUuidV7(row.id)).toBe(true);
      expect(row.artifact_id).toBe(row.id);
    }
    const types = rows.map((row) => row.type);
    expect(types).toContain("image");
    expect(types).toContain("script");
    expect(rows.find((row) => row.type === "image")?.object_hash).toMatch(/^[a-f0-9]+$/);
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

  it("projects the transcript and vision analysis onto video assets", async () => {
    const { createEngineForTest, closeEngineForTest } = await import("../engine.js");
    const { listAssetsDef } = await import("./list-assets.js");
    const root = await mkdtemp(join(tmpdir(), "list-assets-transcript-"));
    const engine = createEngineForTest(root);
    try {
      const bookId = engine.book.get().bookId;
      const created = await engine.artifacts.create("video", "clip");
      if (!created.ok) throw new Error(created.error.message);
      const artifactId = created.value.artifactId;
      const writes = await Promise.all([
        engine.files.write(artifactId, "original.mp4", Buffer.from("fake-video")),
        engine.files.write(artifactId, "elevenlabs.json", JSON.stringify({
          language_code: "eng",
          text: "Hello world",
          words: [
            { text: "Hello", start: 0, end: 0.5, type: "word", speaker_id: "spk_0" },
            { text: " ", start: 0.5, end: 0.6, type: "spacing", speaker_id: null },
            { text: "world", start: 0.6, end: 1, type: "word", speaker_id: "spk_0" },
          ],
        })),
        engine.files.write(artifactId, ".original.analysis.json", JSON.stringify({
          summary: "A greeting.",
          scenes: [{ timestamp: 0, description: "Greeting", tags: ["hello"] }],
          tags: ["hello"],
          mood: "warm",
          subjects: ["speaker"],
          setting: "a room",
        })),
      ]);
      for (const write of writes) {
        if (!write.ok) throw new Error(write.error.message);
      }

      const result = await listAssetsDef(engine).handler({
        book_id: bookId,
        sort: "newest",
      });
      const data = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0]!.text,
      ) as {
        assets: Array<{
          artifact_id: string;
          transcript: unknown;
          vision_analysis: unknown;
        }>;
      };
      const row = data.assets.find((asset) => asset.artifact_id === artifactId);
      expect(row?.transcript).toEqual({
        elevenlabs: {
          kind: "timed",
          language_code: "eng",
          text: "Hello world",
          word_count: 2,
          words: [
            { text: "Hello", start: 0, end: 0.5 },
            { text: "world", start: 0.6, end: 1 },
          ],
        },
        plain: null,
      });
      expect(JSON.stringify(row?.transcript)).not.toContain("speaker_id");
      expect(row?.vision_analysis).toEqual({
        summary: "A greeting.",
        mood: "warm",
        setting: "a room",
        tags: ["hello"],
        subjects: ["speaker"],
        scene_count: 1,
      });
    } finally {
      closeEngineForTest(root, engine);
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it("leaves transcript and vision analysis null for un-transcribed assets", async () => {
    const { createEngineForTest, closeEngineForTest } = await import("../engine.js");
    const { listAssetsDef } = await import("./list-assets.js");
    const root = await mkdtemp(join(tmpdir(), "list-assets-no-transcript-"));
    const engine = createEngineForTest(root);
    try {
      const bookId = engine.book.get().bookId;
      const created = await engine.artifacts.create("video", "silent-clip");
      if (!created.ok) throw new Error(created.error.message);
      const written = await engine.files.write(
        created.value.artifactId,
        "original.mp4",
        Buffer.from("fake-video"),
      );
      if (!written.ok) throw new Error(written.error.message);

      const result = await listAssetsDef(engine).handler({
        book_id: bookId,
        sort: "newest",
      });
      const data = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0]!.text,
      ) as {
        assets: Array<{
          artifact_id: string;
          transcript: unknown;
          vision_analysis: unknown;
        }>;
      };
      const row = data.assets.find((asset) =>
        asset.artifact_id === created.value.artifactId);
      expect(row?.transcript).toBeNull();
      expect(row?.vision_analysis).toBeNull();
    } finally {
      closeEngineForTest(root, engine);
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it("include_referenced backfills outputVersionArtifactIds and providerArtifactId", async () => {
    const { createEngineForTest, closeEngineForTest } = await import("../engine.js");
    const { listAssetsDef } = await import("./list-assets.js");
    const root = await mkdtemp(join(tmpdir(), "list-assets-ref-"));
    const engine = createEngineForTest(root);
    try {
      const bookId = engine.book.get().bookId;
      const currentCreated = await engine.artifacts.create("image", "current");
      const historicalCreated = await engine.artifacts.create("image", "historical");
      const providerCreated = await engine.artifacts.create("image", "provider");
      if (!currentCreated.ok || !historicalCreated.ok || !providerCreated.ok) {
        throw new Error("fixture artifact creation failed");
      }
      const current = currentCreated.value;
      const historical = historicalCreated.value;
      const provider = providerCreated.value;
      const png = MINIMAL_PNG;
      for (const artifact of [current, historical, provider]) {
        const written = await engine.files.write(
          artifact.artifactId,
          "original.png",
          png,
        );
        if (!written.ok) throw new Error(written.error.message);
      }
      const notebookCreated = await engine.notebooks.create("Refs");
      if (!notebookCreated.ok) throw new Error(notebookCreated.error.message);
      const notebook = notebookCreated.value;
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

  it("filters Library browse status before paging a mixed catalog larger than one page", async () => {
    const { createEngineForTest, closeEngineForTest } = await import("../engine.js");
    const { listAssetsDef } = await import("./list-assets.js");
    const root = await mkdtemp(join(tmpdir(), "list-assets-browse-status-"));
    const engine = createEngineForTest(root);
    try {
      const bookId = engine.book.get().bookId;
      const catalog = await seedMixedStatusCatalog(engine, {
        ready: 24,
        error: 120,
        processing: 110,
      });
      const listedNotebook = await engine.notebooks.create("Browse notes");
      if (!listedNotebook.ok) throw new Error(listedNotebook.error.message);
      const prompt = await engine.artifacts.create({ kind: "prompt", label: "Notebook text" });
      if (!prompt.ok) throw new Error(prompt.error.message);

      const handler = listAssetsDef(engine).handler;
      const parse = async (args: Record<string, unknown>) => {
        const result = await handler({ book_id: bookId, ...args });
        return JSON.parse(
          (result.content as Array<{ type: string; text: string }>)[0]!.text,
        ) as {
          assets: Array<{ artifact_id: string; status: string; type: string }>;
          page: {
            offset: number;
            limit: number;
            total: number;
            hasMore: boolean;
          };
          status_counts: {
            ready: number;
            processing: number;
            error: number;
          };
        };
      };

      const unfiltered = await parse({ sort: "newest", limit: 200, offset: 0 });
      const unfilteredIds = unfiltered.assets.map((asset) => asset.artifact_id);
      expect(unfiltered.page).toEqual({
        offset: 0,
        limit: 200,
        total: unfiltered.page.total,
        hasMore: true,
      });
      expect(unfiltered.page.total).toBeGreaterThan(200);
      expect(unfiltered.assets.some((asset) => asset.type === "notebook")).toBe(true);
      expect(unfilteredIds).toContain(prompt.value.artifactId);
      expect(unfilteredIds.filter((id) => catalog.ready.includes(id))).toEqual([]);
      expect(unfiltered.status_counts).toEqual({
        ready: catalog.ready.length,
        processing: catalog.processing.length,
        error: catalog.error.length,
      });

      const readyPage = await parse({
        sort: "newest",
        limit: 10,
        offset: 0,
        browse_status: "ready",
      });
      expect(readyPage.assets.length).toBeGreaterThan(0);
      expect(readyPage.assets.every((asset) => asset.status === "ready")).toBe(true);
      expect(readyPage.assets.every((asset) => asset.type !== "notebook")).toBe(true);
      expect(readyPage.page).toEqual({
        offset: 0,
        limit: 10,
        total: catalog.ready.length,
        hasMore: true,
      });
      expect(readyPage.status_counts).toEqual(unfiltered.status_counts);

      const readyIds: string[] = [];
      let offset = 0;
      let hasMore = true;
      while (hasMore) {
        const page = await parse({
          sort: "newest",
          limit: 10,
          offset,
          browse_status: "ready",
        });
        readyIds.push(...page.assets.map((asset) => asset.artifact_id));
        hasMore = page.page.hasMore;
        offset += page.assets.length;
        if (page.assets.length === 0) break;
      }
      expect(new Set(readyIds).size).toBe(readyIds.length);
      expect([...readyIds].sort()).toEqual([...catalog.ready].sort());
      expect(offset).toBe(catalog.ready.length);

      const errors = await parse({ browse_status: "error", limit: 500 });
      expect(errors.page.total).toBe(catalog.error.length);
      expect(errors.assets.every((asset) => asset.status === "error")).toBe(true);
      expect(errors.assets.map((asset) => asset.artifact_id).sort())
        .toEqual([...catalog.error].sort());

      const processing = await parse({ browse_status: "processing", limit: 500 });
      expect(processing.page.total).toBe(catalog.processing.length);
      expect(processing.assets.every((asset) => (
        asset.status !== "ready" && asset.status !== "error"
      ))).toBe(true);

      const allMedia = await parse({ browse_status: "all", limit: 500 });
      expect(allMedia.page.total).toBe(
        catalog.ready.length + catalog.error.length + catalog.processing.length,
      );
      expect(allMedia.assets.every((asset) => asset.type !== "notebook")).toBe(true);
      expect(allMedia.assets.some((asset) => asset.artifact_id === prompt.value.artifactId)).toBe(false);

      const emptyPage = await parse({
        browse_status: "ready",
        limit: 10,
        offset: catalog.ready.length,
      });
      expect(emptyPage.assets).toEqual([]);
      expect(emptyPage.page).toEqual({
        offset: catalog.ready.length,
        limit: 10,
        total: catalog.ready.length,
        hasMore: false,
      });
    } finally {
      closeEngineForTest(root, engine);
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  }, testBudget(120_000));

  it("keeps referenced hydration when Library browse filters the page", async () => {
    const { createEngineForTest, closeEngineForTest } = await import("../engine.js");
    const { listAssetsDef } = await import("./list-assets.js");
    const root = await mkdtemp(join(tmpdir(), "list-assets-browse-refs-"));
    const engine = createEngineForTest(root);
    try {
      const bookId = engine.book.get().bookId;
      const catalog = await seedMixedStatusCatalog(engine, {
        ready: 1,
        error: 1,
        processing: 0,
      });
      const notebookCreated = await engine.notebooks.create("Ready page refs");
      if (!notebookCreated.ok) throw new Error(notebookCreated.error.message);
      const cell = engine.notebooks.createCell({
        type: "image",
        slot: { row: 0, column: 0 },
        outputArtifactId: catalog.error[0],
      });
      const writtenNotebook = await engine.notebooks.write({
        ...notebookCreated.value,
        cells: [cell],
        edges: [],
      });
      if (!writtenNotebook.ok) throw new Error(writtenNotebook.error.message);

      const result = await listAssetsDef(engine).handler({
        book_id: bookId,
        sort: "newest",
        limit: 10,
        browse_status: "ready",
        include_referenced: true,
      });
      const data = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0]!.text,
      ) as {
        assets: Array<{ artifact_id: string; status: string }>;
        page: { total: number; hasMore: boolean };
      };
      expect(data.page.total).toBe(1);
      expect(data.page.hasMore).toBe(false);
      const ids = data.assets.map((asset) => asset.artifact_id);
      expect(ids).toContain(catalog.ready[0]);
      expect(ids).toContain(catalog.error[0]);
    } finally {
      closeEngineForTest(root, engine);
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it("walks three Ready pages using the Library Load more offset", async () => {
    const { createEngineForTest, closeEngineForTest } = await import("../engine.js");
    const { listAssetsDef } = await import("./list-assets.js");
    const root = await mkdtemp(join(tmpdir(), "list-assets-ready-pages-"));
    const engine = createEngineForTest(root);
    try {
      const bookId = engine.book.get().bookId;
      const catalog = await seedMixedStatusCatalog(engine, {
        ready: 250,
        error: 0,
        processing: 0,
      });
      const handler = listAssetsDef(engine).handler;
      const parse = async (offset: number) => {
        const result = await handler({
          book_id: bookId,
          sort: "newest",
          limit: 100,
          offset,
          browse_status: "ready",
        });
        return JSON.parse(
          (result.content as Array<{ type: string; text: string }>)[0]!.text,
        ) as {
          assets: Array<{ artifact_id: string; status: string }>;
          page: { offset: number; hasMore: boolean; total: number };
        };
      };
      const loaded: string[] = [];
      const offsets: number[] = [];
      let hasMore = true;
      while (hasMore) {
        const offset = loaded.length;
        offsets.push(offset);
        const page = await parse(offset);
        loaded.push(...page.assets.map((asset) => asset.artifact_id));
        hasMore = page.page.hasMore;
        if (page.assets.length === 0) break;
      }
      expect(offsets).toEqual([0, 100, 200]);
      expect(offsets[2]).not.toBe(300);
      expect(new Set(loaded).size).toBe(loaded.length);
      expect(loaded).toHaveLength(catalog.ready.length);
      expect([...loaded].sort()).toEqual([...catalog.ready].sort());
    } finally {
      closeEngineForTest(root, engine);
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  }, testBudget(120_000));
});
