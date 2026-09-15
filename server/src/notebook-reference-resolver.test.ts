import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEngine, type Engine, type NotebookDocument } from "videobook-engine";
import {
  notebookMediaAddresses,
  resolveNotebookPromptReferences,
  tagNotebookGridAddresses,
} from "./notebook-reference-resolver.js";

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
  const engine = createEngine({ rootDir: root, initialBookName: "mentions" });
  const video = await engine.artifacts.create({
    kind: "video",
    label: "yt 3h3i_td5kce",
  });
  const image = await engine.artifacts.create({ kind: "image", label: "hero" });
  if (!video.ok || !image.ok) throw new Error("fixture artifact creation failed");
  const notebook = await engine.notebooks.create("Main");
  if (!notebook.ok) throw new Error(notebook.error.message);
  const document = {
    ...notebook.value,
    cells: [
      engine.notebooks.createCell({
        type: "video",
        label: "Source video",
        slot: { row: 0, column: 1 },
        outputArtifactId: video.value.artifactId,
      }),
      engine.notebooks.createCell({
        type: "image",
        label: "Hero image",
        slot: { row: 0, column: 4 },
        outputArtifactId: image.value.artifactId,
      }),
      engine.notebooks.createCell({
        type: "image",
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
      prompt: "motion @a2 with @not-a-grid-token, appearance @a5",
      connectedArtifactIds: new Set([fixture.videoId]),
    });
    expect(result.prompt).toContain(`@${fixture.videoId}`);
    expect(result.prompt).toContain(`@${fixture.imageId}`);
    expect(result.prompt).toContain("@not-a-grid-token");
    expect(result.unresolved).toEqual([]);
    expect(result.resolved).toMatchObject([
      { mention: "@a2", artifactId: fixture.videoId, cellAddress: "@a2" },
      { mention: "@a5", artifactId: fixture.imageId, cellAddress: "@a5" },
    ]);
    expect(result.unconnected).toMatchObject([{
      mention: "@a5",
      artifactId: fixture.imageId,
      message: "@a5 is referenced but not connected",
    }]);
  });

  it("tags a bare grid address so the reference then resolves", async () => {
    const fixture = await setup();
    const addresses = notebookMediaAddresses(fixture.document);
    expect([...addresses].sort()).toEqual(["a2", "a5"]);
    const tagged = tagNotebookGridAddresses(
      "Make a video with Seedance 2.5 using the image at A5 "
        + "and the motion reference at A2.",
      addresses,
    );
    expect(tagged).toBe(
      "Make a video with Seedance 2.5 using the image at @a5 "
        + "and the motion reference at @a2.",
    );
    expect(resolveNotebookPromptReferences({
      engine: fixture.engine,
      document: fixture.document,
      prompt: tagged,
    }).resolved).toMatchObject([
      { mention: "@a5", artifactId: fixture.imageId },
      { mention: "@a2", artifactId: fixture.videoId },
    ]);
  });

  it("leaves prose and already-written references untouched", async () => {
    const fixture = await setup();
    const addresses = notebookMediaAddresses(fixture.document);
    for (const text of [
      "pending a7 has no output yet",
      "empty a3 holds nothing",
      "already tagged @a5 stays single",
      "artifact @img-a5 keeps its slug",
      "serial a52 is not an address",
      "model wan2 is not an address",
    ]) expect(tagNotebookGridAddresses(text, addresses), text).toBe(text);
    expect(tagNotebookGridAddresses("image at A5", new Set())).toBe("image at A5");
  });

  it("reports unknown and outputless cells without altering their mentions", async () => {
    const fixture = await setup();
    const result = resolveNotebookPromptReferences({
      engine: fixture.engine,
      document: fixture.document,
      prompt: "unknown @bl8, pending @a7",
      connectedArtifactIds: new Set(),
    });
    expect(result.prompt).toBe("unknown @bl8, pending @a7");
    expect(result.unresolved).toMatchObject([
      { mention: "@bl8", code: "not_found" },
      { mention: "@a7", code: "no_output" },
    ]);
  });
});
