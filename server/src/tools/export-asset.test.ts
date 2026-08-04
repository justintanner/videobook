import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ManagedBook } from "../book-manager.js";
import { BookManager } from "../book-manager.js";
import { registerAllJobHandlers } from "../jobs/index.js";
import { queue, setEngineRoot } from "../queue.js";
import { exportAssetDef } from "./export-asset.js";
import type { ToolDef } from "./tool-def.js";

type ExportResult = {
  source_asset_id: string;
  new_asset_id: string;
  source_project: string;
  target_project: string;
  source_artifact_id: string;
  target_artifact_id: string;
  source_book_id: string;
  target_book_id: string;
};

function parse(result: Awaited<ReturnType<ToolDef["handler"]>>): ExportResult {
  return JSON.parse(result.content[0]!.text) as ExportResult;
}

describe("export_asset_to_project tool", () => {
  let books: BookManager;
  let definition: ToolDef;
  let source: ManagedBook;
  let target: ManagedBook;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videobook-export-test-"));
    books = new BookManager({
      libraryDir: join(tempDir, "books"),
      objectPrefix: "test-objects",
      catalogBackupName: "backup",
    });
    await books.ready();
    const sourceCreated = await books.create("source-book");
    const targetCreated = await books.create("target-book");
    if (!sourceCreated.ok || !targetCreated.ok) throw new Error("Could not create test books");
    const sourceResult = books.get(sourceCreated.value.bookId);
    const targetResult = books.get(targetCreated.value.bookId);
    if (!sourceResult.ok || !targetResult.ok) throw new Error("Could not load test books");
    source = sourceResult.value;
    target = targetResult.value;
    registerAllJobHandlers(target.engine, books);
    await setEngineRoot(target.rootDir, target.engine);
    definition = exportAssetDef(source.engine, books);
  });

  afterEach(async () => {
    await queue.stop();
    await books.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("exports an asset to a different book", async () => {
    const created = await source.engine.artifacts.create("image", "photo");
    if (!created.ok) throw new Error(created.error.message);
    const written = await source.engine.files.write(
      created.value.artifactId,
      "original.png",
      Buffer.from("fake-png-data"),
    );
    if (!written.ok) throw new Error(written.error.message);

    const result = await definition.handler({
      asset_id: created.value.slug,
      book_id: source.bookId,
      target_project: target.bookId,
    });

    expect(result.isError, result.content[0]?.text).toBeFalsy();
    const parsed = parse(result);
    expect(parsed).toMatchObject({
      source_asset_id: created.value.slug,
      source_project: source.bookId,
      target_project: target.bookId,
      source_artifact_id: created.value.artifactId,
      source_book_id: source.bookId,
      target_book_id: target.bookId,
    });
    expect(parsed.new_asset_id).toMatch(/^img-/);
    expect(parsed.target_artifact_id).toMatch(/^[0-9a-f-]{36}$/);
    const manifest = await target.engine.files.manifest(parsed.target_artifact_id);
    expect(manifest.ok).toBe(true);
    if (manifest.ok) {
      expect(manifest.value.files.map((file) => file.name)).toContain("original.png");
    }
  });

  it("returns an error when source and target are the same book", async () => {
    const result = await definition.handler({
      asset_id: "img-photo",
      book_id: source.bookId,
      target_project: source.bookId,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("duplicate_asset");
  });

  it("returns an error for a nonexistent source asset", async () => {
    const result = await definition.handler({
      asset_id: "img-no-such-asset",
      book_id: source.bookId,
      target_project: target.bookId,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Artifact not found");
  });
});
