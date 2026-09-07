import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Client } from "@modelcontextprotocol/client";
import { createTestClient } from "../test-client.js";
import { BookManager } from "../book-manager.js";
import { scopedBookEngine, withBookContext } from "../book-context.js";
import { copyLibraryAsset } from "../media-library.js";
import { assetTagDefs } from "./asset-tags.js";

const MINIMAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
  "base64",
);

type ToolContent = Array<{ type: string; text: string }>;

type TagRecord = {
  facet: string;
  key: string;
  label: string;
  origin: string;
};

type TagSummary = {
  effective: TagRecord[];
  manual: TagRecord[];
  dismissed: Array<{ facet: string; key: string; label: string }>;
  fingerprint: string;
};

type AssetRow = {
  id: string;
  artifact_id: string;
  type: string;
  tags: TagSummary | null;
};

describe("asset tag tools", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videobook-tag-tools-"));
    client = await createTestClient(tempDir);
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  function parse(result: { content: unknown }): Record<string, unknown> {
    const content = result.content as ToolContent;
    return JSON.parse(content[0]!.text) as Record<string, unknown>;
  }

  async function call(name: string, args: Record<string, unknown>) {
    return await client.callTool({ name, arguments: args });
  }

  async function makeBook(bookId: string): Promise<void> {
    await call("create_project", { book_id: bookId });
  }

  async function upload(bookId: string, filename: string): Promise<string> {
    const result = await call("upload_file", {
      book_id: bookId,
      filename,
      data: MINIMAL_PNG.toString("base64"),
    });
    return parse(result).assetId as string;
  }

  async function listAssets(
    bookId: string,
    args: Record<string, unknown> = {},
  ) {
    const result = await call("list_assets", { book_id: bookId, ...args });
    const data = parse(result) as unknown as {
      assets: AssetRow[];
      page: { offset: number; limit: number; total: number; hasMore: boolean };
    };
    return data;
  }

  it("adds, removes and restores tags, and reports them on the asset", async () => {
    await makeBook("tags-basic");
    const assetId = await upload("tags-basic", "photo.png");

    const added = parse(await call("add_asset_tag", {
      book_id: "tags-basic",
      asset_id: assetId,
      facet: "places",
      label: "Kitchen",
    }));
    const addedTags = added.tags as TagSummary;
    expect(addedTags.effective.map((tag) => tag.key)).toEqual(["kitchen"]);
    expect(addedTags.effective[0]!.origin).toBe("manual");
    expect(addedTags.fingerprint).not.toBe("");

    const listed = await listAssets("tags-basic");
    const row = listed.assets.find((asset) => asset.artifact_id === assetId);
    expect(row?.tags?.effective.map((tag) => tag.label)).toEqual(["Kitchen"]);

    const removed = parse(await call("remove_asset_tag", {
      book_id: "tags-basic",
      asset_id: assetId,
      facet: "places",
      label: "Kitchen",
    }));
    expect((removed.tags as TagSummary).effective).toEqual([]);

    // Restoring a manual tag that was never automatic is a no-op, not a crash.
    const restored = await call("restore_asset_tag", {
      book_id: "tags-basic",
      asset_id: assetId,
      facet: "places",
      label: "Kitchen",
    });
    expect(parse(restored).asset_id).toBe(assetId);
  });

  it("normalizes labels so spelling variants share one identity", async () => {
    await makeBook("tags-normalize");
    const assetId = await upload("tags-normalize", "photo.png");

    await call("add_asset_tag", {
      book_id: "tags-normalize",
      asset_id: assetId,
      facet: "editing",
      label: "  Close   Up  ",
    });
    const second = parse(await call("add_asset_tag", {
      book_id: "tags-normalize",
      asset_id: assetId,
      facet: "editing",
      label: "close up",
    }));
    const tags = second.tags as TagSummary;
    expect(tags.effective.map((tag) => tag.key)).toEqual(["close up"]);
  });

  it("keeps the same identity distinct across facets", async () => {
    await makeBook("tags-facets");
    const assetId = await upload("tags-facets", "photo.png");

    await call("add_asset_tag", {
      book_id: "tags-facets",
      asset_id: assetId,
      facet: "people",
      label: "Handheld",
    });
    const both = parse(await call("add_asset_tag", {
      book_id: "tags-facets",
      asset_id: assetId,
      facet: "editing",
      label: "Handheld",
    }));
    const tags = both.tags as TagSummary;
    expect(tags.effective.map((tag) => `${tag.facet}/${tag.key}`).sort()).toEqual([
      "editing/handheld",
      "people/handheld",
    ]);

    // Removing one facet's tag leaves the other in place.
    const afterRemove = parse(await call("remove_asset_tag", {
      book_id: "tags-facets",
      asset_id: assetId,
      facet: "people",
      label: "Handheld",
    }));
    expect(
      (afterRemove.tags as TagSummary).effective.map((tag) => tag.facet),
    ).toEqual(["editing"]);
  });

  it("rejects unknown assets, notebook rows and invalid facets", async () => {
    await makeBook("tags-invalid");
    const assetId = await upload("tags-invalid", "photo.png");

    const missing = await call("add_asset_tag", {
      book_id: "tags-invalid",
      asset_id: "01a00000-0000-7000-8000-000000000000",
      facet: "custom",
      label: "Nope",
    });
    expect(missing.isError).toBe(true);

    await call("create_notebook", {
      book_id: "tags-invalid",
      name: "Board",
    });
    const notebooks = await listAssets("tags-invalid");
    const notebookRow = notebooks.assets.find((asset) => asset.type === "notebook");
    expect(notebookRow).toBeDefined();
    // A synthetic notebook row is not an artifact: it carries no tag state and
    // cannot be tagged.
    expect(notebookRow?.tags).toBeNull();
    const notebookTag = await call("add_asset_tag", {
      book_id: "tags-invalid",
      asset_id: notebookRow!.artifact_id,
      facet: "custom",
      label: "Nope",
    });
    expect(notebookTag.isError).toBe(true);

    const badFacet = await call("add_asset_tag", {
      book_id: "tags-invalid",
      asset_id: assetId,
      facet: "vibes",
      label: "Nope",
    });
    expect(badFacet.isError).toBe(true);

    const blank = await call("add_asset_tag", {
      book_id: "tags-invalid",
      asset_id: assetId,
      facet: "custom",
      label: "   ",
    });
    expect(blank.isError).toBe(true);
  });

  it("filters list_assets by exact tags and pages the filtered total", async () => {
    await makeBook("tags-filter");
    const kitchen = await upload("tags-filter", "kitchen.png");
    const street = await upload("tags-filter", "street.png");
    const both = await upload("tags-filter", "both.png");
    await upload("tags-filter", "untagged.png");

    for (const [assetId, label] of [
      [kitchen, "Kitchen"],
      [street, "Street"],
      [both, "Kitchen"],
    ] as const) {
      await call("add_asset_tag", {
        book_id: "tags-filter",
        asset_id: assetId,
        facet: "places",
        label,
      });
    }
    await call("add_asset_tag", {
      book_id: "tags-filter",
      asset_id: both,
      facet: "editing",
      label: "Wide shot",
    });

    const kitchens = await listAssets("tags-filter", {
      tags_all: [{ facet: "places", label: "kitchen" }],
    });
    expect(kitchens.assets.map((asset) => asset.artifact_id).sort()).toEqual(
      [kitchen, both].sort(),
    );
    expect(kitchens.page.total).toBe(2);

    const either = await listAssets("tags-filter", {
      tags_any: [
        { facet: "places", label: "Kitchen" },
        { facet: "places", label: "Street" },
      ],
    });
    expect(either.page.total).toBe(3);

    const compound = await listAssets("tags-filter", {
      tags_all: [
        { facet: "places", label: "Kitchen" },
        { facet: "editing", label: "Wide shot" },
      ],
    });
    expect(compound.assets.map((asset) => asset.artifact_id)).toEqual([both]);

    // An unqualified label matches the identity in whichever facet holds it.
    const unqualified = await listAssets("tags-filter", {
      tags_all: [{ label: "street" }],
    });
    expect(unqualified.assets.map((asset) => asset.artifact_id)).toEqual([street]);

    // Page boundaries are computed over the filtered set, not the whole book.
    const firstPage = await listAssets("tags-filter", {
      tags_any: [
        { facet: "places", label: "Kitchen" },
        { facet: "places", label: "Street" },
      ],
      limit: 2,
      offset: 0,
    });
    expect(firstPage.assets).toHaveLength(2);
    expect(firstPage.page).toEqual({
      offset: 0,
      limit: 2,
      total: 3,
      hasMore: true,
    });
    const lastPage = await listAssets("tags-filter", {
      tags_any: [
        { facet: "places", label: "Kitchen" },
        { facet: "places", label: "Street" },
      ],
      limit: 2,
      offset: 2,
    });
    expect(lastPage.assets).toHaveLength(1);
    expect(lastPage.page.hasMore).toBe(false);

    const unmatched = await listAssets("tags-filter", {
      tags_all: [{ facet: "places", label: "Beach" }],
    });
    expect(unmatched.assets).toEqual([]);
    expect(unmatched.page.total).toBe(0);

    const invalidFilter = await call("list_assets", {
      book_id: "tags-filter",
      tags_all: [{ label: "   " }],
    });
    expect(invalidFilter.isError).toBe(true);
  });

  it("suggests tags in use with per-asset counts", async () => {
    await makeBook("tags-suggest");
    const first = await upload("tags-suggest", "one.png");
    const second = await upload("tags-suggest", "two.png");
    for (const assetId of [first, second]) {
      await call("add_asset_tag", {
        book_id: "tags-suggest",
        asset_id: assetId,
        facet: "editing",
        label: "Interview",
      });
    }
    await call("add_asset_tag", {
      book_id: "tags-suggest",
      asset_id: first,
      facet: "editing",
      label: "Insert",
    });

    const suggestions = parse(await call("suggest_asset_tags", {
      book_id: "tags-suggest",
      prefix: "in",
    })) as unknown as {
      facets: string[];
      suggestions: Array<{ key: string; assets: number }>;
    };
    expect(suggestions.facets).toEqual(["people", "places", "editing", "custom"]);
    const counts = new Map(
      suggestions.suggestions.map((row) => [row.key, row.assets]),
    );
    expect(counts.get("interview")).toBe(2);
    expect(counts.get("insert")).toBe(1);

    const scoped = parse(await call("suggest_asset_tags", {
      book_id: "tags-suggest",
      asset_id: first,
    })) as unknown as { tags: TagSummary };
    expect(scoped.tags.effective.map((tag) => tag.key).sort()).toEqual([
      "insert",
      "interview",
    ]);
  });

  it("copies tags onto a duplicate without linking the two", async () => {
    await makeBook("tags-duplicate");
    const assetId = await upload("tags-duplicate", "photo.png");
    await call("add_asset_tag", {
      book_id: "tags-duplicate",
      asset_id: assetId,
      facet: "people",
      label: "Two people",
    });

    const duplicated = parse(await call("duplicate_asset", {
      book_id: "tags-duplicate",
      asset_id: assetId,
    }));
    expect(duplicated.tags).toMatchObject({
      imported_manual: 1,
      skipped_automatic: false,
    });
    const copyId = duplicated.new_asset_id as string;

    const afterCopy = await listAssets("tags-duplicate");
    const copyRow = afterCopy.assets.find((asset) => asset.artifact_id === copyId);
    expect(copyRow?.tags?.effective.map((tag) => tag.label)).toEqual([
      "Two people",
    ]);

    // Editing the copy leaves the original alone.
    await call("add_asset_tag", {
      book_id: "tags-duplicate",
      asset_id: copyId,
      facet: "custom",
      label: "Copy only",
    });
    const independent = await listAssets("tags-duplicate");
    const sourceRow = independent.assets.find(
      (asset) => asset.artifact_id === assetId,
    );
    expect(sourceRow?.tags?.effective.map((tag) => tag.label)).toEqual([
      "Two people",
    ]);
    expect(
      independent.assets
        .find((asset) => asset.artifact_id === copyId)
        ?.tags?.effective.map((tag) => tag.label)
        .sort(),
    ).toEqual(["Copy only", "Two people"]);
  });
});

