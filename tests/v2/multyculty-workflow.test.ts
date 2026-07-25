import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEngine, type Engine } from "videobook-engine";
import { notebookGridPosition } from "../../src/videobook/notebook-grid.js";
import { seedMultycultyWorkflow } from "../../server/src/multyculty-workflow.js";

describe("Multyculty workflow fixture", () => {
  let rootDir: string | undefined;
  let engine: Engine | undefined;

  afterEach(async () => {
    engine?.close();
    if (rootDir) await rm(rootDir, { recursive: true, force: true });
  });

  it("builds an idempotent source-to-scenes-and-audio production graph", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "videobook-multyculty-"));
    engine = createEngine({ rootDir, initialBookSlug: "multyculty" });
    await engine.ready;
    const notebook = await engine.notebooks.create("Main");
    expect(notebook.ok).toBe(true);

    const artifactSpecs = [
      ["video", "vid-source-selection"],
      ["video", "vid-section-intro"],
      ["video", "vid-animated-intro"],
      ["video", "vid-section-culture"],
      ["video", "vid-animated-culture"],
      ["video", "vid-section-german"],
      ["video", "vid-animated-german"],
      ["video", "vid-section-dunka"],
      ["video", "vid-animated-dunka"],
      ["final", "final"],
    ] as const;
    const artifacts = new Map<string, string>();
    for (const [kind, slug] of artifactSpecs) {
      const artifact = await engine.artifacts.create(kind, slug);
      expect(artifact.ok).toBe(true);
      if (artifact.ok) artifacts.set(slug, artifact.value.artifactId);
    }
    const sourceId = artifacts.get("vid-source-selection");
    expect(sourceId).toBeTruthy();
    if (!sourceId) return;
    const file = await engine.files.write(
      sourceId,
      "original.mp4",
      Buffer.from("fixture source"),
    );
    expect(file.ok).toBe(true);
    if (!file.ok) return;
    const manifest = await engine.files.manifest(sourceId);
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;
    const objectHash = manifest.value.files[0]?.objectHash;
    expect(objectHash).toBeTruthy();
    if (!objectHash) return;
    const stream = await engine.streams.register({
      artifactId: sourceId,
      sourcePath: "original.mp4",
      objectHash,
      streamIndex: 1,
      kind: "audio",
      timeBase: { numerator: 1, denominator: 48_000 },
      durationTicks: 2_880_000,
      codec: "aac",
      audio: {
        sampleRateHz: 48_000,
        channels: 2,
        channelLayout: "stereo",
      },
    });
    expect(stream.ok).toBe(true);

    const first = await seedMultycultyWorkflow(engine);
    expect(first.properties?.stageLabels).toEqual([
      "SOURCE",
      "ANALYZE",
      "SPLIT SCENES",
      "EXTRACT ASSETS",
      "WRITE PROMPTS",
      "ANIMATE SCENES",
      "ASSEMBLE EDIT",
      "EXPORT MASTER",
    ]);
    const source = first.cells.find((cell) => cell.inputs?.workflowRole === "source");
    const analysis = first.cells.find((cell) => cell.inputs?.workflowRole === "analysis");
    const audio = first.cells.find((cell) => cell.inputs?.workflowRole === "source-audio");
    const assembly = first.cells.find((cell) => cell.inputs?.workflowRole === "assembly");
    const exp = first.cells.find((cell) => cell.inputs?.workflowRole === "export");
    expect(source).toBeTruthy();
    expect(analysis).toBeTruthy();
    expect(audio).toBeTruthy();
    expect(assembly).toBeTruthy();
    expect(exp).toBeTruthy();
    expect(first.cells).toHaveLength(29);
    expect(first.edges).toHaveLength(60);
    expect(first.cells.filter((cell) => cell.type === "split")).toHaveLength(4);
    expect(first.cells.filter((cell) => cell.type === "frame")).toHaveLength(8);
    expect(first.cells.filter((cell) =>
      cell.inputs?.workflowRole?.toString().startsWith("scene-audio-"))).toHaveLength(4);
    expect(first.cells.filter((cell) => cell.type === "prompt")).toHaveLength(4);
    expect(first.cells.filter((cell) => cell.type === "video")).toHaveLength(4);
    expect(first.cells.filter((cell) => cell.type === "prompt").every((cell) =>
      cell.inputs?.requiresConfirmation === true)).toBe(true);
    expect(first.cells.filter((cell) => cell.type === "video").every((cell) =>
      cell.inputs?.requiresConfirmation === true
      || cell.inputs?.state === "stale")).toBe(true);
    expect(first.edges).toContainEqual(expect.objectContaining({
      source: source?.id,
      target: analysis?.id,
      targetInput: "source",
    }));
    expect(first.edges).toContainEqual(expect.objectContaining({
      source: audio?.id,
      target: assembly?.id,
      targetInput: "audio",
    }));
    const prompt = first.cells.find((cell) => cell.inputs?.workflowRole === "prompt-1");
    const animate = first.cells.find((cell) => cell.inputs?.workflowRole === "animate-1");
    expect(first.edges).toContainEqual(expect.objectContaining({
      source: prompt?.id,
      target: animate?.id,
      targetInput: "prompt",
    }));

    const second = await seedMultycultyWorkflow(engine);
    expect(second.cells).toHaveLength(29);
    expect(second.cells.filter((cell) => cell.type === "split")).toHaveLength(4);
    expect(second.properties?.stageLabels).toEqual(first.properties?.stageLabels);
    // Source identity is preserved across rematerialization.
    expect(second.cells.find((cell) => cell.inputs?.workflowRole === "source")?.id)
      .toBe(source?.id);
    void notebookGridPosition;
  });
});
