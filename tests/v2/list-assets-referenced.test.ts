import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEngine,
  type Engine,
} from "videobook-engine";
import { listAssetsDef } from "../../server/src/tools/list-assets.js";

describe("list_assets notebook references", () => {
  let engine: Engine | undefined;
  let rootDir: string | undefined;

  afterEach(async () => {
    engine?.close();
    if (rootDir) {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("appends referenced assets outside the bounded page", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "videobook-list-referenced-"));
    engine = createEngine({
      rootDir,
      initialBookSlug: "list-referenced",
    });
    await engine.ready;

    const notebook = await engine.notebooks.create("Main");
    const older = await engine.artifacts.create({
      kind: "image",
      name: "older",
    });
    expect(notebook.ok && older.ok).toBe(true);
    if (!notebook.ok || !older.ok) return;
    await engine.files.write(
      older.value.artifactId,
      "original.png",
      Buffer.from("older"),
    );
    const referenced = engine.notebooks.createCell({
      type: "image",
      slug: "img-referenced",
      slot: { row: 0, column: 0 },
      outputArtifactId: older.value.artifactId,
    });
    await engine.notebooks.write({
      ...notebook.value,
      cells: [referenced],
    });

    await new Promise((resolve) => setTimeout(resolve, 2));
    const newer = await engine.artifacts.create({
      kind: "image",
      name: "newer",
    });
    expect(newer.ok).toBe(true);
    if (!newer.ok) return;
    await engine.files.write(
      newer.value.artifactId,
      "original.png",
      Buffer.from("newer"),
    );

    const definition = listAssetsDef(engine);
    const result = await definition.handler({
      book_id: engine.book.get().bookId,
      sort: "newest",
      limit: 1,
      include_referenced: true,
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0]!.text) as {
      assets: Array<{ artifact_id: string }>;
      page: {
        offset: number;
        limit: number;
        total: number;
        hasMore: boolean;
      };
    };
    expect(data.assets.map((asset) => asset.artifact_id)).toEqual([
      newer.value.artifactId,
      older.value.artifactId,
    ]);
    expect(data.page).toEqual({
      offset: 0,
      limit: 1,
      total: 3,
      hasMore: true,
    });
  });
});
