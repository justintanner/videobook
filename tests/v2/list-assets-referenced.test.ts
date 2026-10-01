import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEngine,
  MVP_CONTRACT_VERSION,
  type EditIntent,
  type Engine,
} from "videobook-engine";
import { v7 as uuidv7 } from "uuid";
import { listAssetsDef } from "../../server/src/tools/list-assets.js";

describe("list_assets notebook references", () => {
  let engine: Engine | undefined;
  let rootDir: string | undefined;

  afterEach(async () => {
    engine?.close();
    if (rootDir) {
      await rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it("hydrates sequence-only media beyond the first 200 assets without changing paging", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "videobook-sequence-referenced-"));
    engine = createEngine({ durableWrites: false, rootDir, initialBookName: "sequence-referenced" });
    const source = await engine.artifacts.create("image", "timeline source");
    if (!source.ok) throw new Error(source.error.message);
    const artifactId = source.value.artifactId;
    expect((await engine.files.write(artifactId, "original.png", Buffer.from("image"))).ok).toBe(true);
    const manifest = await engine.files.manifest(artifactId);
    if (!manifest.ok) throw new Error(manifest.error.message);
    const sequence = engine.sequences.getPrimary();
    const intent: EditIntent = {
      intentVersion: MVP_CONTRACT_VERSION, commandId: uuidv7(), sequenceId: sequence.sequenceId,
      baseRevision: engine.head, actor: "test", sourceSurface: "ui", confirmationPolicy: "reversible-single-step",
      operations: [{ kind: "insert-clip", mode: "insert", placement: {
        trackId: sequence.tracks.find((track) => track.kind === "video")!.trackId,
        timelineStartFrame: 0, durationFrames: 90,
        source: { kind: "still", artifactId, sourcePath: "original.png", objectHash: manifest.value.files[0]!.objectHash },
      } }],
    };
    const preview = engine.edits.preview(intent);
    if (!preview.ok) throw new Error(preview.error.message);
    expect((await engine.edits.commit(intent, preview.value.previewHash)).ok).toBe(true);
    for (let index = 0; index < 205; index += 1) {
      expect((await engine.artifacts.create("image", `newer-${index}`)).ok).toBe(true);
    }
    const definition = listAssetsDef(engine);
    const read = async (referenced: boolean) => {
      const result = await definition.handler({ book_id: engine!.book.get().bookId, sort: "newest", limit: 200, include_referenced: referenced });
      return JSON.parse(result.content[0]!.text) as {
        assets: Array<{ artifact_id: string; media_url: string | null }>;
        page: { limit: number; total: number; hasMore: boolean };
      };
    };
    const page = await read(false);
    expect(page.assets).toHaveLength(200);
    expect(page.assets.some((asset) => asset.artifact_id === artifactId)).toBe(false);
    const hydrated = await read(true);
    expect(hydrated.page).toEqual(page.page);
    expect(hydrated.page.hasMore).toBe(true);
    expect(hydrated.assets).toHaveLength(201);
    expect(hydrated.assets.find((asset) => asset.artifact_id === artifactId)?.media_url).toContain(artifactId);
  });

  it("appends referenced assets outside the bounded page", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "videobook-list-referenced-"));
    engine = createEngine({ durableWrites: false, rootDir,
    initialBookName: "list-referenced", });
    await engine.ready;

    const notebook = await engine.notebooks.create("Main");
    const older = await engine.artifacts.create({
      kind: "image",
      label: "older",
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
      label: "referenced",
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
      label: "newer",
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
