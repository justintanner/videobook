import { v7 as uuidv7 } from "uuid";
import type {
  Engine,
  NotebookCell,
  NotebookDocument,
  NotebookRunPlan,
  SourceSurface,
} from "videobook-engine";
import { notebookGridTag } from "videobook-engine/notebook-grid";
import { mutateNotebook } from "./notebook-mutations.js";
import {
  failQueuedNotebookCells,
  notebookCellDefinitionFingerprint,
  notebookCellIsPaid,
  notebookCellIsRunnable,
  notebookCellIsStale,
  notebookCellMediaType,
  prepareNotebookGeneration,
  topologicalOrder,
} from "./jobs/run-notebook.js";
import { queue } from "./queue.js";
import {
  assessToolCallEstimate,
  logUnavailableCostEstimate,
} from "./jobs/cost-estimate-assessment.js";

type NotebookRunPlanStatus =
  | "planned"
  | "queued"
  | "awaiting-output"
  | "completed"
  | "failed";

interface NotebookRunPlanRecord extends NotebookRunPlan {
  status: NotebookRunPlanStatus;
}

interface CostEstimate {
  estimatedCostUsd?: number;
  estimateUnavailable: boolean;
  warnings: string[];
}

export function notebookRunPlanRecords(
  document: NotebookDocument,
): NotebookRunPlanRecord[] {
  return (document.notebookRunPlans ?? []) as NotebookRunPlanRecord[];
}

async function persistNotebookRunPlan(
  engine: Engine,
  notebookId: string,
  record: NotebookRunPlanRecord,
): Promise<void> {
  const result = await mutateNotebook(
    engine,
    notebookId,
    "persist_notebook_run_plan",
    (document) => ({
      ...document,
      notebookRunPlans: [
        ...notebookRunPlanRecords(document).filter((candidate) =>
          candidate.planId !== record.planId),
        record,
      ],
    }),
    {
      planId: record.planId,
      status: record.status,
      paidCellIds: record.paidCellIds,
      knownCostUsd: record.knownCostUsd,
      unknownCostCount: record.unknownCostCount,
    },
  );
  if (!result.ok) throw new Error(result.error.message);
}

async function estimateCall(
  engine: Engine,
  tool: string,
  input: Record<string, unknown>,
  correlation: {
    cellId?: string;
    notebookId?: string;
    provider?: string | null;
    model?: string | null;
    stage: string;
  },
): Promise<CostEstimate> {
  const assessment = await assessToolCallEstimate(engine, tool, input);
  if (!assessment.available) {
    await logUnavailableCostEstimate({
      assessment,
      engine,
      correlation: {
        bookId: engine.book.get().bookId,
        tool,
        stage: correlation.stage,
        ...(correlation.notebookId ? { notebookId: correlation.notebookId } : {}),
        ...(correlation.cellId ? { cellId: correlation.cellId } : {}),
        ...(correlation.provider ? { provider: correlation.provider } : {}),
        ...(correlation.model ? { model: correlation.model } : {}),
      },
    });
    return {
      estimateUnavailable: true,
      warnings: [],
    };
  }
  return {
    estimatedCostUsd: assessment.usd,
    estimateUnavailable: false,
    warnings: assessment.warnings,
  };
}

function connectedMedia(
  document: NotebookDocument,
  cell: NotebookCell,
): Array<Record<string, unknown>> {
  const cells = new Map(document.cells.map((candidate) => [
    candidate.id,
    candidate,
  ]));
  return document.edges
    .filter((edge) => edge.target === cell.id)
    .flatMap((edge) => {
      const source = cells.get(edge.source);
      if (!source) return [];
      const mediaType = notebookCellMediaType(source);
      return [{
        targetInput: edge.targetInput,
        sourceCellId: source.id,
        sourceType: source.type,
        sourceOperation: source.operation ?? null,
        artifactId: source.outputArtifactId ?? null,
        disclosure: mediaType === "audio"
          ? edge.targetInput === "replace_audio"
            ? "local audio is used for post-generation soundtrack replacement"
            : "audio-derived context only"
          : mediaType === "image"
            ? "image bytes are disclosed to the selected provider"
            : mediaType === "video"
              ? "video bytes are disclosed when the selected model requires them"
              : "structured notebook context",
      }];
    });
}

