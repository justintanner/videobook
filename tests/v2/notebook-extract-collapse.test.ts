import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEngine, type Engine, type NotebookDocument } from "videobook-engine";
import {
  collapseLegacyExtractPairs,
  migrateLegacyExtractFrameCells,
} from "../../server/src/notebook-cell-outputs.js";
import { mutateNotebook } from "../../server/src/notebook-mutations.js";

describe("legacy extract migration", () => {
  let rootDir: string | undefined;
  let engine: Engine | undefined;

  afterEach(async () => {
    engine?.close();
    if (rootDir) await rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  async function setup(name: string): Promise<Engine> {
    rootDir = await mkdtemp(join(tmpdir(), "vb-extract-migrate-"));
    engine = createEngine({ durableWrites: false, rootDir, initialBookName: name });
    await engine.ready;
    return engine;
  }

  it("collapses an audio pair and migrates a frame pair onto its image cell", async () => {
    const engine = await setup("extract-migrate");

    const audioArtifact = await engine.artifacts.create({
      kind: "audio",
      label: "Paired extract audio",
    });
    expect(audioArtifact.ok).toBe(true);
    if (!audioArtifact.ok) return;
    const imageArtifact = await engine.artifacts.create({
      kind: "image",
      label: "Paired extract frame",
    });
    expect(imageArtifact.ok).toBe(true);
    if (!imageArtifact.ok) return;

    const notebook = await engine.notebooks.create("Main");
    expect(notebook.ok).toBe(true);
    if (!notebook.ok) return;

    const source = engine.notebooks.createCell({
      type: "video",
      label: "Source video",
      slot: { row: 0, column: 0 },
    });
    const extractAudio = engine.notebooks.createCell({
      type: "extract_audio",
      label: "Extract audio",
      slot: { row: 1, column: 0 },
      provider: "local",
      operation: "extract_audio",
      tool: "ffmpeg",
    });
    const audio = engine.notebooks.createCell({
      type: "audio",
      label: "Extracted audio",
      slot: { row: 1, column: 1 },
      outputArtifactId: audioArtifact.value.artifactId,
      inputs: {
        mediaRole: "extract-audio-output",
        producerCellId: extractAudio.id,
        durationSeconds: 4,
        state: "completed",
      },
    });
    const frameProducer = engine.notebooks.createCell({
      type: "image",
      label: "Extract frame",
      slot: { row: 2, column: 0 },
      provider: "local",
      operation: "extract_frame",
      tool: "ffmpeg",
      inputs: { frameMode: "first" },
    });
    const image = engine.notebooks.createCell({
      type: "image",
      label: "Extracted frame",
      slot: { row: 2, column: 1 },
      outputArtifactId: imageArtifact.value.artifactId,
      inputs: {
        mediaRole: "extract-frame-output",
        producerCellId: frameProducer.id,
        frameMode: "first",
        atSeconds: 0,
        state: "awaiting-output",
      },
    });
    const prompt = engine.notebooks.createCell({
      type: "prompt",
      label: "Use extracted media",
      slot: { row: 3, column: 0 },
    });
    const generate = engine.notebooks.createCell({
      type: "generate_image",
      label: "From frame",
      slot: { row: 3, column: 1 },
    });
    const document: NotebookDocument = {
      ...notebook.value,
      cells: [source, extractAudio, audio, frameProducer, image, prompt, generate],
      edges: [
        engine.notebooks.createEdge({
          source: source.id,
          target: extractAudio.id,
          targetInput: "video",
        }),
        engine.notebooks.createEdge({
          source: extractAudio.id,
          target: audio.id,
          targetInput: "media",
        }),
        engine.notebooks.createEdge({
          source: audio.id,
          target: prompt.id,
          targetInput: "scene_audio",
        }),
        engine.notebooks.createEdge({
          source: source.id,
          target: frameProducer.id,
          targetInput: "video",
        }),
        engine.notebooks.createEdge({
          source: frameProducer.id,
          target: image.id,
          targetInput: "media",
        }),
        engine.notebooks.createEdge({
          source: image.id,
          target: generate.id,
          targetInput: "input",
        }),
      ],
      execution: {
        [audio.id]: { status: "completed", outputArtifactId: audioArtifact.value.artifactId },
        [image.id]: { status: "awaiting-output", outputArtifactId: imageArtifact.value.artifactId },
        [frameProducer.id]: { status: "awaiting-output" },
      },
    };
    const written = await engine.notebooks.write(document);
    expect(written.ok).toBe(true);

    const first = await mutateNotebook(
      engine,
      document.id,
      "migrate_legacy_extract_cells",
      (current) => current,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const migratedRead = engine.notebooks.read(document.id);
    expect(migratedRead.ok).toBe(true);
    if (!migratedRead.ok) return;

    const migrated = migratedRead.value;
    expect(migrated.cells.map((cell) => cell.id).sort()).toEqual(
      [source.id, extractAudio.id, image.id, prompt.id, generate.id].sort(),
    );
    const completedAudio = migrated.cells.find((cell) => cell.id === extractAudio.id);
    const frameOutput = migrated.cells.find((cell) => cell.id === image.id);
    expect(completedAudio).toMatchObject({
      type: "audio",
      outputArtifactId: audioArtifact.value.artifactId,
      inputs: expect.objectContaining({
        durationSeconds: 4,
        state: "completed",
        mediaRole: "extract-audio-output",
        sourceCellId: source.id,
      }),
    });
    expect(frameOutput).toMatchObject({
      type: "image",
      outputArtifactId: imageArtifact.value.artifactId,
      inputs: expect.objectContaining({
        mediaRole: "extract-frame-output",
        sourceCellId: source.id,
        frameMode: "first",
        atSeconds: 0,
        state: "completed",
      }),
    });
    expect(frameOutput?.operation).toBeUndefined();
    expect(frameOutput?.tool).toBeUndefined();
    expect(frameOutput?.inputs?.producerCellId).toBeUndefined();
    expect(migrated.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: extractAudio.id,
        target: prompt.id,
        targetInput: "scene_audio",
      }),
      expect.objectContaining({
        source: source.id,
        target: image.id,
        targetInput: "segment",
      }),
      expect.objectContaining({
        source: image.id,
        target: generate.id,
        targetInput: "input",
      }),
    ]));
    expect(migrated.edges.some((edge) => edge.targetInput === "media"
      && (edge.source === extractAudio.id || edge.target === image.id)))
      .toBe(false);
    expect(migrated.edges.some((edge) =>
      edge.source === frameProducer.id || edge.target === frameProducer.id))
      .toBe(false);
    expect(migrated.execution?.[audio.id]).toBeUndefined();
    expect(migrated.execution?.[frameProducer.id]).toBeUndefined();
    expect(migrated.execution?.[image.id]).toBeUndefined();

    const again = await mutateNotebook(
      engine,
      document.id,
      "migrate_legacy_extract_cells",
      (current) => current,
    );
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    const againRead = engine.notebooks.read(document.id);
    expect(againRead.ok).toBe(true);
    if (!againRead.ok) return;
    expect(againRead.value.cells.map((cell) => cell.id).sort())
      .toEqual(migrated.cells.map((cell) => cell.id).sort());
    expect(collapseLegacyExtractPairs(againRead.value)).toBe(againRead.value);
    expect(migrateLegacyExtractFrameCells(againRead.value)).toBe(againRead.value);
  });

  it("migrates a collapsed single extract_frame cell in place", async () => {
    const engine = await setup("extract-migrate-single");

    const imageArtifact = await engine.artifacts.create({
      kind: "image",
      label: "Collapsed frame",
    });
    expect(imageArtifact.ok).toBe(true);
    if (!imageArtifact.ok) return;

    const notebook = await engine.notebooks.create("Main");
    expect(notebook.ok).toBe(true);
    if (!notebook.ok) return;

    const source = engine.notebooks.createCell({
      type: "video",
      label: "Source video",
      slot: { row: 0, column: 0 },
    });
    const collapsed = engine.notebooks.createCell({
      type: "image",
      label: "Last frame",
      slot: { row: 0, column: 1 },
      provider: "local",
      operation: "extract_frame",
      tool: "ffmpeg",
      outputArtifactId: imageArtifact.value.artifactId,
      inputs: {
        frameMode: "last",
        atSeconds: 5,
        state: "completed",
      },
    });
    const generate = engine.notebooks.createCell({
      type: "generate_video",
      label: "Animate",
      slot: { row: 0, column: 2 },
    });
    const document: NotebookDocument = {
      ...notebook.value,
      cells: [source, collapsed, generate],
      edges: [
        engine.notebooks.createEdge({
          source: source.id,
          target: collapsed.id,
          targetInput: "video",
        }),
        engine.notebooks.createEdge({
          source: collapsed.id,
          target: generate.id,
          targetInput: "image",
        }),
      ],
    };
    const written = await engine.notebooks.write(document);
    expect(written.ok).toBe(true);

    const migratedDirect = migrateLegacyExtractFrameCells(document);
    expect(migratedDirect).not.toBe(document);

    const result = await mutateNotebook(
      engine,
      document.id,
      "migrate_legacy_extract_cells",
      (current) => current,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const read = engine.notebooks.read(document.id);
    expect(read.ok).toBe(true);
    if (!read.ok) return;

    const migrated = read.value.cells.find((cell) => cell.id === collapsed.id);
    expect(migrated).toMatchObject({
      type: "image",
      label: "Last frame",
      outputArtifactId: imageArtifact.value.artifactId,
      inputs: expect.objectContaining({
        mediaRole: "extract-frame-output",
        sourceCellId: source.id,
        frameMode: "last",
        atSeconds: 5,
        state: "completed",
      }),
    });
    expect(migrated?.operation).toBeUndefined();
    expect(migrated?.provider).toBeUndefined();
    expect(migrated?.tool).toBeUndefined();
    expect(read.value.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: source.id,
        target: collapsed.id,
        targetInput: "segment",
      }),
      expect.objectContaining({
        source: collapsed.id,
        target: generate.id,
        targetInput: "image",
      }),
    ]));
    expect(read.value.edges.some((edge) =>
      edge.target === collapsed.id && edge.targetInput === "video")).toBe(false);
    expect(migrateLegacyExtractFrameCells(read.value)).toBe(read.value);
  });
});
