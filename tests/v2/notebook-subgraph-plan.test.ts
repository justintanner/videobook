import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEngine, type Engine, type NotebookDocument } from "videobook-engine";
import { notebookCellFingerprint } from "../../server/src/jobs/run-notebook.js";
import {
  claimNotebookRunPlan,
  planSelectedNotebookSubgraph,
} from "../../server/src/notebook-run-plan.js";

describe("selected notebook subgraph planning", () => {
  let rootDir: string | undefined;
  let engine: Engine | undefined;

  afterEach(async () => {
    engine?.close();
    if (rootDir) {
      await rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  async function setup(): Promise<Engine> {
    rootDir = await mkdtemp(join(tmpdir(), "vb-subgraph-plan-"));
    engine = createEngine({ rootDir, initialBookName: "subgraph" });
    await engine.ready;
    return engine;
  }

  async function writeGraph(engine: Engine): Promise<{
    document: NotebookDocument;
    current: ReturnType<Engine["notebooks"]["createCell"]>;
    staleUnpaid: ReturnType<Engine["notebooks"]["createCell"]>;
    stalePaid: ReturnType<Engine["notebooks"]["createCell"]>;
    missing: ReturnType<Engine["notebooks"]["createCell"]>;
    target: ReturnType<Engine["notebooks"]["createCell"]>;
    unrelated: ReturnType<Engine["notebooks"]["createCell"]>;
    currentArtifactId: string;
  }> {
    const currentArtifact = await engine.artifacts.create({
      kind: "audio",
      label: "current audio",
    });
    expect(currentArtifact.ok).toBe(true);
    if (!currentArtifact.ok) throw new Error(currentArtifact.error.message);
    const notebook = await engine.notebooks.create("Main");
    expect(notebook.ok).toBe(true);
    if (!notebook.ok) throw new Error(notebook.error.message);

    const current = engine.notebooks.createCell({
      type: "audio",
      label: "Current ancestor",
      slot: { row: 0, column: 0 },
      outputArtifactId: currentArtifact.value.artifactId,
    });
    const staleUnpaid = engine.notebooks.createCell({
      type: "split_video",
      label: "Stale unpaid",
      slot: { row: 1, column: 0 },
      operation: "split_range",
      tool: "ffmpeg",
      provider: "local",
    });
    const stalePaid = engine.notebooks.createCell({
      type: "prompt",
      label: "Stale paid",
      slot: { row: 2, column: 0 },
      operation: "rewrite_prompt",
      tool: "rewrite_prompt",
      provider: "openai",
    });
    const missing = engine.notebooks.createCell({
      type: "generate_image",
      label: "Missing artifact",
      slot: { row: 3, column: 0 },
      operation: "generate_image",
      tool: "generate_seedream_image",
    });
    const target = engine.notebooks.createCell({
      type: "generate_image",
      label: "Target",
      slot: { row: 4, column: 0 },
      operation: "generate_image",
      tool: "generate_seedream_image",
    });
    const unrelated = engine.notebooks.createCell({
      type: "generate_image",
      label: "Unrelated paid",
      slot: { row: 0, column: 4 },
      operation: "generate_image",
      tool: "generate_seedream_image",
    });
    const document: NotebookDocument = {
      ...notebook.value,
      cells: [current, staleUnpaid, stalePaid, missing, target, unrelated],
      edges: [
        engine.notebooks.createEdge({
          source: current.id,
          target: staleUnpaid.id,
          targetInput: "audio",
        }),
        engine.notebooks.createEdge({
          source: staleUnpaid.id,
          target: stalePaid.id,
          targetInput: "source",
        }),
        engine.notebooks.createEdge({
          source: stalePaid.id,
          target: missing.id,
          targetInput: "prompt",
        }),
        engine.notebooks.createEdge({
          source: missing.id,
          target: target.id,
          targetInput: "input",
        }),
      ],
      execution: {},
    };
    document.execution = {
      [current.id]: {
        status: "completed",
        outputArtifactId: currentArtifact.value.artifactId,
        fingerprint: notebookCellFingerprint(document, current),
      },
    };
    const written = await engine.notebooks.write(document);
    expect(written.ok).toBe(true);
    const read = engine.notebooks.read(document.id);
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error("notebook read failed");
    return {
      document: read.value,
      current,
      staleUnpaid,
      stalePaid,
      missing,
      target,
      unrelated,
      currentArtifactId: currentArtifact.value.artifactId,
    };
  }

  it("plans only required ancestors and the target with paid confirmation", async () => {
    const engine = await setup();
    const graph = await writeGraph(engine);
    const plan = await planSelectedNotebookSubgraph(
      engine,
      graph.document,
      graph.target.id,
      "ui",
      "tester",
    );

    const stages = plan.stages as Array<Record<string, unknown>>;
    const cellIds = stages.map((stage) => stage.cellId);
    expect(cellIds).not.toContain(graph.unrelated.id);
    expect(cellIds[cellIds.length - 1]).toBe(graph.target.id);
    expect(cellIds).toEqual([
      ...cellIds.filter((id) => id !== graph.target.id),
      graph.target.id,
    ]);

    const reuse = stages.find((stage) => stage.cellId === graph.current.id);
    expect(reuse).toMatchObject({
      kind: "reuse",
      outputArtifactId: graph.currentArtifactId,
    });

    const unpaid = stages.find((stage) => stage.cellId === graph.staleUnpaid.id);
    expect(unpaid).toMatchObject({ kind: "queued", automatic: true });

    const paid = stages.filter((stage) => stage.requiresCoverage === true);
    expect(paid.map((stage) => stage.cellId)).toEqual(expect.arrayContaining([
      graph.stalePaid.id,
      graph.missing.id,
      graph.target.id,
    ]));
    for (const stage of paid) {
      expect(typeof stage.cellDefinitionFingerprint).toBe("string");
      expect(stage.cellDefinitionFingerprint).toMatch(/\S/);
      expect(stage.input).toEqual(expect.objectContaining({
        connected_media: expect.any(Array),
        cell_definition_fingerprint: stage.cellDefinitionFingerprint,
      }));
    }

    expect(plan.confirmation).toEqual(expect.objectContaining({
      required: true,
      policy: "always",
    }));
    expect((plan.notebookRun as Record<string, unknown>).mode).toBe("subgraph");
    expect((plan.notebookRun as Record<string, unknown>).targetCellId).toBe(graph.target.id);
  });

  it("invalidates a claimed plan after a paid ancestor definition changes", async () => {
    const engine = await setup();
    const graph = await writeGraph(engine);
    const plan = await planSelectedNotebookSubgraph(
      engine,
      graph.document,
      graph.target.id,
      "ui",
      "tester",
    );
    const nextCells = graph.document.cells.map((cell) =>
      cell.id === graph.stalePaid.id
        ? { ...cell, inputs: { ...(cell.inputs ?? {}), prompt: "changed" } }
        : cell);
    const afterPlan = engine.notebooks.read(graph.document.id);
    expect(afterPlan.ok).toBe(true);
    if (!afterPlan.ok) return;
    const rewritten = await engine.notebooks.write({
      ...afterPlan.value,
      cells: nextCells,
    });
    expect(rewritten.ok).toBe(true);

    await expect(claimNotebookRunPlan(
      engine,
      graph.document.id,
      String(plan.planId),
      "run-1",
      { confirmUnpriced: true },
    )).rejects.toThrow(/stale/i);
  });

  it("does not dispatch surprise provider work for cells outside the subgraph", async () => {
    const engine = await setup();
    const graph = await writeGraph(engine);
    const plan = await planSelectedNotebookSubgraph(
      engine,
      graph.document,
      graph.target.id,
      "chat",
      "tester",
    );
    const stages = plan.stages as Array<Record<string, unknown>>;
    expect(stages.some((stage) => stage.cellId === graph.unrelated.id)).toBe(false);
    expect(stages.filter((stage) => stage.kind === "queued").every((stage) =>
      stage.input && typeof stage.input === "object"
      && (stage.input as Record<string, unknown>).subgraph_run === true)).toBe(true);
  });
});