function requiredSubgraphIds(
  document: NotebookDocument,
  targetCellId: string,
): Set<string> {
  const incoming = new Map<string, string[]>();
  for (const edge of document.edges) {
    const sources = incoming.get(edge.target) ?? [];
    sources.push(edge.source);
    incoming.set(edge.target, sources);
  }
  const seen = new Set<string>();
  const stack = [targetCellId];
  while (stack.length > 0) {
    const id = stack.pop();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    for (const source of incoming.get(id) ?? []) stack.push(source);
  }
  return seen;
}

function cellArtifactId(
  engine: Engine,
  cell: NotebookCell,
): string | null {
  const artifactId = cell.outputArtifactId ?? null;
  if (!artifactId) return null;
  return engine.artifacts.get(artifactId).ok ? artifactId : null;
}

export async function planSelectedNotebookSubgraph(
  engine: Engine,
  document: NotebookDocument,
  targetCellId: string,
  sourceSurface: SourceSurface,
  actor: string,
): Promise<Record<string, unknown>> {
  const target = document.cells.find((cell) => cell.id === targetCellId);
  if (!target) throw new Error(`Target cell not found: ${targetCellId}`);
  const allowed = requiredSubgraphIds(document, targetCellId);
  const ordered = topologicalOrder(document).filter((cell) =>
    allowed.has(cell.id));
  const planId = uuidv7();
  const stages: Array<Record<string, unknown>> = [];
  const fingerprints: Record<string, string> = {};
  const paidCellIds: string[] = [];
  let knownCostUsd = 0;
  let unknownCostCount = 0;
  const upstreamOutputs = new Map<string, string | null>();

  for (const cell of ordered) {
    const missing = cellArtifactId(engine, cell) === null
      && notebookCellIsRunnable(cell);
    const stale = notebookCellIsStale(engine, document, cell);
    const current = !stale && !missing && cellArtifactId(engine, cell) !== null;
    const definitionFingerprint = notebookCellDefinitionFingerprint(document, cell);
    fingerprints[cell.id] = definitionFingerprint;
    const bindings = document.edges
      .filter((edge) => edge.target === cell.id)
      .map((edge) => {
        const source = document.cells.find((candidate) =>
          candidate.id === edge.source);
        return {
          targetInput: edge.targetInput,
          sourceCellId: edge.source,
          artifactId: source
            ? upstreamOutputs.get(source.id) ?? cellArtifactId(engine, source)
            : null,
        };
      });

    if (current && cell.id !== target.id) {
      const reused = cellArtifactId(engine, cell);
      upstreamOutputs.set(cell.id, reused);
      stages.push({
        stageId: `${planId}:reuse:${stages.length}`,
        kind: "reuse",
        cellId: cell.id,
        summary: `${notebookGridTag(cell.slot)} · reuse current output`,
        cellDefinitionFingerprint: definitionFingerprint,
        outputArtifactId: reused,
        insertsOutput: false,
      });
      continue;
    }

    const paid = notebookCellIsPaid(cell);
    const runnable = notebookCellIsRunnable(cell) || missing;
    if (!runnable && cell.id !== target.id) {
      upstreamOutputs.set(cell.id, cellArtifactId(engine, cell));
      continue;
    }

    if (paid) {
      paidCellIds.push(cell.id);
      let tool = cell.tool ?? cell.operation ?? "unknown";
      let provider = cell.provider ?? null;
      let model = cell.model ?? null;
      let actionInput: Record<string, unknown> = {};
      let estimate: CostEstimate = {
        estimateUnavailable: true,
        warnings: [],
      };
      try {
        const prepared = await prepareNotebookGeneration(
          engine,
          document,
          cell,
          engine.book.get().bookId,
          { allowReferenceIssues: true },
        );
        tool = prepared.tool;
        provider = prepared.provider;
        model = prepared.model;
        actionInput = prepared.input;
        estimate = await estimateCall(engine, prepared.tool, prepared.input, {
          notebookId: document.id,
          cellId: cell.id,
          provider: prepared.provider,
          model: prepared.model,
          stage: "plan-subgraph",
        });
      } catch {
        estimate = {
          estimateUnavailable: true,
          warnings: [],
        };
      }
      if (estimate.estimateUnavailable) unknownCostCount += 1;
      else knownCostUsd += estimate.estimatedCostUsd ?? 0;
      stages.push({
        stageId: `${planId}:paid:${stages.length}`,
        kind: "queued",
        cellId: cell.id,
        summary: `${notebookGridTag(cell.slot)} · ${tool}`,
        jobType: "generation",
        tool,
        input: {
          notebook_id: document.id,
          cell_id: cell.id,
          action_input: actionInput,
          connected_media: connectedMedia(document, cell),
          cell_definition_fingerprint: definitionFingerprint,
          upstream_bindings: bindings,
          subgraph_run: true,
        },
        provider,
        model,
        requiresCoverage: true,
        cellDefinitionFingerprint: definitionFingerprint,
        ...(estimate.estimateUnavailable
          ? { estimateUnavailable: true }
          : { estimatedCostUsd: estimate.estimatedCostUsd }),
        insertsOutput: false,
      });
    } else {
      stages.push({
        stageId: `${planId}:local:${stages.length}`,
        kind: "queued",
        cellId: cell.id,
        summary: `${notebookGridTag(cell.slot)} · automatic local rerun`,
        jobType: "indexing",
        tool: cell.tool ?? cell.operation ?? "run_notebook",
        automatic: true,
        cellDefinitionFingerprint: definitionFingerprint,
        input: {
          notebook_id: document.id,
          cell_id: cell.id,
          upstream_bindings: bindings,
          subgraph_run: true,
        },
        insertsOutput: false,
      });
    }
    upstreamOutputs.set(cell.id, null);
  }

  const confirmationRequired = paidCellIds.length > 0;
  const plan: Record<string, unknown> = {
    planVersion: 1,
    planId,
    sourceSurface,
    actor,
    bookId: engine.book.get().bookId,
    summary: `Run selected subgraph for ${notebookGridTag(target.slot)}`,
    normalizedReferences: [{
      kind: "notebook",
      targetId: document.id,
      revision: engine.head,
    }],
    stages,
    confirmation: {
      required: confirmationRequired,
      policy: confirmationRequired ? "always" : "reversible-single-step",
      reason: confirmationRequired
        ? unknownCostCount > 0
          ? `This selected run has ${paidCellIds.length} provider calls; ${unknownCostCount} cannot be priced`
          : `This selected run can incur up to $${knownCostUsd.toFixed(4)} in provider spend`
        : "Only local reversible processing will run",
    },
    notebookRun: {
      notebookId: document.id,
      targetCellId,
      mode: "subgraph",
      subgraphCellIds: ordered.map((cell) => cell.id),
      staleCellIds: stages
        .filter((stage) => stage.kind === "queued")
        .map((stage) => stage.cellId),
      paidCellCount: paidCellIds.length,
      knownCostUsd,
      unknownCostCount,
      noOp: stages.every((stage) => stage.kind === "reuse") && !notebookCellIsRunnable(target),
    },
  };
  const now = new Date().toISOString();
  await persistNotebookRunPlan(engine, document.id, {
    planId,
    status: "planned",
    plan,
    paidCellIds,
    cellDefinitionFingerprints: fingerprints,
    knownCostUsd,
    unknownCostCount,
    createdAt: now,
    updatedAt: now,
  });
  return plan;
}

