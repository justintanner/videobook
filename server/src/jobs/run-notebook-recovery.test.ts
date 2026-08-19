import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Engine, JobState } from "videobook-engine";
import { closeEngineForTest, createEngineForTest } from "../engine.js";
import { claimNotebookRunPlan } from "../notebook-run-plan.js";
import { queue as appQueue, setEngineRoot } from "../queue.js";
import {
  abortLeasedNotebookRunsOnStartup,
  failQueuedNotebookCells,
  markNotebookCellQueued,
  notebookCellDefinitionFingerprint,
  reconcileAwaitingNotebookOutputs,
  reconcileQueuedNotebookCells,
  registerRunNotebookJob,
  type AwaitNotebookOutputPayload,
  type RunNotebookPayload,
} from "./run-notebook.js";

interface AwaitingNotebookFixture {
  bookId: string;
  notebookId: string;
  cellId: string;
  providerArtifactId: string;
  runId: string;
  restoredPlan: Record<string, unknown>;
}

interface StalePaidNotebookFixture {
  bookId: string;
  notebookId: string;
  upstreamCellId: string;
  targetCellId: string;
  runId: string;
  plan: Record<string, unknown>;
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

  async function createStalePaidNotebook(options: {
    legacyUnboundPlan?: boolean;
  } = {}): Promise<StalePaidNotebookFixture> {
    const created = await engine.notebooks.create("Paid prerequisites");
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.error.message);
    const upstream = engine.notebooks.createCell({
      type: "generate_image",
      label: "Paid prerequisite",
      slot: { row: 0, column: 0 },
      prompt: "An establishing frame",
      provider: "kie",
      model: "NanoBananaProRequestSchema",
      operation: "text_to_image",
      tool: "generate_kie_nano_banana_pro_text_to_image",
    });
    const target = engine.notebooks.createCell({
      type: "generate_image",
      label: "Paid target",
      slot: { row: 0, column: 1 },
      prompt: "A continuation frame",
      provider: "kie",
      model: "NanoBananaProRequestSchema",
      operation: "text_to_image",
      tool: "generate_kie_nano_banana_pro_text_to_image",
    });
    const document = {
      ...created.value,
      cells: [upstream, target],
      edges: [engine.notebooks.createEdge({
        source: upstream.id,
        target: target.id,
        targetInput: "image",
      })],
    };
    const runId = "019f0000-0000-7000-8000-000000000031";
    const planId = "generation-plan-stale-paid-target";
    const plan = {
      planId,
      cellDefinitionFingerprint: notebookCellDefinitionFingerprint(document, target),
      stages: [{ kind: "queued", input: { cell_id: target.id } }],
      ...(options.legacyUnboundPlan
        ? {}
        : { executionClaim: { runId, claimedAt: new Date(0).toISOString() } }),
    };
    const now = new Date(0).toISOString();
    const written = await engine.notebooks.write({
      ...document,
      generationPlans: [{
        planId,
        cellId: target.id,
        status: "queued",
        plan,
        createdAt: now,
        updatedAt: now,
      }],
    });
    expect(written.ok).toBe(true);
    if (!written.ok) throw new Error(written.error.message);
    await markNotebookCellQueued(engine, created.value.id, target.id, runId);
    return {
      bookId: engine.book.get().bookId,
      notebookId: created.value.id,
      upstreamCellId: upstream.id,
      targetCellId: target.id,
      runId,
      plan,
    };
  }

  function runPayload(fixture: StalePaidNotebookFixture): RunNotebookPayload {
    return {
      type: "run_notebook",
      bookId: fixture.bookId,
      notebookId: fixture.notebookId,
      cellIds: [fixture.targetCellId],
      force: true,
      runId: fixture.runId,
      generationPlan: fixture.plan,
    };
  }

  async function failRunJob(
    fixture: StalePaidNotebookFixture,
    dedupeKey: string,
    message: string,
  ): Promise<void> {
    const job = engine.jobs.queue.enqueue({
      type: "run_notebook",
      payload: runPayload(fixture) as unknown as Record<string, unknown>,
      dedupeKey,
    }).job;
    const running = engine.jobs.queue.dequeue(process.pid, 60_000);
    expect(running?.id).toBe(job.id);
    if (!running) throw new Error("run_notebook job was not dequeued");
    expect(await engine.jobs.queue.fail(
      running.id,
      { error: { message }, allowRetry: false },
      running.fence,
    )).toBe(true);
  }

  async function completeRunJob(
    fixture: StalePaidNotebookFixture,
    dedupeKey: string,
  ): Promise<void> {
    const job = engine.jobs.queue.enqueue({
      type: "run_notebook",
      payload: runPayload(fixture) as unknown as Record<string, unknown>,
      dedupeKey,
    }).job;
    const running = engine.jobs.queue.dequeue(process.pid, 60_000);
    expect(running?.id).toBe(job.id);
    if (!running) throw new Error("run_notebook job was not dequeued");
    expect(await engine.jobs.queue.complete(
      running.id,
      { result: { status: "completed" } },
      running.fence,
    )).toBe(true);
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

  it("repairs a queued cell and plan after its run job failed", async () => {
    const fixture = await createStalePaidNotebook({ legacyUnboundPlan: true });
    const message = "server stopped after the run failed";
    await failRunJob(fixture, "terminal-run-notebook", message);

    expect(await reconcileQueuedNotebookCells(engine)).toBe(1);

    const notebook = engine.notebooks.read(fixture.notebookId);
    expect(notebook.ok).toBe(true);
    if (!notebook.ok) return;
    expect(notebook.value.execution?.[fixture.targetCellId]).toMatchObject({
      status: "error",
      runId: fixture.runId,
      error: message,
    });
    expect(notebook.value.cells.find((cell) =>
      cell.id === fixture.targetCellId)?.inputs).toMatchObject({ state: "error" });
    expect(notebook.value.generationPlans).toEqual([
      expect.objectContaining({
        planId: fixture.plan.planId,
        cellId: fixture.targetCellId,
        status: "failed",
        error: message,
      }),
    ]);
  });

  it("repairs a queued cell after startup reaps its expired run lease", async () => {
    const fixture = await createStalePaidNotebook();
    const job = engine.jobs.queue.enqueue({
      type: "run_notebook",
      payload: runPayload(fixture) as unknown as Record<string, unknown>,
      dedupeKey: "expired-startup-run-notebook",
      maxAttempts: 1,
    }).job;
    const running = engine.jobs.queue.dequeue(process.pid, -1);
    expect(running?.id).toBe(job.id);

    expect(await engine.jobs.queue.reap()).toEqual({ requeued: 0, failed: 1 });
    expect(await reconcileQueuedNotebookCells(engine)).toBe(1);

    const notebook = engine.notebooks.read(fixture.notebookId);
    expect(notebook.ok).toBe(true);
    if (!notebook.ok) return;
    expect(notebook.value.execution?.[fixture.targetCellId]).toMatchObject({
      status: "error",
      runId: fixture.runId,
      error: "Job lease expired",
    });
    expect(notebook.value.generationPlans?.[0]).toMatchObject({
      status: "failed",
      error: "Job lease expired",
    });
  });

  it("aborts and repairs an unexpired run lease during cold startup", async () => {
    const fixture = await createStalePaidNotebook();
    const job = engine.jobs.queue.enqueue({
      type: "run_notebook",
      payload: runPayload(fixture) as unknown as Record<string, unknown>,
      dedupeKey: "unexpired-cold-start-run-notebook",
      maxAttempts: 1,
    }).job;
    const running = engine.jobs.queue.dequeue(process.pid, 60_000);
    expect(running?.id).toBe(job.id);

    expect(await engine.jobs.queue.reap()).toEqual({ requeued: 0, failed: 0 });
    expect(await abortLeasedNotebookRunsOnStartup(engine)).toBe(1);
    expect(await reconcileQueuedNotebookCells(engine)).toBe(1);

    expect(engine.jobs.queue.get(job.id)).toMatchObject({
      state: "aborted",
      error: { message: "Server restarted before notebook run completed" },
    });
    const notebook = engine.notebooks.read(fixture.notebookId);
    expect(notebook.ok).toBe(true);
    if (!notebook.ok) return;
    expect(notebook.value.execution?.[fixture.targetCellId]).toMatchObject({
      status: "error",
      runId: fixture.runId,
      error: "Server restarted before notebook run completed",
    });
    expect(notebook.value.generationPlans?.[0]).toMatchObject({
      status: "failed",
      error: "Server restarted before notebook run completed",
    });
  });

  it("repairs an exactly claimed cell when the enqueue job is missing", async () => {
    const fixture = await createStalePaidNotebook();

    expect(await reconcileQueuedNotebookCells(engine)).toBe(1);

    const notebook = engine.notebooks.read(fixture.notebookId);
    expect(notebook.ok).toBe(true);
    if (!notebook.ok) return;
    expect(notebook.value.execution?.[fixture.targetCellId]).toMatchObject({
      status: "error",
      runId: fixture.runId,
      error: expect.stringContaining("no persisted job"),
    });
    expect(notebook.value.generationPlans?.[0]).toMatchObject({
      status: "failed",
      plan: {
        executionClaim: { runId: fixture.runId },
      },
    });
  });

  it("repairs a queued local cell when its enqueue job is missing", async () => {
    const created = await engine.notebooks.create("Local no-job run");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const cell = engine.notebooks.createCell({
      type: "prompt",
      label: "Local operation",
      slot: { row: 0, column: 0 },
      operation: "local_test_operation",
    });
    const written = await engine.notebooks.write({
      ...created.value,
      cells: [cell],
    });
    expect(written.ok).toBe(true);
    const runId = "019f0000-0000-7000-8000-000000000051";
    await markNotebookCellQueued(engine, created.value.id, cell.id, runId);

    expect(await reconcileQueuedNotebookCells(engine)).toBe(1);

    const notebook = engine.notebooks.read(created.value.id);
    expect(notebook.ok).toBe(true);
    if (!notebook.ok) return;
    expect(notebook.value.execution?.[cell.id]).toMatchObject({
      status: "error",
      runId,
      error: expect.stringContaining("no persisted job"),
    });
  });

  it("repairs every queued local selection when its enqueue job is missing", async () => {
    const created = await engine.notebooks.create("Local multi-cell no-job run");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const cells = [0, 1].map((column) => engine.notebooks.createCell({
      type: "prompt",
      label: `Local operation ${column + 1}`,
      slot: { row: 0, column },
      operation: "local_test_operation",
    }));
    const written = await engine.notebooks.write({
      ...created.value,
      cells,
    });
    expect(written.ok).toBe(true);
    const runId = "019f0000-0000-7000-8000-000000000052";
    for (const cell of cells) {
      await markNotebookCellQueued(engine, created.value.id, cell.id, runId);
    }

    expect(await reconcileQueuedNotebookCells(engine)).toBe(2);

    const notebook = engine.notebooks.read(created.value.id);
    expect(notebook.ok).toBe(true);
    if (!notebook.ok) return;
    for (const cell of cells) {
      expect(notebook.value.execution?.[cell.id]).toMatchObject({
        status: "error",
        runId,
        error: expect.stringContaining("no persisted job"),
      });
    }
  });

  it("keeps a queued claim when the newest terminal retry completed", async () => {
    const fixture = await createStalePaidNotebook();
    await failRunJob(
      fixture,
      "older-failed-run",
      "older attempt failed",
    );
    await completeRunJob(fixture, "newer-completed-run");

    expect(await reconcileQueuedNotebookCells(engine)).toBe(0);

    const notebook = engine.notebooks.read(fixture.notebookId);
    expect(notebook.ok).toBe(true);
    if (!notebook.ok) return;
    expect(notebook.value.execution?.[fixture.targetCellId]).toMatchObject({
      status: "queued",
      runId: fixture.runId,
    });
    expect(notebook.value.generationPlans?.[0]).toMatchObject({
      status: "queued",
    });
  });

  it("does not repair a queued cell while its run job is active", async () => {
    const fixture = await createStalePaidNotebook();
    await failRunJob(
      fixture,
      "terminal-before-active-resume",
      "parent run failed before resume was queued",
    );
    engine.jobs.queue.enqueue({
      type: "run_notebook",
      payload: {
        ...runPayload(fixture),
        resume: true,
      } as unknown as Record<string, unknown>,
      dedupeKey: "active-run-notebook",
    });

    expect(await reconcileQueuedNotebookCells(engine)).toBe(0);

    const notebook = engine.notebooks.read(fixture.notebookId);
    expect(notebook.ok).toBe(true);
    if (!notebook.ok) return;
    expect(notebook.value.execution?.[fixture.targetCellId]).toMatchObject({
      status: "queued",
      runId: fixture.runId,
    });
    expect(notebook.value.generationPlans?.[0]).toMatchObject({ status: "queued" });
  });

  it("does not repair a queued target while an upstream await job is active", async () => {
    const fixture = await createStalePaidNotebook();
    await failRunJob(
      fixture,
      "terminal-before-active-await",
      "parent run failed while provider output was pending",
    );
    const providerArtifact = await engine.artifacts.create({
      kind: "image",
      label: "upstream provider output",
    });
    expect(providerArtifact.ok).toBe(true);
    if (!providerArtifact.ok) return;
    engine.jobs.queue.enqueue({
      type: "await_notebook_output",
      payload: {
        type: "await_notebook_output",
        bookId: fixture.bookId,
        notebookId: fixture.notebookId,
        cellId: fixture.upstreamCellId,
        providerArtifactId: providerArtifact.value.artifactId,
        runId: fixture.runId,
      },
      dedupeKey: "active-upstream-await",
    });

    expect(await reconcileQueuedNotebookCells(engine)).toBe(0);

    const notebook = engine.notebooks.read(fixture.notebookId);
    expect(notebook.ok).toBe(true);
    if (!notebook.ok) return;
    expect(notebook.value.execution?.[fixture.targetCellId]).toMatchObject({
      status: "queued",
      runId: fixture.runId,
    });
  });

  it("repairs a terminal run when provider markers have no live work", async () => {
    const fixture = await createStalePaidNotebook();
    const providerArtifact = await engine.artifacts.create({
      kind: "image",
      label: "orphan provider marker",
    });
    expect(providerArtifact.ok).toBe(true);
    if (!providerArtifact.ok) return;
    const read = engine.notebooks.read(fixture.notebookId);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const execution = read.value.execution?.[fixture.targetCellId];
    if (!execution) throw new Error("queued execution missing");
    const written = await engine.notebooks.write({
      ...read.value,
      execution: {
        ...read.value.execution,
        [fixture.targetCellId]: {
          ...execution,
          providerArtifactId: providerArtifact.value.artifactId,
        },
      },
    });
    expect(written.ok).toBe(true);
    const generation = await engine.generations.record({
      notebookId: fixture.notebookId,
      cellId: fixture.targetCellId,
      runId: fixture.runId,
      status: "awaiting_provider",
      tool: "generate_kie_nano_banana_pro_text_to_image",
      providerArtifactId: providerArtifact.value.artifactId,
    });
    expect(generation.ok).toBe(true);
    await failRunJob(
      fixture,
      "terminal-with-orphan-provider-markers",
      "run failed after provider work disappeared",
    );

    expect(await reconcileQueuedNotebookCells(engine)).toBe(1);

    const notebook = engine.notebooks.read(fixture.notebookId);
    expect(notebook.ok).toBe(true);
    if (!notebook.ok) return;
    expect(notebook.value.execution?.[fixture.targetCellId]).toMatchObject({
      status: "error",
      providerArtifactId: providerArtifact.value.artifactId,
      error: "run failed after provider work disappeared",
    });
    expect(notebook.value.generationPlans?.[0]).toMatchObject({
      status: "failed",
    });
  });

  it("does not repair a passive cell carrying legacy queued state", async () => {
    const fixture = await createStalePaidNotebook();
    await failRunJob(
      fixture,
      "terminal-passive-cell",
      "legacy passive execution was left queued",
    );
    const read = engine.notebooks.read(fixture.notebookId);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const written = await engine.notebooks.write({
      ...read.value,
      cells: read.value.cells.map((cell) =>
        cell.id === fixture.targetCellId ? { ...cell, type: "image" } : cell),
    });
    expect(written.ok).toBe(true);

    expect(await reconcileQueuedNotebookCells(engine)).toBe(0);

    const notebook = engine.notebooks.read(fixture.notebookId);
    expect(notebook.ok).toBe(true);
    if (!notebook.ok) return;
    expect(notebook.value.execution?.[fixture.targetCellId]).toMatchObject({
      status: "queued",
    });
  });

  it("leaves a no-job orphan and its ambiguous plans unchanged", async () => {
    const fixture = await createStalePaidNotebook({ legacyUnboundPlan: true });
    const read = engine.notebooks.read(fixture.notebookId);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const original = read.value.generationPlans?.[0];
    if (!original) throw new Error("generation plan missing");
    const written = await engine.notebooks.write({
      ...read.value,
      generationPlans: [
        original,
        {
          ...original,
          planId: "generation-plan-ambiguous-second",
          plan: {
            ...original.plan,
            planId: "generation-plan-ambiguous-second",
          },
        },
      ],
    });
    expect(written.ok).toBe(true);

    expect(await reconcileQueuedNotebookCells(engine)).toBe(0);

    const notebook = engine.notebooks.read(fixture.notebookId);
    expect(notebook.ok).toBe(true);
    if (!notebook.ok) return;
    expect(notebook.value.execution?.[fixture.targetCellId]).toMatchObject({
      status: "queued",
    });
    expect(notebook.value.generationPlans?.map((plan) => plan.status)).toEqual([
      "queued",
      "queued",
    ]);
  });

  it("preserves an awaiting-output run plan when a queued branch fails", async () => {
    const fixture = await createStalePaidNotebook();
    const read = engine.notebooks.read(fixture.notebookId);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const now = new Date(0).toISOString();
    const runPlanId = "notebook-run-plan-awaiting-output";
    const written = await engine.notebooks.write({
      ...read.value,
      generationPlans: [],
      notebookRunPlans: [{
        planId: runPlanId,
        status: "awaiting-output",
        plan: { planId: runPlanId },
        paidCellIds: [fixture.upstreamCellId, fixture.targetCellId],
        cellDefinitionFingerprints: {},
        knownCostUsd: 0,
        unknownCostCount: 0,
        createdAt: now,
        updatedAt: now,
        runId: fixture.runId,
      }],
    });
    expect(written.ok).toBe(true);

    expect(await failQueuedNotebookCells(engine, fixture.notebookId, {
      cellIds: [fixture.targetCellId],
      runId: fixture.runId,
      runPlanId,
      error: "another branch failed while provider output is pending",
    })).toBe(1);

    const notebook = engine.notebooks.read(fixture.notebookId);
    expect(notebook.ok).toBe(true);
    if (!notebook.ok) return;
    expect(notebook.value.execution?.[fixture.targetCellId]).toMatchObject({
      status: "error",
    });
    expect(notebook.value.notebookRunPlans?.[0]).toMatchObject({
      planId: runPlanId,
      status: "awaiting-output",
    });
  });

  it("atomically binds one run id when an aggregate plan is claimed twice", async () => {
    const fixture = await createStalePaidNotebook();
    const read = engine.notebooks.read(fixture.notebookId);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const now = new Date(0).toISOString();
    const planId = "notebook-run-plan-atomic-claim";
    const written = await engine.notebooks.write({
      ...read.value,
      notebookRunPlans: [{
        planId,
        status: "planned",
        plan: {
          planId,
          notebookRun: { noOp: false, force: false },
        },
        paidCellIds: [],
        cellDefinitionFingerprints: {},
        knownCostUsd: 0,
        unknownCostCount: 0,
        createdAt: now,
        updatedAt: now,
      }],
    });
    expect(written.ok).toBe(true);
    const runIds = [
      "019f0000-0000-7000-8000-000000000041",
      "019f0000-0000-7000-8000-000000000042",
    ];

    const claims = await Promise.allSettled(runIds.map((runId) =>
      claimNotebookRunPlan(engine, fixture.notebookId, planId, runId, {
        confirmUnpriced: true,
      })));

    expect(claims.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(claims.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rejection = claims.find((result) => result.status === "rejected");
    expect(rejection?.reason).toEqual(expect.objectContaining({
      message: "Notebook run plan is already queued",
    }));
    const notebook = engine.notebooks.read(fixture.notebookId);
    expect(notebook.ok).toBe(true);
    if (!notebook.ok) return;
    expect(notebook.value.notebookRunPlans?.[0]).toMatchObject({
      planId,
      status: "queued",
      runId: expect.stringMatching(/00000000004[12]$/),
    });
  });

  it("fails an exactly bound aggregate plan when its enqueue job is missing", async () => {
    const fixture = await createStalePaidNotebook();
    const read = engine.notebooks.read(fixture.notebookId);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const now = new Date(0).toISOString();
    const planId = "notebook-run-plan-missing-job";
    const written = await engine.notebooks.write({
      ...read.value,
      execution: {},
      generationPlans: [],
      notebookRunPlans: [{
        planId,
        status: "queued",
        plan: { planId, notebookRun: { noOp: false } },
        paidCellIds: [],
        cellDefinitionFingerprints: {},
        knownCostUsd: 0,
        unknownCostCount: 0,
        createdAt: now,
        updatedAt: now,
        runId: fixture.runId,
      }],
    });
    expect(written.ok).toBe(true);

    expect(await reconcileQueuedNotebookCells(engine)).toBe(1);

    const notebook = engine.notebooks.read(fixture.notebookId);
    expect(notebook.ok).toBe(true);
    if (!notebook.ok) return;
    expect(notebook.value.notebookRunPlans?.[0]).toMatchObject({
      planId,
      status: "failed",
      runId: fixture.runId,
      error: "Claimed aggregate notebook run has no persisted job",
    });
  });

  it("does not fail a generation plan when the same-run cell is already running", async () => {
    const fixture = await createStalePaidNotebook();
    const read = engine.notebooks.read(fixture.notebookId);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const execution = read.value.execution?.[fixture.targetCellId];
    if (!execution) throw new Error("queued execution missing");
    const written = await engine.notebooks.write({
      ...read.value,
      execution: {
        ...read.value.execution,
        [fixture.targetCellId]: { ...execution, status: "running" },
      },
    });
    expect(written.ok).toBe(true);

    expect(await failQueuedNotebookCells(engine, fixture.notebookId, {
      cellIds: [fixture.targetCellId],
      runId: fixture.runId,
      generationPlanId: String(fixture.plan.planId),
      error: "stale worker failure",
    })).toBe(0);

    const notebook = engine.notebooks.read(fixture.notebookId);
    expect(notebook.ok).toBe(true);
    if (!notebook.ok) return;
    expect(notebook.value.execution?.[fixture.targetCellId]).toMatchObject({
      status: "running",
    });
    expect(notebook.value.generationPlans?.[0]).toMatchObject({
      status: "queued",
    });
  });

  it("rejects paid worker execution when the stored plan claim has another run id", async () => {
    const fixture = await createStalePaidNotebook();
    const read = engine.notebooks.read(fixture.notebookId);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const target = read.value.cells.find((cell) => cell.id === fixture.targetCellId);
    if (!target) throw new Error("target cell missing");
    const withoutAncestor = { ...read.value, edges: [] };
    const mismatchedPlan = {
      ...fixture.plan,
      cellDefinitionFingerprint: notebookCellDefinitionFingerprint(
        withoutAncestor,
        target,
      ),
      executionClaim: {
        runId: "019f0000-0000-7000-8000-000000000099",
        claimedAt: new Date(0).toISOString(),
      },
    };
    const written = await engine.notebooks.write({
      ...withoutAncestor,
      generationPlans: [{
        ...read.value.generationPlans![0]!,
        plan: mismatchedPlan,
      }],
    });
    expect(written.ok).toBe(true);
    registerRunNotebookJob(engine);
    await setEngineRoot(rootDir, engine);

    await expect(appQueue.enqueueAndWait(
      "mismatched-generation-claim",
      {
        ...runPayload(fixture),
        generationPlan: mismatchedPlan,
      } as unknown as Record<string, unknown>,
      5_000,
    )).rejects.toThrow("paid execution requires a current persisted plan");

    const notebook = engine.notebooks.read(fixture.notebookId);
    expect(notebook.ok).toBe(true);
    if (!notebook.ok) return;
    expect(notebook.value.execution?.[fixture.targetCellId]).toMatchObject({
      status: "error",
      runId: fixture.runId,
    });
    expect(notebook.value.generationPlans?.[0]).toMatchObject({
      status: "queued",
      plan: {
        executionClaim: {
          runId: "019f0000-0000-7000-8000-000000000099",
        },
      },
    });
    const generations = engine.generations.listForCell(
      fixture.notebookId,
      fixture.targetCellId,
    );
    expect(generations.ok).toBe(true);
    if (generations.ok) expect(generations.value).toEqual([]);
  });

  it("rejects paid worker execution when the aggregate plan belongs to another run", async () => {
    const fixture = await createStalePaidNotebook();
    const read = engine.notebooks.read(fixture.notebookId);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const fingerprints = Object.fromEntries(read.value.cells
      .filter((cell) =>
        cell.id === fixture.upstreamCellId || cell.id === fixture.targetCellId)
      .map((cell) => [
        cell.id,
        notebookCellDefinitionFingerprint(read.value, cell),
      ]));
    const runPlanId = "notebook-run-plan-other-run";
    const otherRunId = "019f0000-0000-7000-8000-000000000098";
    const now = new Date(0).toISOString();
    const runPlan = { planId: runPlanId, notebookRun: { noOp: false } };
    const written = await engine.notebooks.write({
      ...read.value,
      generationPlans: [],
      notebookRunPlans: [{
        planId: runPlanId,
        status: "queued",
        plan: runPlan,
        paidCellIds: [fixture.upstreamCellId, fixture.targetCellId],
        cellDefinitionFingerprints: fingerprints,
        knownCostUsd: 0,
        unknownCostCount: 0,
        createdAt: now,
        updatedAt: now,
        runId: otherRunId,
      }],
    });
    expect(written.ok).toBe(true);
    registerRunNotebookJob(engine);
    await setEngineRoot(rootDir, engine);

    await expect(appQueue.enqueueAndWait(
      "mismatched-aggregate-claim",
      {
        ...runPayload(fixture),
        runPlanId,
        generationPlan: runPlan,
      } as unknown as Record<string, unknown>,
      5_000,
    )).rejects.toThrow("paid execution requires a current persisted plan");

    const notebook = engine.notebooks.read(fixture.notebookId);
    expect(notebook.ok).toBe(true);
    if (!notebook.ok) return;
    expect(notebook.value.notebookRunPlans?.[0]).toMatchObject({
      planId: runPlanId,
      status: "queued",
      runId: otherRunId,
    });
    for (const cellId of [fixture.upstreamCellId, fixture.targetCellId]) {
      const generations = engine.generations.listForCell(
        fixture.notebookId,
        cellId,
      );
      expect(generations.ok).toBe(true);
      if (generations.ok) expect(generations.value).toEqual([]);
    }
  });

  it("terminalizes a selected queued cell blocked by a stale paid ancestor", async () => {
    const fixture = await createStalePaidNotebook();
    registerRunNotebookJob(engine);
    await setEngineRoot(rootDir, engine);

    await expect(appQueue.enqueueAndWait(
      "stale-paid-ancestor-run",
      runPayload(fixture) as unknown as Record<string, unknown>,
      5_000,
    )).rejects.toThrow("paid execution requires a current persisted plan");

    const notebook = engine.notebooks.read(fixture.notebookId);
    expect(notebook.ok).toBe(true);
    if (!notebook.ok) return;
    expect(notebook.value.execution?.[fixture.upstreamCellId]).toBeUndefined();
    expect(notebook.value.execution?.[fixture.targetCellId]).toMatchObject({
      status: "error",
      runId: fixture.runId,
      error: expect.stringContaining("blocked by failed upstream dependency"),
    });
    expect(notebook.value.cells.find((cell) =>
      cell.id === fixture.targetCellId)?.inputs).toMatchObject({ state: "error" });
    expect(notebook.value.generationPlans?.[0]).toMatchObject({
      planId: fixture.plan.planId,
      status: "failed",
      error: expect.stringContaining("paid execution requires a current persisted plan"),
    });
    const upstreamGenerations = engine.generations.listForCell(
      fixture.notebookId,
      fixture.upstreamCellId,
    );
    const targetGenerations = engine.generations.listForCell(
      fixture.notebookId,
      fixture.targetCellId,
    );
    expect(upstreamGenerations.ok).toBe(true);
    expect(targetGenerations.ok).toBe(true);
    if (upstreamGenerations.ok) expect(upstreamGenerations.value).toEqual([]);
    if (targetGenerations.ok) expect(targetGenerations.value).toEqual([]);
    const pending = await engine.jobs.pending.findAll();
    expect(pending.ok).toBe(true);
    if (pending.ok) expect(pending.value).toEqual([]);
    expect(engine.artifacts.list()).toEqual([]);
  });

  it("uses completed stale media as a boundary for a selected run", async () => {
    const saved = await engine.artifacts.create({
      kind: "image",
      label: "saved stale source",
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const created = await engine.notebooks.create("Frozen media boundary");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const upstream = engine.notebooks.createCell({
      type: "generate_image",
      label: "Stale paid source",
      slot: { row: 0, column: 0 },
      prompt: "Original source",
      provider: "kie",
      model: "NanoBananaProRequestSchema",
      operation: "text_to_image",
      tool: "generate_kie_nano_banana_pro_text_to_image",
      outputArtifactId: saved.value.artifactId,
    });
    const target = engine.notebooks.createCell({
      type: "generate_image",
      label: "Selected target",
      slot: { row: 0, column: 1 },
      operation: "unsupported_generation",
    });
    const runId = "019f0000-0000-7000-8000-000000000099";
    const written = await engine.notebooks.write({
      ...created.value,
      cells: [upstream, target],
      edges: [engine.notebooks.createEdge({
        source: upstream.id,
        target: target.id,
        targetInput: "image",
      })],
      execution: {
        [upstream.id]: {
          fingerprint: "stale-completed-fingerprint",
          status: "completed",
          outputArtifactId: saved.value.artifactId,
        },
      },
    });
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    await markNotebookCellQueued(engine, created.value.id, target.id, runId);
    registerRunNotebookJob(engine);
    await setEngineRoot(rootDir, engine);

    await expect(appQueue.enqueueAndWait(
      "frozen-media-boundary-run",
      ({
        type: "run_notebook",
        bookId: engine.book.get().bookId,
        notebookId: created.value.id,
        cellIds: [target.id],
        force: true,
        runId,
      } satisfies RunNotebookPayload) as unknown as Record<string, unknown>,
      5_000,
    )).rejects.toThrow("Cell operation unsupported_generation is not runnable");

    const notebook = engine.notebooks.read(created.value.id);
    expect(notebook.ok).toBe(true);
    if (!notebook.ok) return;
    expect(notebook.value.execution?.[upstream.id]).toMatchObject({
      fingerprint: "stale-completed-fingerprint",
      status: "completed",
      outputArtifactId: saved.value.artifactId,
    });
    expect(notebook.value.execution?.[target.id]).toMatchObject({
      status: "error",
      runId,
      error: "Cell operation unsupported_generation is not runnable",
    });
    const upstreamGenerations = engine.generations.listForCell(
      created.value.id,
      upstream.id,
    );
    expect(upstreamGenerations.ok).toBe(true);
    if (upstreamGenerations.ok) expect(upstreamGenerations.value).toEqual([]);
  });
});
