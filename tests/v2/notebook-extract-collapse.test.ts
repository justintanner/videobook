import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEngine, type Engine, type NotebookDocument } from "videobook-engine";
import { collapseLegacyExtractPairs } from "../../server/src/notebook-cell-outputs.js";
import { mutateNotebook } from "../../server/src/notebook-mutations.js";

describe("legacy extract pair collapse", () => {
  let rootDir: string | undefined;
  let engine: Engine | undefined;

  afterEach(async () => {
    engine?.close();
    if (rootDir) await rm(rootDir, { recursive: true, force: true });
  });

  it("collapses an extract pair through mutateNotebook and is idempotent", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "vb-extract-collapse-"));
    engine = createEngine({ rootDir, initialBookName: "extract-collapse" });
    await engine.ready;

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
    const extractFrame = engine.notebooks.createCell({
      type: "extract_frame",
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
        producerCellId: extractFrame.id,
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
      cells: [source, extractAudio, audio, extractFrame, image, prompt, generate],
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
          target: extractFrame.id,
          targetInput: "video",
        }),
        engine.notebooks.createEdge({
          source: extractFrame.id,
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
        [extractFrame.id]: { status: "awaiting-output" },
      },
    };
    const written = await engine.notebooks.write(document);
    expect(written.ok).toBe(true);

    const first = await mutateNotebook(
      engine,
      document.id,
      "collapse_legacy_extract_pairs",
      (current) => current,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const collapsedRead = engine.notebooks.read(document.id);
    expect(collapsedRead.ok).toBe(true);
    if (!collapsedRead.ok) return;

    const collapsed = collapsedRead.value;
    expect(collapsed.cells.map((cell) => cell.id).sort()).toEqual(
      [source.id, extractAudio.id, extractFrame.id, prompt.id, generate.id].sort(),
    );
    const completedAudio = collapsed.cells.find((cell) => cell.id === extractAudio.id);
    const completedFrame = collapsed.cells.find((cell) => cell.id === extractFrame.id);
    expect(completedAudio).toMatchObject({
      outputArtifactId: audioArtifact.value.artifactId,
      inputs: expect.objectContaining({
        durationSeconds: 4,
        state: "completed",
      }),
    });
    expect(completedFrame).toMatchObject({
      outputArtifactId: imageArtifact.value.artifactId,
      inputs: expect.objectContaining({
        frameMode: "first",
        atSeconds: 0,
        state: "completed",
      }),
    });
    expect(collapsed.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: extractAudio.id,
        target: prompt.id,
        targetInput: "scene_audio",
      }),
      expect.objectContaining({
        source: extractFrame.id,
        target: generate.id,
        targetInput: "input",
      }),
    ]));
    expect(collapsed.edges.some((edge) =>
      edge.targetInput === "media"
      && (edge.source === extractAudio.id || edge.source === extractFrame.id)))
      .toBe(false);
    expect(collapsed.execution?.[audio.id]).toBeUndefined();
    expect(collapsed.execution?.[image.id]).toBeUndefined();
    expect(collapsed.execution?.[extractFrame.id]).toBeUndefined();

    const again = await mutateNotebook(
      engine,
      document.id,
      "collapse_legacy_extract_pairs",
      (current) => current,
    );
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    const againRead = engine.notebooks.read(document.id);
    expect(againRead.ok).toBe(true);
    if (!againRead.ok) return;
    expect(againRead.value.cells.map((cell) => cell.id).sort())
      .toEqual(collapsed.cells.map((cell) => cell.id).sort());
    expect(collapseLegacyExtractPairs(againRead.value)).toBe(againRead.value);
  });
});
