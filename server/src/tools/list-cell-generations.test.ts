import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine, Generation, NotebookCell, NotebookDocument } from "videobook-engine";
import { closeEngineForTest, createEngineForTest } from "../engine.js";
import { listCellGenerationsDef } from "./list-cell-generations.js";
import type { ListCellGenerationsResponse } from "./list-cell-generations.js";
import { mutateNotebook } from "../notebook-mutations.js";

const GENERATION_STATUSES = [
  "dispatched",
  "awaiting_provider",
  "completed",
  "failed",
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createNotebookWithCell(
  engine: Engine,
  type: "generate_image" | "generate_video" = "generate_image",
): Promise<{ notebook: NotebookDocument; cell: NotebookCell }> {
  const notebookResult = await engine.notebooks.create("Gens");
  if (!notebookResult.ok) throw new Error(notebookResult.error.message);
  const notebook = notebookResult.value;
  const cell = engine.notebooks.createCell({
    type,
    slot: { row: 0, column: 0 },
    prompt: "a cat dances",
    tool: "generate_seedream_image",
    model: "seedream",
  });
  const inserted = await engine.notebooks.insertCell(notebook.id, cell);
  if (!inserted.ok) throw new Error(inserted.error.message);
  return { notebook, cell };
}

async function recordGeneration(
  engine: Engine,
  notebookId: string,
  cellId: string,
  runId: string,
): Promise<Generation> {
  const result = await engine.generations.record({
    notebookId,
    cellId,
    tool: "generate_seedream_image",
    provider: "alibaba",
    model: "seedream",
    prompt: "a cat dances",
    runId,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function updateGeneration(
  engine: Engine,
  generationId: string,
  patch: Parameters<Engine["generations"]["update"]>[1],
): Promise<void> {
  const result = await engine.generations.update(generationId, patch);
  if (!result.ok) throw new Error(result.error.message);
}

async function listGenerations(
  engine: Engine,
  args: { notebook_id: string; cell_id: string; include_payloads?: boolean },
): Promise<{ text: string; data: ListCellGenerationsResponse }> {
  const result = await listCellGenerationsDef(engine).handler({
    book_id: engine.book.get().bookId,
    limit: 10,
    ...args,
  });
  expect(result.isError).toBeFalsy();
  const text = (result.content as Array<{ type: string; text: string }>)[0]!
    .text;
  return {
    text,
    data: JSON.parse(text) as ListCellGenerationsResponse,
  };
}

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

  it("returns one attempt per dispatch with enum statuses and transition timelines", async () => {
    const { notebook, cell } = await createNotebookWithCell(engine);
    const output = await engine.artifacts.create("image", "gen-out");
    if (!output.ok) throw new Error(output.error.message);

    const completed = await recordGeneration(engine, notebook.id, cell.id, "run-1");
    await updateGeneration(engine, completed.generationId, {
      status: "awaiting_provider",
    });
    await updateGeneration(engine, completed.generationId, {
      status: "completed",
      outputArtifactId: output.value.artifactId,
    });
    await sleep(5);
    const failed = await recordGeneration(engine, notebook.id, cell.id, "run-2");
    await updateGeneration(engine, failed.generationId, {
      status: "failed",
      error: "provider rejected the request",
    });
    await sleep(5);
    const dispatched = await recordGeneration(engine, notebook.id, cell.id, "run-3");

    const { text, data } = await listGenerations(engine, {
      notebook_id: notebook.id,
      cell_id: cell.id,
    });

    expect(data.generateCellId).toBe(cell.id);
    expect(data.attempts).toHaveLength(3);
    expect(data.attempts.map((attempt) => attempt.attemptId)).toEqual([
      dispatched.generationId,
      failed.generationId,
      completed.generationId,
    ]);
    expect(
      data.attempts.every((attempt) =>
        GENERATION_STATUSES.includes(attempt.status)),
    ).toBe(true);

    const byId = new Map(
      data.attempts.map((attempt) => [attempt.attemptId, attempt]),
    );
    const completedAttempt = byId.get(completed.generationId)!;
    expect(completedAttempt.status).toBe("completed");
    expect(completedAttempt.artifactId).toBe(output.value.artifactId);
    expect(completedAttempt.runId).toBe("run-1");
    expect(completedAttempt.tool).toBe("generate_seedream_image");
    expect(
      completedAttempt.transitions.map((transition) => transition.status),
    ).toEqual(["dispatched", "awaiting_provider", "completed"]);
    expect(
      completedAttempt.transitions.every((transition) =>
        transition.commitHash.length > 0 && transition.commitDate.length > 0),
    ).toBe(true);
    expect(
      new Set(
        completedAttempt.transitions.map((transition) => transition.commitHash),
      ).size,
    ).toBe(3);

    const failedAttempt = byId.get(failed.generationId)!;
    expect(failedAttempt.status).toBe("failed");
    expect(failedAttempt.error).toBe("provider rejected the request");
    expect(
      failedAttempt.transitions.map((transition) => transition.status),
    ).toEqual(["dispatched", "failed"]);

    const dispatchedAttempt = byId.get(dispatched.generationId)!;
    expect(dispatchedAttempt.status).toBe("dispatched");
    expect(dispatchedAttempt.error).toBeNull();
    expect(dispatchedAttempt.artifactId).toBeNull();

    expect(data.attempts.every((attempt) => !("payload" in attempt))).toBe(true);
    expect(
      data.attempts.every((attempt) => attempt.payloadAvailable === false),
    ).toBe(true);
    expect(text).not.toContain("\"present\"");

    expect(data.generations.count).toBe(3);
    expect(data.generations.latestStatus).toBe("dispatched");
    expect(data.generations.artifactIds).toEqual([output.value.artifactId]);
  });

  it("resolves the output-cell pair and returns payload bodies only on request", async () => {
    const { notebook, cell } = await createNotebookWithCell(engine, "generate_video");
    const outputCell = engine.notebooks.createCell({
      type: "video",
      slot: { row: 1, column: 0 },
      inputs: {
        mediaRole: "generate-video-output",
        producerCellId: cell.id,
      },
    });
    const edge = engine.notebooks.createEdge({
      source: cell.id,
      target: outputCell.id,
      targetInput: "output",
    });
    const written = await mutateNotebook(
      engine,
      notebook.id,
      "run_notebook_cell",
      (current) => ({
        ...current,
        cells: [...current.cells, outputCell],
        edges: [...current.edges, edge],
      }),
      { cellId: cell.id },
    );
    if (!written.ok) throw new Error(written.error.message);

    const providerAsset = await engine.artifacts.create("video", "provider-out");
    const outputAsset = await engine.artifacts.create("video", "cell-out");
    if (!providerAsset.ok) throw new Error(providerAsset.error.message);
    if (!outputAsset.ok) throw new Error(outputAsset.error.message);
    const payload = {
      model: "seedream",
      input: { prompt: "a cat dances" },
    };
    const commandPlan = { steps: [{ op: "generate" }] };
    expect((await engine.metadata.artifacts.write(
      outputAsset.value.artifactId,
      "generation-payload",
      payload,
    )).ok).toBe(true);
    expect((await engine.metadata.artifacts.write(
      outputAsset.value.artifactId,
      "command-plan",
      commandPlan,
    )).ok).toBe(true);

    const generation = await engine.generations.record({
      notebookId: notebook.id,
      cellId: cell.id,
      tool: "generate_seedream_image",
      providerArtifactId: providerAsset.value.artifactId,
      runId: "run-pair",
    });
    if (!generation.ok) throw new Error(generation.error.message);
    await updateGeneration(engine, generation.value.generationId, {
      status: "completed",
      outputArtifactId: outputAsset.value.artifactId,
    });

    const summary = await listGenerations(engine, {
      notebook_id: notebook.id,
      cell_id: outputCell.id,
    });
    expect(summary.data.generateCellId).toBe(cell.id);
    expect(summary.data.outputCellId).toBe(outputCell.id);
    expect(summary.data.attempts).toHaveLength(1);
    const attempt = summary.data.attempts[0]!;
    expect(attempt.status).toBe("completed");
    expect(attempt.artifactId).toBe(outputAsset.value.artifactId);
    expect(attempt.providerArtifactId).toBe(providerAsset.value.artifactId);
    expect(attempt.payloadAvailable).toBe(true);
    expect("payload" in attempt).toBe(false);
    expect(attempt.commandPlan).toEqual(commandPlan);
    expect(summary.text).not.toContain("\"present\"");

    const withPayloads = await listGenerations(engine, {
      notebook_id: notebook.id,
      cell_id: outputCell.id,
      include_payloads: true,
    });
    const payloadAttempt = withPayloads.data.attempts[0]!;
    expect(payloadAttempt.payloadAvailable).toBe(true);
    expect(payloadAttempt.payload).toEqual(payload);
    expect(withPayloads.text).not.toContain("\"present\"");
  });

  it("resolves a generate_image output-cell pair", async () => {
    const { notebook, cell } = await createNotebookWithCell(engine, "generate_image");
    const outputCell = engine.notebooks.createCell({
      type: "image",
      slot: { row: 1, column: 0 },
      inputs: {
        mediaRole: "generate-image-output",
        producerCellId: cell.id,
      },
    });
    const edge = engine.notebooks.createEdge({
      source: cell.id,
      target: outputCell.id,
      targetInput: "media",
    });
    const written = await mutateNotebook(
      engine,
      notebook.id,
      "run_notebook_cell",
      (current) => ({
        ...current,
        cells: [...current.cells, outputCell],
        edges: [...current.edges, edge],
      }),
      { cellId: cell.id },
    );
    if (!written.ok) throw new Error(written.error.message);

    const providerAsset = await engine.artifacts.create("image", "provider-image");
    const outputAsset = await engine.artifacts.create("image", "cell-image");
    if (!providerAsset.ok) throw new Error(providerAsset.error.message);
    if (!outputAsset.ok) throw new Error(outputAsset.error.message);
    const payload = {
      model: "seedream",
      input: { prompt: "a cat dances" },
    };
    expect((await engine.metadata.artifacts.write(
      outputAsset.value.artifactId,
      "generation-payload",
      payload,
    )).ok).toBe(true);

    const generation = await engine.generations.record({
      notebookId: notebook.id,
      cellId: cell.id,
      tool: "generate_seedream_image",
      providerArtifactId: providerAsset.value.artifactId,
      runId: "run-image-pair",
    });
    if (!generation.ok) throw new Error(generation.error.message);
    await updateGeneration(engine, generation.value.generationId, {
      status: "completed",
      outputArtifactId: outputAsset.value.artifactId,
    });

    const fromTile = await listGenerations(engine, {
      notebook_id: notebook.id,
      cell_id: cell.id,
    });
    expect(fromTile.data.generateCellId).toBe(cell.id);
    expect(fromTile.data.outputCellId).toBe(outputCell.id);
    expect(fromTile.data.attempts[0]?.artifactId).toBe(outputAsset.value.artifactId);

    const fromOutput = await listGenerations(engine, {
      notebook_id: notebook.id,
      cell_id: outputCell.id,
    });
    expect(fromOutput.data.generateCellId).toBe(cell.id);
    expect(fromOutput.data.outputCellId).toBe(outputCell.id);
    expect(fromOutput.data.attempts).toHaveLength(1);
    expect(fromOutput.data.attempts[0]?.status).toBe("completed");
  });

  it("falls back to the recorded job failure error when the row has none", async () => {
    const { notebook, cell } = await createNotebookWithCell(engine);
    const output = await engine.artifacts.create("video", "failed-out");
    if (!output.ok) throw new Error(output.error.message);
    expect((await engine.jobs.failures.write(output.value.artifactId, {
      message: "No valid characters detected in the video",
      failCode: "400",
    })).ok).toBe(true);

    const generation = await recordGeneration(engine, notebook.id, cell.id, "run-9");
    await updateGeneration(engine, generation.generationId, {
      status: "failed",
      outputArtifactId: output.value.artifactId,
    });

    const { data } = await listGenerations(engine, {
      notebook_id: notebook.id,
      cell_id: cell.id,
    });
    expect(data.attempts).toHaveLength(1);
    const attempt = data.attempts[0]!;
    expect(attempt.status).toBe("failed");
    expect(attempt.error).toBe("No valid characters detected in the video");
    expect(attempt.artifactId).toBe(output.value.artifactId);
    expect(
      attempt.transitions.map((transition) => transition.status),
    ).toEqual(["dispatched", "failed"]);
  });
});