export async function planNotebookRun(
  engine: Engine,
  document: NotebookDocument,
  sourceSurface: SourceSurface,
  actor: string,
  options: {
    force?: boolean;
  } = {},
): Promise<Record<string, unknown>> {
  const ordered = topologicalOrder(document);
  const runnable = ordered.filter((cell) =>
    notebookCellIsRunnable(cell)
    && (
      options.force === true
      || notebookCellIsStale(engine, document, cell)
    ));
  const paid = runnable.filter(notebookCellIsPaid);
  const planId = uuidv7();
  const stages: Array<Record<string, unknown>> = [];
  const fingerprints: Record<string, string> = {};
  let knownCostUsd = 0;
  let unknownCostCount = 0;

  for (const cell of paid) {
    const prepared = await prepareNotebookGeneration(
      engine,
      document,
      cell,
      engine.book.get().bookId,
    );
    let estimate: CostEstimate;
    try {
      estimate = await estimateCall(engine, prepared.tool, prepared.input, {
        notebookId: document.id,
        cellId: cell.id,
        provider: prepared.provider,
        model: prepared.model,
        stage: "plan-workbook",
      });
    } catch {
      estimate = {
        estimateUnavailable: true,
        warnings: [],
      };
    }
    if (estimate.estimateUnavailable) {
      unknownCostCount += 1;
    } else {
      knownCostUsd += estimate.estimatedCostUsd ?? 0;
    }
    const definitionFingerprint = notebookCellDefinitionFingerprint(
      document,
      cell,
    );
    fingerprints[cell.id] = definitionFingerprint;
    stages.push({
      stageId: `${planId}:queued:${stages.length}`,
      kind: "queued",
      summary: `${notebookGridTag(cell.slot)} · ${prepared.tool}`,
      jobType: "generation",
      tool: prepared.tool,
      input: {
        notebook_id: document.id,
        cell_id: cell.id,
        action_input: prepared.input,
        connected_media: connectedMedia(document, cell),
        cell_definition_fingerprint: definitionFingerprint,
        workbook_run: true,
      },
      provider: prepared.provider,
      model: prepared.model,
      ...(estimate.estimateUnavailable
        ? { estimateUnavailable: true }
        : { estimatedCostUsd: estimate.estimatedCostUsd }),
      insertsOutput: false,
    });
  }

  if (stages.length === 0) {
    stages.push({
      stageId: `${planId}:queued:0`,
      kind: "queued",
      summary: runnable.length === 0
        ? "Workbook is already current"
        : `Run ${runnable.length} local workbook cells`,
      jobType: "indexing",
      tool: runnable.length === 0 ? "notebook_noop" : "run_notebook",
      input: {
        notebook_id: document.id,
        workbook_run: true,
        no_op: runnable.length === 0,
      },
      insertsOutput: false,
    });
  }

  const plan: Record<string, unknown> = {
    planVersion: 1,
    planId,
    sourceSurface,
    actor,
    bookId: engine.book.get().bookId,
    summary: runnable.length === 0
      ? "Workbook is fully current"
      : `Run ${runnable.length} stale workbook cells`,
    normalizedReferences: [{
      kind: "notebook",
      targetId: document.id,
      revision: engine.head,
    }],
    stages,
    confirmation: {
      required: paid.length > 0,
      policy: paid.length > 0 ? "always" : "reversible-single-step",
      reason: paid.length > 0
        ? unknownCostCount > 0
          ? `This run has ${paid.length} provider calls; ${unknownCostCount} cannot be priced`
          : `This run can incur up to $${knownCostUsd.toFixed(4)} in provider spend`
        : runnable.length === 0
          ? "No cells need to run"
          : "Only local reversible processing will run",
    },
    notebookRun: {
      notebookId: document.id,
      staleCellIds: runnable.map((cell) => cell.id),
      localCellCount: runnable.length - paid.length,
      paidCellCount: paid.length,
      knownCostUsd,
      unknownCostCount,
      noOp: runnable.length === 0,
      force: options.force === true,
    },
  };
  const now = new Date().toISOString();
  await persistNotebookRunPlan(engine, document.id, {
    planId,
    status: "planned",
    plan,
    paidCellIds: paid.map((cell) => cell.id),
    cellDefinitionFingerprints: fingerprints,
    knownCostUsd,
    unknownCostCount,
    createdAt: now,
    updatedAt: now,
  });
  return plan;
}

