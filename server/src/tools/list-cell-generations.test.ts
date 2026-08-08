import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "videobook-engine";
import { closeEngineForTest, createEngineForTest } from "../fs.js";
import { listCellGenerationsDef } from "./list-cell-generations.js";
import { mutateNotebook } from "../notebook-mutations.js";

describe("list_cell_generations tool", () => {
  let engine: Engine;
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "list-cell-gens-"));
    engine = createEngineForTest(root);
  });

  afterEach(async () => {
    if (root && engine) closeEngineForTest(root, engine);
    if (root) await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  it("returns attributable attempts from cell and execution history", async () => {
    const bookId = engine.book.get().bookId;
    const first = (await engine.artifacts.create("image", "gen-1")).value!;
    const second = (await engine.artifacts.create("image", "gen-2")).value!;
    const notebook = (await engine.notebooks.create("Gens")).value!;
    const cell = engine.notebooks.createCell({
      type: "generate_image",
      slot: { row: 0, column: 0 },
      prompt: "prompt one",
      tool: "generate_seedream_image",
      model: "seedream",
      outputArtifactId: first.artifactId,
      inputs: {
        resolvedPrompt: "prompt one",
        providerArtifactId: first.artifactId,
        outputVersionArtifactIds: [first.artifactId],
      },
    });

    const firstWrite = await mutateNotebook(
      engine,
      notebook.id,
      "run_notebook_cell",
      () => ({
        ...notebook,
        cells: [cell],
        edges: [],
        execution: {
          [cell.id]: {
            status: "completed",
            runId: "run-1",
            fingerprint: "fp-1",
            outputArtifactId: first.artifactId,
            providerArtifactId: first.artifactId,
            tool: "generate_seedream_image",
          },
        },
      }),
      {
        cellId: cell.id,
        runId: "run-1",
        tool: "generate_seedream_image",
        outputArtifactId: first.artifactId,
      },
      { artifactId: first.artifactId },
    );
    if (!firstWrite.ok) throw new Error(firstWrite.error.message);

    const secondWrite = await mutateNotebook(
      engine,
      notebook.id,
      "complete_notebook_provider_output",
      (current) => ({
        ...current,
        cells: current.cells.map((candidate) =>
          candidate.id === cell.id
            ? {
                ...candidate,
                prompt: "prompt two",
                outputArtifactId: second.artifactId,
                inputs: {
                  ...(candidate.inputs ?? {}),
                  resolvedPrompt: "prompt two",
                  providerArtifactId: second.artifactId,
                  outputVersionArtifactIds: [
                    first.artifactId,
                    second.artifactId,
                  ],
                },
              }
            : candidate),
        execution: {
          ...(current.execution ?? {}),
          [cell.id]: {
            status: "completed",
            runId: "run-2",
            fingerprint: "fp-2",
            outputArtifactId: second.artifactId,
            providerArtifactId: second.artifactId,
            tool: "generate_seedream_image",
          },
        },
      }),
      {
        cellId: cell.id,
        runId: "run-2",
        tool: "generate_seedream_image",
        outputArtifactId: second.artifactId,
      },
      { artifactId: second.artifactId },
    );
    if (!secondWrite.ok) throw new Error(secondWrite.error.message);

    const result = await listCellGenerationsDef(engine).handler({
      book_id: bookId,
      notebook_id: notebook.id,
      cell_id: cell.id,
      limit: 10,
    });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0]!.text,
    ) as {
      attempts: Array<{
        runId: string | null;
        artifactId: string | null;
        operation: string | null;
        resolvedPrompt: string | null;
        commitHash: string | null;
      }>;
      generations: {
        count: number;
        artifactIds: string[];
      };
    };

    expect(data.attempts.length).toBeGreaterThanOrEqual(1);
    expect(
      data.attempts.some((attempt) =>
        attempt.operation === "complete_notebook_provider_output"
        || attempt.operation === "run_notebook_cell"),
    ).toBe(true);
    expect(
      data.attempts.some((attempt) =>
        attempt.artifactId === first.artifactId
        || attempt.artifactId === second.artifactId),
    ).toBe(true);
    expect(data.generations.count).toBeGreaterThanOrEqual(1);
    expect(data.generations.artifactIds).toEqual(
      expect.arrayContaining([first.artifactId, second.artifactId]),
    );
    expect(data.attempts.every((attempt) => attempt.commitHash)).toBe(true);
  });
});
