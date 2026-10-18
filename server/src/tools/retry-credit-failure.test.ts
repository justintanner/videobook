import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { v7 as uuidv7 } from "uuid";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine, NotebookCell, NotebookDocument } from "videobook-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngineForTest } from "../engine.js";
import { createTestClient } from "../test-client.js";
import { pauseBookQueueForTests, queue } from "../queue.js";
import { failPendingTaskAndLog } from "../jobs/task-failure.js";
import { notebookCellDefinitionFingerprint } from "../jobs/run-notebook.js";

function value<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("retrying a notebook output after credit exhaustion", () => {
  let client: Client;
  let root: string;
  let engine: Engine;
  let bookId: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "videobook-credit-retry-"));
    client = await createTestClient(root);
    engine = createEngineForTest(root);
    bookId = engine.book.get().bookId;
    await pauseBookQueueForTests(bookId);
  });

  afterEach(async () => {
    await client.close();
    await queue.stop();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  async function setup(media: "image" | "video" | "audio", message = "Insufficient credits") {
    const notebook = value(await engine.notebooks.create("Retry"));
    const artifact = value(await engine.artifacts.create(media, "Failed output"));
    const lease = await engine.jobs.artifactWork.begin(artifact.artifactId, {
      kind: "generate", ownerKind: "job", durationMs: 60_000,
    });
    if (!lease) throw new Error("Could not claim fixture artifact");
    value(await engine.jobs.pending.write({
      taskId: "credit-failure", taskType: "generate_media", artifactId: artifact.artifactId, meta: {},
    }, lease.ownerId));
    await failPendingTaskAndLog(engine, artifact.artifactId, "credit-failure", { message });
    const producer = engine.notebooks.createCell({
      type: `generate_${media}`, slot: { row: 0, column: 0 },
      prompt: "Saved prompt", provider: "kie", model: "kie:nano-banana-2-1",
      tool: `generate_${media}`, inputs: { generationSettings: { seed: 42 } },
    });
    const output = engine.notebooks.createCell({
      type: media, slot: { row: 2, column: 0 }, outputArtifactId: artifact.artifactId,
      inputs: { producerCellId: producer.id, mediaRole: `generate-${media}-output`, state: "error" },
    });
    const source = engine.notebooks.createCell({ type: "prompt", slot: { row: 0, column: 1 }, prompt: "Reference prompt" });
    const sibling = engine.notebooks.createCell({ type: media, slot: { row: 2, column: 1 }, inputs: { state: "completed" } });
    const edges = [
      engine.notebooks.createEdge({ source: source.id, target: producer.id, targetInput: "prompt" }),
      engine.notebooks.createEdge({ source: producer.id, target: output.id, targetInput: "media" }),
      ...(media === "audio" ? [] : [engine.notebooks.createEdge({ source: producer.id, target: sibling.id, targetInput: "media" })]),
    ];
    const document: NotebookDocument = {
      ...notebook, cells: [producer, output, source, sibling], edges,
      execution: { [output.id]: { fingerprint: "failed", status: "error", error: message, providerArtifactId: artifact.artifactId } },
    };
    const plan = { planId: uuidv7(), cellDefinitionFingerprint: notebookCellDefinitionFingerprint(document, producer) };
    const now = new Date().toISOString();
    value(await engine.notebooks.write({
      ...document,
      generationPlans: [{ planId: plan.planId, cellId: producer.id, status: "planned", plan, createdAt: now, updatedAt: now }],
    }));
    const args = { book_id: bookId, notebook_id: notebook.id, cell_id: producer.id, plan, retry_failed_cell_id: output.id };
    const persisted = value(engine.notebooks.read(notebook.id));
    const saved = (cell: NotebookCell) => persisted.cells.find((candidate) => candidate.id === cell.id)!;
    return { notebook, producer: saved(producer), output: saved(output), source: saved(source), sibling: saved(sibling), edges, artifact, args };
  }

  it.each(["image", "video", "audio"] as const)("replaces only the failed %s cell and queues the saved generator", async (media) => {
    const fixture = await setup(media);
    const result = await client.callTool({ name: "run_notebook_cell", arguments: fixture.args });
    expect(result.isError, JSON.stringify(result)).toBeFalsy();
    const document = value(engine.notebooks.read(fixture.notebook.id));
    expect(document.cells.find((cell) => cell.id === fixture.output.id)).toBeUndefined();
    expect(document.execution?.[fixture.output.id]).toBeUndefined();
    expect(document.cells.find((cell) => cell.id === fixture.producer.id)).toEqual(media === "audio"
      ? { ...fixture.producer, inputs: { ...fixture.producer.inputs, state: "queued" } }
      : fixture.producer);
    expect(document.cells.find((cell) => cell.id === fixture.source.id)).toEqual(fixture.source);
    expect(document.cells.find((cell) => cell.id === fixture.sibling.id)).toEqual(fixture.sibling);
    const replacement = document.cells.find((cell) => ![fixture.producer.id, fixture.source.id, fixture.sibling.id].includes(cell.id))!;
    expect(replacement.type).toBe(media);
    expect(replacement.slot).toEqual(fixture.output.slot);
    expect(replacement.outputArtifactId).toBeUndefined();
    expect(document.execution?.[replacement.id]?.status).toBe("queued");
    expect(document.edges).toContainEqual(fixture.edges[0]);
    if (fixture.edges[2]) expect(document.edges).toContainEqual(fixture.edges[2]);
    expect(document.edges.some((edge) => edge.source === fixture.output.id || edge.target === fixture.output.id)).toBe(false);
    expect(engine.jobs.queue.list({ type: "run_notebook" })).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ cellIds: [fixture.producer.id], outputCellId: replacement.id }) }),
    ]);
  });

  it.each(["Rate limit exceeded", "Invalid duration", "quota exceeded: too many reference images"])("refuses unrelated failure %s without deleting anything", async (message) => {
    const fixture = await setup("video", message);
    const before = value(engine.notebooks.read(fixture.notebook.id));
    const result = await client.callTool({ name: "run_notebook_cell", arguments: fixture.args });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("only available for an out-of-credits failure");
    expect(value(engine.notebooks.read(fixture.notebook.id)).cells).toEqual(before.cells);
    expect(engine.jobs.queue.list({ type: "run_notebook" })).toEqual([]);
  });

  it("rejects a recovered output even when the client still shows its old credit error", async () => {
    const fixture = await setup("image");
    value(await engine.jobs.failures.clear(fixture.artifact.artifactId));
    const result = await client.callTool({ name: "run_notebook_cell", arguments: fixture.args });
    expect(result.isError).toBe(true);
    expect(value(engine.notebooks.read(fixture.notebook.id)).cells).toContainEqual(fixture.output);
    expect(engine.jobs.queue.list({ type: "run_notebook" })).toEqual([]);
  });

  it("does not delete an output if the generator was edited after planning", async () => {
    const fixture = await setup("image");
    const document = value(engine.notebooks.read(fixture.notebook.id));
    value(await engine.notebooks.write({
      ...document, cells: document.cells.map((cell): NotebookCell => cell.id === fixture.producer.id ? { ...cell, prompt: "Changed" } : cell),
    }));
    const result = await client.callTool({ name: "run_notebook_cell", arguments: fixture.args });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("stale");
    expect(value(engine.notebooks.read(fixture.notebook.id)).cells).toContainEqual(fixture.output);
  });

  it("accepts one attempt when Retry is submitted twice", async () => {
    const fixture = await setup("video");
    const results = await Promise.all([
      client.callTool({ name: "run_notebook_cell", arguments: fixture.args }),
      client.callTool({ name: "run_notebook_cell", arguments: fixture.args }),
    ]);
    expect(results.filter((result) => !result.isError)).toHaveLength(1);
    expect(engine.jobs.queue.list({ type: "run_notebook" })).toHaveLength(1);
    expect(value(engine.notebooks.read(fixture.notebook.id)).cells).toHaveLength(4);
  });

  it("refuses to replace an audio result that shares a generator with other media", async () => {
    const fixture = await setup("audio");
    const document = value(engine.notebooks.read(fixture.notebook.id));
    value(await engine.notebooks.write({
      ...document, edges: [...document.edges, engine.notebooks.createEdge({
        source: fixture.producer.id, target: fixture.sibling.id, targetInput: "media",
      })],
    }));
    const result = await client.callTool({ name: "run_notebook_cell", arguments: fixture.args });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("another audio output");
    expect(value(engine.notebooks.read(fixture.notebook.id)).cells).toContainEqual(fixture.output);
    expect(engine.jobs.queue.list({ type: "run_notebook" })).toEqual([]);
  });

  it("preserves earlier output versions instead of deleting their cell", async () => {
    const fixture = await setup("audio");
    const previous = value(await engine.artifacts.create("audio", "Earlier output"));
    const document = value(engine.notebooks.read(fixture.notebook.id));
    value(await engine.notebooks.write({
      ...document, cells: document.cells.map((cell) => cell.id === fixture.output.id
        ? { ...cell, inputs: { ...cell.inputs, outputVersionArtifactIds: [previous.artifactId, fixture.artifact.artifactId] } }
        : cell),
    }));
    const result = await client.callTool({ name: "run_notebook_cell", arguments: fixture.args });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("earlier media");
    expect(value(engine.notebooks.read(fixture.notebook.id)).cells.some((cell) => cell.id === fixture.output.id)).toBe(true);
    expect(engine.jobs.queue.list({ type: "run_notebook" })).toEqual([]);
  });
});
