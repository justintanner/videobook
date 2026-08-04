import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEngine, type Engine, type NotebookDocument } from "videobook-engine";
import { resolveNotebookPromptReferences } from "./notebook-reference-resolver.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

async function setup(): Promise<{
  engine: Engine;
  document: NotebookDocument;
  videoId: string;
  imageId: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "videobook-ref-resolver-"));
  roots.push(root);
  const engine = createEngine({ rootDir: root, initialBookSlug: "mentions" });
  const video = await engine.artifacts.create({
    kind: "video",
    name: "yt 3h3i_td5kce",
  });
  const image = await engine.artifacts.create({ kind: "image", name: "hero" });
  if (!video.ok || !image.ok) throw new Error("fixture artifact creation failed");
  const notebook = await engine.notebooks.create("Main");
  if (!notebook.ok) throw new Error(notebook.error.message);
  const document = {
    ...notebook.value,
    cells: [
      engine.notebooks.createCell({
        type: "video",
        slug: "vid-source",
        slot: { row: 0, column: 1 },
        outputArtifactId: video.value.artifactId,
      }),
      engine.notebooks.createCell({
        type: "image",
        slug: "img-source",
        slot: { row: 0, column: 4 },
        outputArtifactId: image.value.artifactId,
      }),
      engine.notebooks.createCell({
        type: "image",
        slug: "img-empty",
        slot: { row: 0, column: 6 },
      }),
    ],
  };
  return {
    engine,
    document,
    videoId: video.value.artifactId,
    imageId: image.value.artifactId,
  };
}

describe("notebook reference resolver", () => {
  it("resolves document-scoped grid mentions and reports unwired media", async () => {
    const fixture = await setup();
    const result = resolveNotebookPromptReferences({
      engine: fixture.engine,
      document: fixture.document,
      prompt: "motion @a2 and @vid-yt-3h3i_td5kce, appearance @a5",
      connectedArtifactIds: new Set([fixture.videoId]),
    });
    expect(result.prompt).toContain("@vid-yt-3h3i_td5kce");
    expect(result.prompt.match(/@vid-yt-3h3i_td5kce/gu)).toHaveLength(2);
    expect(result.prompt).toContain("@img-hero");
    expect(result.unresolved).toEqual([]);
    expect(result.unconnected).toMatchObject([{
      mention: "@a5",
      artifactId: fixture.imageId,
      message: "@a5 is referenced but not connected",
    }]);
  });

  it("reports unknown and outputless cells without altering their mentions", async () => {
    const fixture = await setup();
    const result = resolveNotebookPromptReferences({
      engine: fixture.engine,
      document: fixture.document,
      prompt: "unknown @z13, pending @a7",
      connectedArtifactIds: new Set(),
    });
    expect(result.prompt).toBe("unknown @z13, pending @a7");
    expect(result.unresolved).toMatchObject([
      { mention: "@z13", code: "not_found" },
      { mention: "@a7", code: "no_output" },
    ]);
  });
});
