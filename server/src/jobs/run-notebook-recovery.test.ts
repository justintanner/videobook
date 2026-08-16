import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Engine, JobState } from "videobook-engine";
import { closeEngineForTest, createEngineForTest } from "../fs.js";
import { queue as appQueue, setEngineRoot } from "../queue.js";
import {
  reconcileAwaitingNotebookOutputs,
  registerRunNotebookJob,
  type AwaitNotebookOutputPayload,
} from "./run-notebook.js";

interface AwaitingNotebookFixture {
  bookId: string;
  notebookId: string;
  cellId: string;
  providerArtifactId: string;
  runId: string;
  restoredPlan: Record<string, unknown>;
}

describe("awaiting notebook output startup recovery", () => {
  let rootDir: string;
  let engine: ReturnType<typeof createEngineForTest>;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "videobook-await-recovery-"));
    engine = createEngineForTest(rootDir);
    await engine.ready;
  });

  afterEach(async () => {
    await appQueue.stop();
    closeEngineForTest(rootDir, engine);
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  async function createAwaitingNotebook(): Promise<AwaitingNotebookFixture> {
    const providerArtifact = await engine.artifacts.create({
      kind: "image",
      label: "provider output",
    });
    expect(providerArtifact.ok).toBe(true);
    if (!providerArtifact.ok) throw new Error(providerArtifact.error.message);

    const created = await engine.notebooks.create("Main");
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.error.message);

    const cell = engine.notebooks.createCell({
      type: "generate_image",
      label: "Generate image",
      slot: { row: 0, column: 0 },
      provider: "kie",
      model: "NanoBananaProRequestSchema",
      operation: "text_to_image",
      tool: "generate_kie_nano_banana_pro_text_to_image",
    });
    const runId = "019f0000-0000-7000-8000-000000000021";
    const restoredPlan = {
      planId: "generation-plan-1",
      sourceSurface: "notebook",
      stages: [{ kind: "queued", input: { cell_id: cell.id } }],
    };
    const now = new Date(0).toISOString();
    const written = await engine.notebooks.write({
      ...created.value,
      cells: [cell],
      execution: {
        [cell.id]: {
          fingerprint: "awaiting-fixture",
          status: "awaiting-output",
          providerArtifactId: providerArtifact.value.artifactId,
          outputArtifactId: providerArtifact.value.artifactId,
          runId,
          tool: cell.tool,
        },
      },
      generationPlans: [{
        planId: "generation-plan-1",
        cellId: cell.id,
        status: "awaiting-output",
        plan: restoredPlan,
        createdAt: now,
        updatedAt: now,
      }],
    });
    expect(written.ok).toBe(true);
    if (!written.ok) throw new Error(written.error.message);

    return {
      bookId: engine.book.get().bookId,
      notebookId: created.value.id,
      cellId: cell.id,
      providerArtifactId: providerArtifact.value.artifactId,
      runId,
      restoredPlan,
    };
  }

  function awaitPayload(fixture: AwaitingNotebookFixture): AwaitNotebookOutputPayload {
    return {
      type: "await_notebook_output",
      bookId: fixture.bookId,
      notebookId: fixture.notebookId,
      cellId: fixture.cellId,
      providerArtifactId: fixture.providerArtifactId,
      runId: fixture.runId,
    };
  }

  function enqueueAwaitJob(
    target: Engine,
    fixture: AwaitingNotebookFixture,
    dedupeKey: string,
  ) {
    return target.jobs.queue.enqueue({
      type: "await_notebook_output",
      payload: awaitPayload(fixture) as unknown as Record<string, unknown>,
      dedupeKey,
    }).job;
  }

  async function waitForAwaitJobTerminal(timeoutMs = 5_000): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const jobs = engine.jobs.queue.list({ type: "await_notebook_output" });
      if (jobs.length === 1 && ["done", "failed", "aborted"].includes(jobs[0]!.state)) {
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("await_notebook_output did not reach a terminal state");
  }

  it("does not duplicate an active await job", async () => {
    const fixture = await createAwaitingNotebook();
    enqueueAwaitJob(engine, fixture, "active-await-job");

    const enqueued = await reconcileAwaitingNotebookOutputs(engine, fixture.bookId);

    expect(enqueued).toBe(0);
    expect(engine.jobs.queue.list({ type: "await_notebook_output" })).toMatchObject([
      { state: "queued", payload: awaitPayload(fixture) },
    ]);
  });

  it.each(["failed", "aborted"] satisfies JobState[])(
    "transitions an awaiting cell to failure when its await job is %s",
    async (terminalState) => {
      const fixture = await createAwaitingNotebook();
      const job = enqueueAwaitJob(engine, fixture, `terminal-await-${terminalState}`);
      const message = `await job ${terminalState} during restart`;
      if (terminalState === "aborted") {
        expect(await engine.jobs.queue.abort(job.id, message)).toBe(true);
      } else {
        const running = engine.jobs.queue.dequeue(process.pid, 60_000);
        expect(running?.id).toBe(job.id);
        if (!running) throw new Error("await job was not dequeued");
        expect(await engine.jobs.queue.fail(
          running.id,
          { error: { message }, allowRetry: false },
          running.fence,
        )).toBe(true);
      }

      const enqueued = await reconcileAwaitingNotebookOutputs(engine, fixture.bookId);

      expect(enqueued).toBe(0);
      const notebook = engine.notebooks.read(fixture.notebookId);
      expect(notebook.ok).toBe(true);
      if (!notebook.ok) return;
      expect(notebook.value.execution?.[fixture.cellId]).toMatchObject({
        status: "error",
        providerArtifactId: fixture.providerArtifactId,
        outputArtifactId: fixture.providerArtifactId,
        runId: fixture.runId,
        error: message,
      });
      expect(notebook.value.cells[0]?.inputs).toMatchObject({ state: "error" });
    },
  );

  it("re-enqueues one orphan await job with its persisted plan", async () => {
    const fixture = await createAwaitingNotebook();
    const failed = await engine.jobs.failures.write(fixture.providerArtifactId, {
      message: "provider failed while the server was offline",
    });
    expect(failed.ok).toBe(true);
    registerRunNotebookJob(engine);
    await setEngineRoot(rootDir, engine);

    const enqueued = await reconcileAwaitingNotebookOutputs(engine, fixture.bookId);

    expect(enqueued).toBe(1);
    const jobs = engine.jobs.queue.list({ type: "await_notebook_output" });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toMatchObject({
      ...awaitPayload(fixture),
      generationPlan: fixture.restoredPlan,
      cellIds: [fixture.cellId],
      actor: "notebook-reconciler",
    });
    await waitForAwaitJobTerminal();
    expect(await reconcileAwaitingNotebookOutputs(engine, fixture.bookId)).toBe(0);
    expect(engine.jobs.queue.list({ type: "await_notebook_output" })).toHaveLength(1);
  });
});
