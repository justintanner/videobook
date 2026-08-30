import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Engine, NotebookDocument } from "videobook-engine";
import {
  closeEngineForTest,
  createEngineForTest,
} from "../../server/src/engine.js";
import { prepareNotebookGeneration } from "../../server/src/jobs/run-notebook.js";

describe("Grok Imagine 1080p notebook preparation", () => {
  let rootDir: string;
  let engine: Engine;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "videobook-grok-1080p-"));
    engine = createEngineForTest(rootDir);
    await engine.ready;
  });

  afterEach(async () => {
    closeEngineForTest(rootDir, engine);
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("rejects two image inputs before a notebook generation can be planned", async () => {
    const first = await engine.artifacts.create("img", "first image");
    const second = await engine.artifacts.create("img", "second image");
    const notebook = await engine.notebooks.create("Main");
    if (!first.ok || !second.ok || !notebook.ok) {
      throw new Error("Failed to create test inputs");
    }

    const firstCell = engine.notebooks.createCell({
      type: "image",
      slot: { row: 0, column: 0 },
      outputArtifactId: first.value.artifactId,
    });
    const secondCell = engine.notebooks.createCell({
      type: "image",
      slot: { row: 0, column: 1 },
      outputArtifactId: second.value.artifactId,
    });
    const generationCell = engine.notebooks.createCell({
      type: "generate_video",
      slot: { row: 1, column: 0 },
      prompt: "Bring both portraits to life",
      provider: "kie",
      model: "GrokImageToVideoRequestSchema",
      operation: "image_to_video",
      tool: "generate_kie_grok_imagine_image_to_video",
      inputs: {
        generationMode: "default",
        generationSettings: { resolution: "1080p" },
      },
    });
    const document: NotebookDocument = {
      ...notebook.value,
      cells: [firstCell, secondCell, generationCell],
      edges: [
        engine.notebooks.createEdge({
          source: firstCell.id,
          target: generationCell.id,
          targetInput: "image",
        }),
        engine.notebooks.createEdge({
          source: secondCell.id,
          target: generationCell.id,
          targetInput: "image_2",
        }),
      ],
    };

    await expect(prepareNotebookGeneration(
      engine,
      document,
      generationCell,
      engine.book.get().bookId,
    )).rejects.toThrow(
      "accepts exactly 1 image at 1080p (got 2)",
    );
  });
});
