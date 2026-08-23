import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import {
  createEngine,
  type Engine,
  type NotebookCell,
  type NotebookDocument,
} from "videobook-engine";
import {
  registerRunNotebookJob,
  runNotebookCell,
} from "../../server/src/jobs/run-notebook.js";
import {
  queue,
  registerJobHandler,
  setEngineRoot,
  stopBookQueue,
  waitForJob,
} from "../../server/src/queue.js";
import { listCellGenerationsDef } from "../../server/src/tools/list-cell-generations.js";
import type { ListCellGenerationsResponse } from "../../server/src/tools/list-cell-generations.js";

const VIDEO_TOOL = "generate_kie_grok_imagine_text_to_video";
const VIDEO_JOB_TYPE = "generate_grok_imagine_t2v_video";
const PROVIDER_MODEL = "grok-imagine/text-to-video";

describe("notebook generation rows", () => {
  let rootDir: string;
  let engine: Engine;
  let bookId: string;
  let previousKieKey: string | undefined;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "videobook-generations-"));
    engine = createEngine({ rootDir, initialBookName: "generations" });
    await engine.ready;
    bookId = engine.book.get().bookId;
    previousKieKey = process.env.KIE_API_KEY;
    process.env.KIE_API_KEY = "test-kie-key-generations";
    await setEngineRoot(rootDir, engine);
    registerRunNotebookJob(engine);
  });

  afterEach(async () => {
    if (previousKieKey === undefined) delete process.env.KIE_API_KEY;
    else process.env.KIE_API_KEY = previousKieKey;
    await stopBookQueue(bookId);
    engine.close();
    await rm(rootDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  });

  async function seedVideoCell(): Promise<{
    notebookId: string;
    cell: NotebookCell;
    document: NotebookDocument;
  }> {
    const notebook = await engine.notebooks.create("Main");
    if (!notebook.ok) throw new Error(notebook.error.message);
    const cell = engine.notebooks.createCell({
      type: "generate_video",
      label: "Generate skyline video",
      slot: { row: 0, column: 0 },
      prompt: "A quiet skyline",
      provider: "kie",
      model: "GrokTextToVideoRequestSchema",
      operation: "text_to_video",
      tool: VIDEO_TOOL,
      inputs: { generationMode: "default", state: "pending" },
    });
    const written = await engine.notebooks.write({
      ...notebook.value,
      cells: [cell],
    });
    if (!written.ok) throw new Error(written.error.message);
    const read = engine.notebooks.read(notebook.value.id);
    if (!read.ok) throw new Error(read.error.message);
    return { notebookId: notebook.value.id, cell, document: read.value };
  }

  function generationTransitions(
    generationId: string,
  ): Array<{ operation: string; status: string }> {
    return engine.history
      .revisions(500)
      .filter((revision) => revision.details?.generationId === generationId)
      .map((revision) => ({
        operation: revision.operation ?? "",
        status: String(revision.details?.status ?? ""),
      }));
  }

  it("tracks one row through dispatched → awaiting_provider → completed with the provider model", async () => {
    registerJobHandler(VIDEO_JOB_TYPE, async (payload) => {
      const assetId = (payload as { vidAssetId: string }).vidAssetId;
      await engine.files.write(
        assetId,
        "original.mp4",
        Buffer.from("stub provider video bytes"),
      );
      await engine.metadata.artifacts.write(assetId, "original", {
        name: "original.mp4",
      });
      await engine.metadata.artifacts.write(assetId, "generation-payload", {
        model: PROVIDER_MODEL,
        input: {
          prompt: (payload as { prompt?: string }).prompt ?? "",
        },
      });
      return { success: true, taskId: "stub-provider-task" };
    });
    const { notebookId, cell, document } = await seedVideoCell();
    const runId = uuidv7();

    const result = await runNotebookCell(
      engine,
      bookId,
      notebookId,
      document,
      cell,
      { confirmPaid: true, runId },
    );
    expect(result.status).toBe("awaiting-output");

    const dispatched = engine.generations.listForCell(notebookId, cell.id);
    expect(dispatched.ok).toBe(true);
    if (!dispatched.ok) return;
    expect(dispatched.value).toHaveLength(1);
    const row = dispatched.value[0]!;
    expect(row).toMatchObject({
      notebookId,
      cellId: cell.id,
      runId,
      status: "awaiting_provider",
      tool: VIDEO_TOOL,
      provider: "kie",
      model: PROVIDER_MODEL,
      prompt: "A quiet skyline",
      resolvedPrompt: "A quiet skyline",
      providerArtifactId: result.outputArtifactId,
    });
    expect(row.outputCellId).toBeDefined();

    const dispatchedDocument = engine.notebooks.read(notebookId);
    expect(dispatchedDocument.ok).toBe(true);
    if (!dispatchedDocument.ok) return;
    const actionCell = dispatchedDocument.value.cells.find((candidate) =>
      candidate.id === cell.id);
    const outputCell = dispatchedDocument.value.cells.find((candidate) =>
      candidate.id === row.outputCellId);
    expect(actionCell?.model).toBe(PROVIDER_MODEL);
    expect(outputCell?.type).toBe("video");
    expect(outputCell?.model).toBe(PROVIDER_MODEL);
    for (const candidate of dispatchedDocument.value.cells) {
      expect(candidate.model ?? "").not.toMatch(/RequestSchema$/);
    }

    const awaitJobId = `await-notebook-${runId}-${cell.id}-${result.outputArtifactId}`;
    await queue.enqueue(awaitJobId, {
      type: "await_notebook_output",
      bookId,
      notebookId,
      cellId: cell.id,
      providerArtifactId: result.outputArtifactId,
      runId,
    });
    await waitForJob(awaitJobId, 30_000);
    await waitForJob(`resume-notebook-${runId}`, 30_000);

    const completed = engine.generations.listForCell(notebookId, cell.id);
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.value).toHaveLength(1);
    expect(completed.value[0]).toMatchObject({
      generationId: row.generationId,
      status: "completed",
      model: PROVIDER_MODEL,
      providerArtifactId: result.outputArtifactId,
      outputArtifactId: result.outputArtifactId,
      runId,
    });
    expect(completed.value[0]!.error).toBeUndefined();
    expect(generationTransitions(row.generationId)).toEqual([
      { operation: "complete_generation", status: "completed" },
      { operation: "update_generation", status: "awaiting_provider" },
      { operation: "record_generation", status: "dispatched" },
    ]);

    const finished = engine.notebooks.read(notebookId);
    expect(finished.ok).toBe(true);
    if (!finished.ok) return;
    expect(finished.value.execution?.[row.outputCellId ?? ""]?.status)
      .toBe("completed");
    expect(finished.value.execution?.[cell.id]?.status).not.toBe("awaiting-output");
    expect(finished.value.cells.find((candidate) => candidate.id === cell.id)
      ?.inputs?.state).not.toBe("awaiting-output");
    for (const candidate of finished.value.cells) {
      expect(candidate.model ?? "").not.toMatch(/RequestSchema$/);
    }
  }, 60_000);

  it("records one failed row with the provider error truncated to 500 chars", async () => {
    const longMessage = `provider exploded: ${"detail ".repeat(200)}`;
    registerJobHandler(VIDEO_JOB_TYPE, async () => {
      throw new Error(longMessage);
    });
    const { notebookId, cell, document } = await seedVideoCell();
    const runId = uuidv7();

    const result = await runNotebookCell(
      engine,
      bookId,
      notebookId,
      document,
      cell,
      { confirmPaid: true, runId },
    );
    expect(result.status).toBe("awaiting-output");

    const awaitJobId = `await-notebook-${runId}-${cell.id}-${result.outputArtifactId}`;
    await queue.enqueue(awaitJobId, {
      type: "await_notebook_output",
      bookId,
      notebookId,
      cellId: cell.id,
      providerArtifactId: result.outputArtifactId,
      runId,
    });
    await waitForJob(awaitJobId, 30_000);

    const failed = engine.generations.listForCell(notebookId, cell.id);
    expect(failed.ok).toBe(true);
    if (!failed.ok) return;
    expect(failed.value).toHaveLength(1);
    const row = failed.value[0]!;
    expect(row.status).toBe("failed");
    expect(row.runId).toBe(runId);
    expect(row.model).toBe(PROVIDER_MODEL);
    expect(row.error).toBeDefined();
    expect(row.error!.length).toBeLessThanOrEqual(500);
    expect(row.error).toContain("Kie failed:");
    expect(generationTransitions(row.generationId)).toEqual([
      { operation: "fail_generation", status: "failed" },
      { operation: "update_generation", status: "awaiting_provider" },
      { operation: "record_generation", status: "dispatched" },
    ]);

    const notebook = engine.notebooks.read(notebookId);
    expect(notebook.ok).toBe(true);
    if (!notebook.ok) return;
    const outputCellId = failed.value[0]?.outputCellId;
    expect(
      notebook.value.execution?.[outputCellId ?? ""]?.status
      ?? notebook.value.execution?.[cell.id]?.status,
    ).toBe("error");
  }, 60_000);

  it("marks the row failed when dispatch fails before provider handoff", async () => {
    delete process.env.KIE_API_KEY;
    const { notebookId, cell, document } = await seedVideoCell();
    const runId = uuidv7();

    await expect(runNotebookCell(
      engine,
      bookId,
      notebookId,
      document,
      cell,
      { confirmPaid: true, runId },
    )).rejects.toThrow("KIE_API_KEY");

    const failed = engine.generations.listForCell(notebookId, cell.id);
    expect(failed.ok).toBe(true);
    if (!failed.ok) return;
    expect(failed.value).toHaveLength(1);
    const row = failed.value[0]!;
    expect(row.status).toBe("failed");
    expect(row.runId).toBe(runId);
    expect(row.tool).toBe(VIDEO_TOOL);
    expect(row.error).toContain("KIE_API_KEY");
    expect(row.error!.length).toBeLessThanOrEqual(500);
    expect(generationTransitions(row.generationId)).toEqual([
      { operation: "fail_generation", status: "failed" },
      { operation: "record_generation", status: "dispatched" },
    ]);
  }, 60_000);

  // Local ffmpeg cells (extract_audio) run inline and never
  // reach generationTool, so they create no generations rows by design;
  // the two-dispatch case is covered with a stubbed provider generation.
  it("records exactly two rows for two dispatches of the same cell", async () => {
    registerJobHandler(VIDEO_JOB_TYPE, async (payload) => {
      const assetId = (payload as { vidAssetId: string }).vidAssetId;
      await engine.files.write(
        assetId,
        "original.mp4",
        Buffer.from("stub provider video bytes"),
      );
      await engine.metadata.artifacts.write(assetId, "original", {
        name: "original.mp4",
      });
      await engine.metadata.artifacts.write(assetId, "generation-payload", {
        model: PROVIDER_MODEL,
        input: {
          prompt: (payload as { prompt?: string }).prompt ?? "",
        },
      });
      return { success: true, taskId: "stub-provider-task" };
    });
    const { notebookId, cell } = await seedVideoCell();

    const runIds = [uuidv7(), uuidv7()];
    for (const runId of runIds) {
      const fresh = engine.notebooks.read(notebookId);
      if (!fresh.ok) throw new Error(fresh.error.message);
      const freshCell = fresh.value.cells.find((candidate) =>
        candidate.id === cell.id);
      if (!freshCell) throw new Error(`Cell missing: ${cell.id}`);
      const result = await runNotebookCell(
        engine,
        bookId,
        notebookId,
        fresh.value,
        freshCell,
        { confirmPaid: true, runId },
      );
      expect(result.status).toBe("awaiting-output");
      const awaitJobId =
        `await-notebook-${runId}-${cell.id}-${result.outputArtifactId}`;
      await queue.enqueue(awaitJobId, {
        type: "await_notebook_output",
        bookId,
        notebookId,
        cellId: cell.id,
        providerArtifactId: result.outputArtifactId,
        runId,
      });
      await waitForJob(awaitJobId, 30_000);
      await waitForJob(`resume-notebook-${runId}`, 30_000);
    }

    const listed = engine.generations.listForCell(notebookId, cell.id);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value).toHaveLength(2);
    expect(new Set(listed.value.map((row) => row.generationId)).size).toBe(2);
    const byRunId = new Map(listed.value.map((row) => [row.runId, row]));
    expect(new Set(byRunId.keys())).toEqual(new Set(runIds));
    for (const runId of runIds) {
      const row = byRunId.get(runId)!;
      expect(row).toMatchObject({
        notebookId,
        cellId: cell.id,
        status: "completed",
        tool: VIDEO_TOOL,
        provider: "kie",
        model: PROVIDER_MODEL,
      });
      expect(row.outputArtifactId).toBeDefined();
      expect(row.error).toBeUndefined();
      expect(generationTransitions(row.generationId)).toEqual([
        { operation: "complete_generation", status: "completed" },
        { operation: "update_generation", status: "awaiting_provider" },
        { operation: "record_generation", status: "dispatched" },
      ]);
    }

    const response = await listCellGenerationsDef(engine).handler({
      book_id: bookId,
      notebook_id: notebookId,
      cell_id: cell.id,
      limit: 10,
    });
    expect(response.isError).toBeFalsy();
    const data = JSON.parse(
      (response.content as Array<{ type: string; text: string }>)[0]!.text,
    ) as ListCellGenerationsResponse;
    expect(data.attempts).toHaveLength(2);
    expect(new Set(data.attempts.map((attempt) => attempt.attemptId)).size)
      .toBe(2);
    expect(data.attempts.map((attempt) => attempt.status)).toEqual([
      "completed",
      "completed",
    ]);
    expect(new Set(data.attempts.map((attempt) => attempt.runId)))
      .toEqual(new Set(runIds));
    expect(data.generations.count).toBe(2);
    expect(data.generations.latestStatus).toBe("completed");
  }, 60_000);
});
