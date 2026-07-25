import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEngine, type Engine } from "videobook-engine";
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
    expect(first.cells.filter((cell) => cell.type === "label").map((cell) => cell.title)).toEqual([
      "Import + Analyze",
      "Split + Extract",
      "Prompt + Animate",
      "Assemble + Export",
    ]);
    expect(first.properties?.stageLabels).toBeUndefined();
    expect(first.properties?.featureLanes).toBeUndefined();
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
    expect(first.cells).toHaveLength(33);
    expect(first.edges).toHaveLength(60);
    expect(first.cells.filter((cell) => cell.type === "split")).toHaveLength(4);
    expect(first.cells.filter((cell) => cell.type === "frame")).toHaveLength(8);
    expect(first.cells.filter((cell) =>
      cell.inputs?.workflowRole?.toString().startsWith("scene-audio-"))).toHaveLength(4);
    expect(first.cells.filter((cell) => cell.type === "prompt")).toHaveLength(4);
    expect(first.cells.filter((cell) => cell.type === "video")).toHaveLength(4);
    expect(first.cells.filter((cell) => cell.type === "label").map((cell) => cell.slot)).toEqual([
      { row: 0, column: 0 },
      { row: 0, column: 1 },
      { row: 0, column: 2 },
      { row: 0, column: 3 },
    ]);
    expect(source?.slot).toEqual({ row: 1, column: 1 });
    expect(analysis?.slot).toEqual({ row: 2, column: 1 });
    expect(audio?.slot).toEqual({ row: 9, column: 2 });
    expect(assembly?.slot).toEqual({ row: 9, column: 1 });
    expect(exp?.slot).toEqual({ row: 10, column: 1 });
    for (let ordinal = 1; ordinal <= 4; ordinal += 1) {
      const column = ordinal - 1;
      expect(first.cells.find((cell) =>
        cell.inputs?.workflowRole === `split-${ordinal}`)?.slot)
        .toEqual({ row: 3, column });
      expect(first.cells.find((cell) =>
        cell.inputs?.workflowRole === `frame-first-${ordinal}`)?.slot)
        .toEqual({ row: 4, column });
      expect(first.cells.find((cell) =>
        cell.inputs?.workflowRole === `frame-last-${ordinal}`)?.slot)
        .toEqual({ row: 5, column });
      expect(first.cells.find((cell) =>
        cell.inputs?.workflowRole === `scene-audio-${ordinal}`)?.slot)
        .toEqual({ row: 6, column });
      expect(first.cells.find((cell) =>
        cell.inputs?.workflowRole === `prompt-${ordinal}`)?.slot)
        .toEqual({ row: 7, column });
      expect(first.cells.find((cell) =>
        cell.inputs?.workflowRole === `animate-${ordinal}`)?.slot)
        .toEqual({ row: 8, column });
    }
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
    expect(second.cells).toHaveLength(33);
    expect(second.cells.filter((cell) => cell.type === "split")).toHaveLength(4);
    expect(second.cells.filter((cell) => cell.type === "label").map((cell) => cell.id))
      .toEqual(first.cells.filter((cell) => cell.type === "label").map((cell) => cell.id));
    // Source identity is preserved across rematerialization.
    expect(second.cells.find((cell) => cell.inputs?.workflowRole === "source")?.id)
      .toBe(source?.id);
  });
});