interface ClaimedNotebookRunPlan {
  record: NotebookRunPlanRecord;
  noOp: boolean;
  force: boolean;
}

export async function claimNotebookRunPlan(
  engine: Engine,
  notebookId: string,
  planId: string,
  runId: string,
  options: {
    confirmUnpriced: boolean;
  },
): Promise<ClaimedNotebookRunPlan> {
  let claimed: ClaimedNotebookRunPlan | null = null;
  const updatedAt = new Date().toISOString();
  const result = await mutateNotebook(
    engine,
    notebookId,
    "claim_notebook_run_plan",
    (document) => {
      const record = notebookRunPlanRecords(document).find((candidate) =>
        candidate.planId === planId);
      if (!record) throw new Error("Notebook run plan is not preserved");
      if (record.status !== "planned") {
        throw new Error(`Notebook run plan is already ${record.status}`);
      }
      if (record.runId) throw new Error("Notebook run plan is already claimed");
      void options.confirmUnpriced;
      for (const cellId of record.paidCellIds) {
        const cell = document.cells.find((candidate) => candidate.id === cellId);
        if (!cell) throw new Error(`Planned cell was deleted: ${cellId}`);
        const actual = notebookCellDefinitionFingerprint(document, cell);
        const expected = record.cellDefinitionFingerprints[cellId];
        if (actual !== expected) {
          throw new Error(
            `Notebook run plan is stale for ${notebookGridTag(cell.slot)}`,
          );
        }
      }
      const notebookRun = record.plan.notebookRun;
      const noOp = Boolean(
        notebookRun
        && typeof notebookRun === "object"
        && !Array.isArray(notebookRun)
        && (notebookRun as Record<string, unknown>).noOp === true,
      );
      const force = Boolean(
        notebookRun
        && typeof notebookRun === "object"
        && !Array.isArray(notebookRun)
        && (notebookRun as Record<string, unknown>).force === true,
      );
      const next: NotebookRunPlanRecord = {
        ...record,
        status: noOp ? "completed" : "queued",
        ...(!noOp ? { runId } : {}),
        updatedAt,
      };
      claimed = { record: next, noOp, force };
      return {
        ...document,
        notebookRunPlans: notebookRunPlanRecords(document).map((candidate) =>
          candidate.planId === planId ? next : candidate),
      };
    },
    { notebookId, planId, runId },
  );
  if (!result.ok) throw new Error(result.error.message);
  if (!claimed) throw new Error("Notebook run plan claim was not persisted");
  return claimed;
}

