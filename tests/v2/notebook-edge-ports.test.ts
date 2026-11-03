import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine, NotebookDocument } from "videobook-engine";
import { closeEngineForTest, createEngineForTest } from "../../server/src/engine.js";

describe("notebook edge ports", () => {
  let engine: Engine;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videobook-edge-ports-"));
    engine = createEngineForTest(tempDir);
  });

  afterEach(async () => {
    closeEngineForTest(tempDir, engine);
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function keyframeNotebook(): Promise<NotebookDocument> {
    const notebook = await engine.notebooks.create("Main");
    if (!notebook.ok) throw new Error(notebook.error.message);
    const target = engine.notebooks.createCell({ type: "generate_video", slot: { row: 1, column: 0 } });
    const first = engine.notebooks.createCell({ type: "image", slot: { row: 0, column: 0 } });
    const second = engine.notebooks.createCell({ type: "image", slot: { row: 0, column: 1 } });
    const written = await engine.notebooks.write({
      ...notebook.value,
      cells: [target, first, second],
      edges: [
        engine.notebooks.createEdge({ source: first.id, target: target.id, targetInput: "keyframe" }),
        engine.notebooks.createEdge({ source: second.id, target: target.id, targetInput: "keyframe_2" }),
      ],
    });
    if (!written.ok) throw new Error(written.error.message);
    const read = engine.notebooks.read(notebook.value.id);
    if (!read.ok) throw new Error(read.error.message);
    return read.value;
  }

  async function writeSucceeds(document: NotebookDocument): Promise<boolean> {
    try {
      return (await engine.notebooks.write(document)).ok;
    } catch {
      return false;
    }
  }

  function ports(notebookId: string): string[][] {
    const read = engine.notebooks.read(notebookId);
    if (!read.ok) throw new Error(read.error.message);
    return read.value.edges.map((edge) => [edge.source, edge.targetInput]).sort();
  }

  it("refuses to swap two ports in place on the same edge ids and keeps the old ports", async () => {
    const notebook = await keyframeNotebook();
    const [first, second] = notebook.edges;
    const before = ports(notebook.id);

    expect(await writeSucceeds({
      ...notebook,
      edges: [
        { ...first!, targetInput: second!.targetInput },
        { ...second!, targetInput: first!.targetInput },
      ],
    })).toBe(false);
    expect(ports(notebook.id)).toEqual(before);
  });

  it("swaps ports when the moved edges get fresh ids", async () => {
    const notebook = await keyframeNotebook();
    const [first, second] = notebook.edges;

    expect(await writeSucceeds({
      ...notebook,
      edges: [
        engine.notebooks.createEdge({ source: first!.source, target: first!.target, targetInput: second!.targetInput }),
        engine.notebooks.createEdge({ source: second!.source, target: second!.target, targetInput: first!.targetInput }),
      ],
    })).toBe(true);
    expect(ports(notebook.id)).toEqual([
      [first!.source, "keyframe_2"],
      [second!.source, "keyframe"],
    ].sort());
  });

  it("stores only the four edge columns", async () => {
    const notebook = await keyframeNotebook();
    const [first, second] = notebook.edges;

    expect(await writeSucceeds({
      ...notebook,
      edges: [{ ...first!, params: { timestamp_s: 4 } } as typeof first & { params: unknown }, second!],
    })).toBe(true);
    const read = engine.notebooks.read(notebook.id);
    if (!read.ok) throw new Error(read.error.message);
    expect(Object.keys(read.value.edges.find((edge) => edge.id === first!.id)!).sort())
      .toEqual(["id", "source", "target", "targetInput"]);
  });
});