/**
 * Book isolation and cross-book copying need genuinely separate books, which
 * the shared MCP test client cannot express: its create_project aliases every
 * book_id onto one engine. These cases drive the same tool definitions over a
 * real BookManager instead.
 */
describe("asset tags across books", () => {
  let rootDir: string;
  let books: BookManager;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "videobook-tag-books-"));
    books = new BookManager({
      libraryDir: join(rootDir, "books"),
      objectPrefix: "test-objects",
    });
    await books.ready();
  });

  afterEach(async () => {
    await books.close();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  const defs = new Map(
    assetTagDefs(scopedBookEngine).map((def) => [def.name, def]),
  );

  async function invoke(
    bookId: string,
    name: string,
    args: Record<string, unknown>,
  ) {
    const managed = books.get(bookId);
    if (!managed.ok) throw new Error(managed.error.message);
    const def = defs.get(name);
    if (!def) throw new Error(`Missing tool ${name}`);
    return await withBookContext(
      { bookId, engine: managed.value.engine },
      () => def.handler({ book_id: bookId, ...args }),
    );
  }

  async function makeBook(name: string): Promise<string> {
    const created = await books.create(name);
    if (!created.ok) throw new Error(created.error.message);
    return created.value.bookId;
  }

  async function makeAsset(bookId: string, label: string): Promise<string> {
    const managed = books.get(bookId);
    if (!managed.ok) throw new Error(managed.error.message);
    const engine = managed.value.engine;
    const created = await engine.artifacts.create({ kind: "image", label });
    if (!created.ok) throw new Error(created.error.message);
    const written = await engine.files.write(
      created.value.artifactId,
      "original.png",
      MINIMAL_PNG,
    );
    if (!written.ok) throw new Error(written.error.message);
    return created.value.artifactId;
  }

  function tagsOf(bookId: string, artifactId: string): string[] {
    const managed = books.get(bookId);
    if (!managed.ok) throw new Error(managed.error.message);
    const state = managed.value.engine.tags.read(artifactId);
    if (!state.ok) throw new Error(state.error.message);
    return state.value.effective.map((tag) => tag.label).sort();
  }

  it("edits tags in the book that owns the asset and nowhere else", async () => {
    const bookA = await makeBook("tags-owner-a");
    const bookB = await makeBook("tags-owner-b");
    const assetA = await makeAsset(bookA, "a");
    const assetB = await makeAsset(bookB, "b");

    const tagged = await invoke(bookA, "add_asset_tag", {
      asset_id: assetA,
      facet: "custom",
      label: "Only A",
    });
    expect(tagged.isError).toBeUndefined();
    expect(tagsOf(bookA, assetA)).toEqual(["Only A"]);
    expect(tagsOf(bookB, assetB)).toEqual([]);

    // Book B holds no such artifact, so the write cannot land there.
    const leak = await invoke(bookB, "add_asset_tag", {
      asset_id: assetA,
      facet: "custom",
      label: "Leak",
    });
    expect(leak.isError).toBe(true);
    expect(tagsOf(bookA, assetA)).toEqual(["Only A"]);
  });

  it("carries tags onto a cross-book copy that then edits independently", async () => {
    const source = await makeBook("tags-copy-source");
    const target = await makeBook("tags-copy-target");
    const assetId = await makeAsset(source, "shared");
    await invoke(source, "add_asset_tag", {
      asset_id: assetId,
      facet: "places",
      label: "Kitchen",
    });
    await invoke(source, "add_asset_tag", {
      asset_id: assetId,
      facet: "editing",
      label: "Wide shot",
    });

    const copied = await copyLibraryAsset(books, {
      sourceBookId: source,
      sourceArtifactId: assetId,
      targetBookId: target,
    });
    expect(tagsOf(target, copied.targetArtifactId)).toEqual([
      "Kitchen",
      "Wide shot",
    ]);

    await invoke(target, "remove_asset_tag", {
      asset_id: copied.targetArtifactId,
      facet: "places",
      label: "Kitchen",
    });
    expect(tagsOf(target, copied.targetArtifactId)).toEqual(["Wide shot"]);
    expect(tagsOf(source, assetId)).toEqual(["Kitchen", "Wide shot"]);
  });
});