function notebookRunSubgraphCellIds(
  plan: Record<string, unknown>,
): string[] | undefined {
  const notebookRun = plan.notebookRun;
  if (!notebookRun || typeof notebookRun !== "object" || Array.isArray(notebookRun)) {
    return undefined;
  }
  const raw = (notebookRun as Record<string, unknown>).subgraphCellIds;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const cellIds = raw.filter((id): id is string => typeof id === "string" && id.length > 0);
  return cellIds.length === raw.length ? cellIds : undefined;
}

export async function enqueueNotebookRunPlan(
  engine: Engine,
  notebookId: string,
  planId: string,
  options: {
    confirmUnpriced: boolean;
    actor: string;
  },
): Promise<{
  status: "completed" | "queued";
  planId: string;
  runId?: string;
  jobId?: string;
}> {
  const runId = uuidv7();
  const claimed = await claimNotebookRunPlan(
    engine,
    notebookId,
    planId,
    runId,
    { confirmUnpriced: options.confirmUnpriced },
  );
  if (claimed.noOp) return { status: "completed", planId };
  const record = claimed.record;
  const jobId = `run-notebook-${notebookId}-${runId}`;
  const cellIds = notebookRunSubgraphCellIds(record.plan);
  try {
    await queue.enqueue(jobId, {
      type: "run_notebook",
      bookId: engine.book.get().bookId,
      notebookId,
      runId,
      runPlanId: planId,
      generationPlan: record.plan,
      actor: options.actor,
      jobId,
      force: claimed.force,
      ...(cellIds ? { cellIds } : {}),
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    await failQueuedNotebookCells(engine, notebookId, {
      cellIds: cellIds ?? [],
      runId,
      runPlanId: planId,
      error: message,
    }).catch(() => undefined);
    throw cause;
  }
  return {
    status: "queued",
    planId,
    runId,
    jobId,
  };
}
