import { v7 as uuidv7 } from "uuid";
import type {
  Engine,
  NotebookCell,
  NotebookDocument,
  SourceSurface,
} from "videobook-engine";
import { mutateNotebook } from "./notebook-mutations.js";
import {
  notebookCellDefinitionFingerprint,
  notebookCellIsPaid,
  notebookCellIsRunnable,
  notebookCellIsStale,
  notebookCellMediaType,
  prepareNotebookGeneration,
  topologicalOrder,
} from "./jobs/run-notebook.js";
import { queue } from "./queue.js";
import { estimateCostDef } from "./tools/estimate-cost.js";

export type NotebookRunPlanStatus =
  | "planned"
  | "queued"
  | "awaiting-output"
  | "completed"
  | "failed";

export interface NotebookRunPlanRecord {
  planId: string;
  status: NotebookRunPlanStatus;
  plan: Record<string, unknown>;
  paidCellIds: string[];
  cellDefinitionFingerprints: Record<string, string>;
  knownCostUsd: number;
  unknownCostCount: number;
  createdAt: string;
  updatedAt: string;
  runId?: string;
  outputs?: Record<string, string>;
  error?: string;
}

interface CostEstimate {
  estimatedCostUsd?: number;
  estimateUnavailable: boolean;
  warnings: string[];
}

export function notebookRunPlanRecords(
  document: NotebookDocument,
): NotebookRunPlanRecord[] {
  const raw = document.properties?.notebookRunPlans;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    if (
      typeof record.planId !== "string"
      || typeof record.status !== "string"
      || !record.plan
      || typeof record.plan !== "object"
      || Array.isArray(record.plan)
      || !Array.isArray(record.paidCellIds)
      || !record.cellDefinitionFingerprints
      || typeof record.cellDefinitionFingerprints !== "object"
      || Array.isArray(record.cellDefinitionFingerprints)
      || typeof record.knownCostUsd !== "number"
      || typeof record.unknownCostCount !== "number"
      || typeof record.createdAt !== "string"
      || typeof record.updatedAt !== "string"
    ) {
      return [];
    }
    return [entry as NotebookRunPlanRecord];
  });
}

export async function persistNotebookRunPlan(
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
      properties: {
        ...(document.properties ?? {}),
        notebookRunPlans: [
          ...notebookRunPlanRecords(document).filter((candidate) =>
            candidate.planId !== record.planId),
          record,
        ],
      },
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
): Promise<CostEstimate> {
  const result = await estimateCostDef(engine).handler({
    calls: [{ tool_name: tool, input }],
  });
  if (result.isError) {
    return {
      estimateUnavailable: true,
      warnings: [result.content[0]?.text ?? "Cost estimate failed"],
    };
  }
  const text = result.content.find((item) => item.type === "text")?.text;
  const parsed = text
    ? JSON.parse(text) as {
        estimate?: {
          usd?: unknown;
          warnings?: unknown;
        };
      }
    : {};
  const warnings = Array.isArray(parsed.estimate?.warnings)
    ? parsed.estimate.warnings.filter((warning): warning is string =>
      typeof warning === "string")
    : [];
  const estimatedCostUsd = typeof parsed.estimate?.usd === "number"
    ? parsed.estimate.usd
    : undefined;
  const estimateUnavailable = estimatedCostUsd === undefined
    || warnings.some((warning) =>
      /not found|unavailable|no cost adapter|unknown/i.test(warning));
  return {
    ...(estimateUnavailable ? {} : { estimatedCostUsd }),
    estimateUnavailable,
    warnings,
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
    const estimate = await estimateCall(engine, prepared.tool, prepared.input);
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
      summary: `@${cell.slug} · ${prepared.tool}`,
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
      warnings: estimate.warnings,
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
      ? "Multyculty workbook is fully current"
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
  const read = engine.notebooks.read(notebookId);
  if (!read.ok) throw new Error(read.error.message);
  const record = notebookRunPlanRecords(read.value).find((candidate) =>
    candidate.planId === planId);
  if (!record) throw new Error("Notebook run plan is not preserved");
  if (record.status !== "planned") {
    throw new Error(`Notebook run plan is already ${record.status}`);
  }
  if (record.unknownCostCount > 0 && !options.confirmUnpriced) {
    throw new Error(
      `${record.unknownCostCount} provider calls have unavailable pricing and require explicit confirmation`,
    );
  }
  for (const cellId of record.paidCellIds) {
    const cell = read.value.cells.find((candidate) => candidate.id === cellId);
    if (!cell) throw new Error(`Planned cell was deleted: ${cellId}`);
    const actual = notebookCellDefinitionFingerprint(read.value, cell);
    const expected = record.cellDefinitionFingerprints[cellId];
    if (actual !== expected) {
      throw new Error(`Notebook run plan is stale for @${cell.slug}`);
    }
  }
  const notebookRun = record.plan.notebookRun;
  const noOp = notebookRun
    && typeof notebookRun === "object"
    && !Array.isArray(notebookRun)
    && (notebookRun as Record<string, unknown>).noOp === true;
  const force = notebookRun
    && typeof notebookRun === "object"
    && !Array.isArray(notebookRun)
    && (notebookRun as Record<string, unknown>).force === true;
  if (noOp) {
    await persistNotebookRunPlan(engine, notebookId, {
      ...record,
      status: "completed",
      updatedAt: new Date().toISOString(),
    });
    return { status: "completed", planId };
  }
  const runId = uuidv7();
  const jobId = `run-notebook-${notebookId}-${runId}`;
  await persistNotebookRunPlan(engine, notebookId, {
    ...record,
    status: "queued",
    runId,
    updatedAt: new Date().toISOString(),
  });
  await queue.enqueue(jobId, {
    type: "run_notebook",
    bookId: engine.book.get().bookId,
    notebookId,
    runId,
    runPlanId: planId,
    generationPlan: record.plan,
    actor: options.actor,
    jobId,
    force,
  });
  return {
    status: "queued",
    planId,
    runId,
    jobId,
  };
}
