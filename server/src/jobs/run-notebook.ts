import { createHash } from "node:crypto";
import { v5 as uuidv5, v7 as uuidv7 } from "uuid";
import { z } from "zod";
import type {
  EditIntent,
  EditOperation,
  Engine,
  ClipPlacement,
  GenerationPatch,
  NotebookCell,
  NotebookDocument,
  NotebookRunPlan,
  NotebookRun,
  RecordGenerationArgs,
} from "videobook-engine";
import {
  MVP_CONTRACT_VERSION,
  resolveNotebookCellArtifactId,
} from "videobook-engine";
import { notebookGridTag } from "videobook-engine/notebook-grid";
import { logger } from "../logger.js";
import { mutateNotebook } from "../notebook-mutations.js";
import {
  allocateGenerateImageResult,
  allocateGenerateVideoResult,
  ensureGenerationMediaOutputs,
  ensureGenerationMediaOutput,
  findGenerationMediaOutput,
  findGenerationResultForRun,
  isConcurrentGenerationProducer,
  isImageVideoGenerationResult,
  migrateStackedGenerationResults,
  normalizeLegacyExtractCells,
} from "../notebook-cell-outputs.js";
import { queue, registerJobHandler, waitForJob } from "../queue.js";
import { translateToolPayload } from "../payload-builders.js";
import type { ToolDef, ToolResult } from "../tools/tool-def.js";
import { smoothSceneConcatDef } from "../tools/smooth-scene-concat.js";
import { spliceVideoDef } from "../tools/splice-video.js";
import {
  getActionSpec,
  type GenerationActionSpec,
} from "../generation-registry.js";
import {
  captureFrame,
  concatSourceRanges,
  exportSequenceMaster,
  extractSourceAudio,
  MINIMUM_SPLIT_PIECE_SECONDS,
  normalizeSceneVideo,
  splitSourceRange,
  splitSourceRanges,
  type BurnInCaption,
} from "../notebook-media-ops.js";
import { analyzeNotebookSource } from "../notebook-live-analysis.js";
import { analysisFixtureForCell } from "../notebook-fixtures.js";
import { applyAnalysisResults } from "../notebook-workflow.js";
import {
  DEFAULT_ANIMATION_TOOL,
  normalizeLegacyAnalyzeCell,
  normalizeLegacyAnalyzeDocument,
} from "../notebook-action-catalog.js";
import {
  ANALYSIS_REASONING_EFFORT,
  INTELLIGENCE_MODEL,
  OPENAI_ANALYSIS_TOOL,
} from "../openai-intelligence.js";
import {
  notebookGenerationInputContract,
  notebookGenerationInputsAreCompatible,
} from "../notebook-generation-contract.js";
import { notebookProviderFailureMessage } from "../notebook-provider-failure.js";
import { assertKlingMotionControlDuration } from "../kling-motion-control-duration.js";
import {
  resolveNotebookPromptReferences,
  type NotebookPromptResolution,
} from "../notebook-reference-resolver.js";
import { resolvedInitialGenerationPrompt } from "../notebook-initial-generation-prompt.js";
import { grokImagine1080pImageCountError } from "../grok-imagine-video-contract.js";

export interface RunNotebookPayload {
  type: "run_notebook";
  bookId: string;
  notebookId: string;
  cellIds?: string[];
  force?: boolean;
  generationPlan?: Record<string, unknown>;
  runPlanId?: string;
  runId?: string;
  outputCellId?: string;
  resume?: boolean;
  actor?: string;
  jobId?: string;
}

type NotebookCellExecutionStatus =
  | "queued"
  | "running"
  | "awaiting-output"
  | "completed"
  | "stale"
  | "error";

interface CellExecution {
  fingerprint: string;
  status: NotebookCellExecutionStatus;
  outputArtifactId?: string;
  providerArtifactId?: string;
  runId?: string;
  completedAt?: string;
  startedAt?: string;
  updatedAt?: string;
  tool?: string;
  error?: string;
  stale?: boolean;
}

function generationPlanStage(
  plan: Record<string, unknown>,
  cellId?: string,
): Record<string, unknown> | null {
  const stages = Array.isArray(plan.stages) ? plan.stages : [];
  const stage = stages.find((candidate) => {
    if (
      !candidate
      || typeof candidate !== "object"
      || Array.isArray(candidate)
      || (candidate as Record<string, unknown>).kind !== "queued"
    ) {
      return false;
    }
    if (!cellId) return true;
    const input = (candidate as Record<string, unknown>).input;
    return input
      && typeof input === "object"
      && !Array.isArray(input)
      && (input as Record<string, unknown>).cell_id === cellId;
  }) ?? stages.find((candidate) =>
    candidate
    && typeof candidate === "object"
    && !Array.isArray(candidate)
    && (candidate as Record<string, unknown>).kind === "queued");
  return stage && typeof stage === "object" && !Array.isArray(stage)
    ? stage as Record<string, unknown>
    : null;
}

export async function updateGenerationPlanState(
  engine: Engine,
  notebookId: string,
  planId: string,
  status: string,
  details: {
    outputArtifactId?: string;
    error?: string;
    runId?: string;
  } = {},
): Promise<void> {
  const updatedAt = new Date().toISOString();
  const result = await mutateNotebook(
    engine,
    notebookId,
    "update_generation_plan",
    (notebook) => {
      const plans = notebook.generationPlans ?? [];
      return {
        ...notebook,
        generationPlans: plans.map((record) =>
          record.planId === planId
          && (
            details.runId === undefined
            || generationPlanClaimRunId(record.plan) === details.runId
          )
              ? {
                  ...record,
                  status,
                  updatedAt,
                  ...(details.outputArtifactId
                    ? { outputArtifactId: details.outputArtifactId }
                    : {}),
                  ...(details.error ? { error: details.error } : {}),
                }
              : record),
      };
    },
    {
      planId,
      status,
      outputArtifactId: details.outputArtifactId,
      error: details.error,
      runId: details.runId,
    },
  );
  if (!result.ok) throw new Error(result.error.message);
}

export async function writeGenerationPlanProvenance(
  engine: Engine,
  payload: RunNotebookPayload,
  cell: NotebookCell,
  outputArtifactId: string,
): Promise<void> {
  const plan = payload.generationPlan;
  if (!plan || typeof plan.planId !== "string") return;
  const stage = generationPlanStage(plan, cell.id);
  const written = await engine.metadata.artifacts.write(
    outputArtifactId,
    "command-plan",
    {
      planId: plan.planId,
      parentActionId: typeof plan.parentActionId === "string"
        ? plan.parentActionId
        : null,
      notebookId: payload.notebookId,
      cellId: cell.id,
      actor: payload.actor ?? "videobook-user",
      sourceSurface: plan.sourceSurface,
      provider: stage?.provider,
      model: stage?.model,
      tool: stage?.tool,
      input: stage?.input,
      estimatedCostUsd: stage?.estimatedCostUsd,
      estimateUnavailable: stage?.estimateUnavailable,
      jobId: payload.jobId,
      outputArtifactId,
      createdAt: new Date().toISOString(),
    },
  );
  if (!written.ok) throw new Error(written.error.message);
}

export function numberedKindSlotIndex(
  targetInput: string,
  kind: "image" | "video" | "audio",
): number | null {
  if (targetInput === kind) return 1;
  const prefix = `${kind}_`;
  if (!targetInput.startsWith(prefix)) return null;
  const suffix = targetInput.slice(prefix.length);
  if (!/^\d+$/.test(suffix)) return null;
  return Number(suffix);
}

function sortByKindSlot<T extends { targetInput: string }>(
  entries: T[],
  kind: "image" | "video" | "audio",
): T[] {
  return [...entries].sort((left, right) => {
    const leftIndex = numberedKindSlotIndex(left.targetInput, kind)
      ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = numberedKindSlotIndex(right.targetInput, kind)
      ?? Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex;
  });
}

export function notebookCellMediaType(
  cell: NotebookCell,
): "image" | "video" | "audio" | null {
  if (
    cell.type === "image"
    || cell.type === "generate_image"
  ) return "image";
  if (
    cell.type === "audio"
    || cell.type === "extract_audio"
    || cell.type === "generate_audio"
  ) return "audio";
  if (
    cell.type === "video"
    || cell.type === "split_video"
    || cell.type === "generate_video"
    || cell.type === "concat"
    || cell.type === "splice"
  ) return "video";
  return null;
}

export function notebookCellIsPaid(cell: NotebookCell): boolean {
  return cell.operation === "rewrite_prompt"
    || Boolean(getActionSpec(cell.tool ?? cell.model ?? ""));
}

export function notebookCellIsRunnable(cell: NotebookCell): boolean {
  if (cell.inputs?.mediaRole === "extract-audio-output") return true;
  return (
    cell.type !== "timeline"
    && cell.type !== "audio"
    && cell.type !== "image"
    && cell.type !== "video"
    && cell.type !== "character"
    && cell.type !== "analysis"
    && Boolean(cell.operation ?? cell.tool ?? cell.model)
  );
}

function textResult(result: ToolResult): unknown {
  const text = result.content.find((item) => item.type === "text")?.text;
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function artifactReference(value: unknown): string | null {
  if (typeof value === "object" && value !== null) {
    for (const [key, nested] of Object.entries(value)) {
      if ((key.endsWith("asset_id") || key.endsWith("AssetId")) && typeof nested === "string") {
        return nested;
      }
      const found = artifactReference(nested);
      if (found) return found;
    }
  }
  if (Array.isArray(value)) {
    for (const nested of value) {
      const found = artifactReference(nested);
      if (found) return found;
    }
  }
  return null;
}

async function executeSpliceCell(
  engine: Engine,
  bookId: string,
  document: NotebookDocument,
  cell: NotebookCell,
): Promise<{ artifactId: string; tool: string }> {
  const inputs = upstreamValues(document, cell);
  const first = inputs.filter((entry) => entry.targetInput === "first");
  const second = inputs.filter((entry) => entry.targetInput === "second");
  if (
    inputs.length !== 2
    || first.length !== 1
    || second.length !== 1
    || !first[0]!.output
    || !second[0]!.output
    || notebookCellMediaType(first[0]!.cell) !== "video"
    || notebookCellMediaType(second[0]!.cell) !== "video"
  ) {
    throw new Error(
      `Splice cell ${cell.id} requires exactly one completed video on first and second`,
    );
  }
  const firstArtifact = engine.artifacts.get(first[0]!.output);
  const secondArtifact = engine.artifacts.get(second[0]!.output);
  if (!firstArtifact.ok) throw new Error(firstArtifact.error.message);
  if (!secondArtifact.ok) throw new Error(secondArtifact.error.message);
  const smooth = cell.operation === "smooth_scene_concat";
  const overlap = Number(cell.inputs?.overlap ?? 0);
  if (!smooth && (!Number.isFinite(overlap) || overlap < 0)) {
    throw new Error("Splice overlap must be a non-negative number");
  }
  const transition = cell.inputs?.transitionSeconds;
  if (
    smooth
    && transition !== undefined
    && (typeof transition !== "number" || !Number.isFinite(transition))
  ) {
    throw new Error("Splice transitionSeconds must be a finite number");
  }
  const definition = smooth
    ? smoothSceneConcatDef(engine)
    : spliceVideoDef(engine);
  const response = await definition.handler({
    first_asset_id: firstArtifact.value.artifactId,
    second_asset_id: secondArtifact.value.artifactId,
    book_id: bookId,
    ...(smooth
      ? (transition === undefined ? {} : { transition_seconds: transition })
      : { overlap }),
  });
  if (response.isError) {
    throw new Error(response.content[0]?.text ?? `${cell.operation} failed`);
  }
  const result = textResult(response);
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error(`${cell.operation} returned an invalid result`);
  }
  const record = result as Record<string, unknown>;
  const jobId = typeof record.job_id === "string" ? record.job_id : null;
  const output = typeof record.asset_id === "string" ? record.asset_id : null;
  if (!jobId || !output) {
    throw new Error(`${cell.operation} did not return a queued output`);
  }
  await waitForJob(jobId, 1_800_000);
  const artifact = engine.artifacts.get(output);
  if (!artifact.ok) throw new Error(artifact.error.message);
  return {
    artifactId: artifact.value.artifactId,
    tool: smooth ? "smooth_scene_concat" : "splice_video",
  };
}

function executionState(document: NotebookDocument): Record<string, CellExecution> {
  return (document.execution ?? {}) as Record<string, CellExecution>;
}

function withExecution(
  document: NotebookDocument,
  cellId: string,
  state: CellExecution,
  outputArtifactId?: string,
): NotebookDocument {
  const execution = { ...executionState(document), [cellId]: state };
  return {
    ...document,
    execution,
    cells: document.cells.map((cell) => (
      cell.id === cellId
        ? {
            ...cell,
            ...(outputArtifactId ? { outputArtifactId } : {}),
            inputs: {
              ...(cell.inputs ?? {}),
              state: state.status,
            },
          }
        : cell
    )),
  };
}

export async function markNotebookCellQueued(
  engine: Engine,
  notebookId: string,
  cellId: string,
  runId: string,
): Promise<void> {
  const notebook = engine.notebooks.read(notebookId);
  if (!notebook.ok) throw new Error(notebook.error.message);
  const cell = notebook.value.cells.find((candidate) => candidate.id === cellId);
  if (!cell) throw new Error(`Notebook cell not found: ${cellId}`);
  const updatedAt = new Date().toISOString();
  const state: CellExecution = {
    fingerprint: notebookCellFingerprint(notebook.value, cell),
    status: "queued",
    ...(cell.outputArtifactId ? { outputArtifactId: cell.outputArtifactId } : {}),
    runId,
    startedAt: updatedAt,
    updatedAt,
    tool: cell.tool || cell.model || cell.operation,
  };
  const result = await mutateNotebook(
    engine,
    notebookId,
    "queue_notebook_cell",
    (current) => {
      const existing = executionState(current)[cellId];
      if (existing?.runId === runId && existing.status !== "queued") return current;
      return withExecution(current, cellId, state);
    },
    { cellId, runId },
  );
  if (!result.ok) throw new Error(result.error.message);
}

function upstreamValues(
  document: NotebookDocument,
  cell: NotebookCell,
): Array<{ targetInput: string; cell: NotebookCell; output: string | undefined }> {
  const cells = new Map(document.cells.map((item) => [item.id, item]));
  return document.edges
    .filter((edge) => edge.target === cell.id)
    .flatMap((edge) => {
      const source = cells.get(edge.source);
      if (!source) return [];
      return [{
        targetInput: edge.targetInput,
        cell: source,
        output: resolveNotebookCellArtifactId(document, source),
      }];
    });
}

function stableCellInputs(
  inputs: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const volatile = new Set([
    "state",
    "resolvedPrompt",
    "dispatchedPayload",
    "rawRewriteResult",
    "providerArtifactId",
    "normalizedFromArtifactId",
    "normalizedDurationSeconds",
    "sequenceRevision",
    "sequenceId",
    "clipArtifactIds",
    "audioArtifactId",
    "assemblyDurationFrames",
    "shotCount",
    "outputVersionArtifactIds",
    "atSeconds",
  ]);
  return Object.fromEntries(
    Object.entries(inputs ?? {}).filter(([key]) => !volatile.has(key)),
  );
}

export function notebookCellFingerprint(
  document: NotebookDocument,
  cell: NotebookCell,
): string {
  const payload = {
    type: cell.type,
    id: cell.id,
    prompt: cell.prompt ?? "",
    provider: cell.provider ?? "",
    model: cell.model ?? "",
    operation: cell.operation ?? "",
    tool: cell.tool ?? "",
    inputs: stableCellInputs(cell.inputs),
    upstream: upstreamValues(document, cell).map(({ targetInput, cell: source, output }) => ({
      targetInput,
      sourceId: source.id,
      sourceType: source.type,
      prompt: source.prompt ?? "",
      provider: source.provider ?? "",
      model: source.model ?? "",
      operation: source.operation ?? "",
      tool: source.tool ?? "",
      output: output ?? null,
      outputHash: typeof source.inputs?.objectHash === "string"
        ? source.inputs.objectHash
        : null,
      sequenceRevision: typeof source.inputs?.sequenceRevision === "string"
        ? source.inputs.sequenceRevision
        : null,
      range: {
        startSeconds: source.inputs?.startSeconds ?? null,
        endSeconds: source.inputs?.endSeconds ?? null,
      },
    })),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function notebookCellDefinitionFingerprint(
  document: NotebookDocument,
  cell: NotebookCell,
): string {
  const payload = {
    type: cell.type,
    id: cell.id,
    prompt: cell.prompt ?? "",
    provider: cell.provider ?? "",
    model: cell.model ?? "",
    operation: cell.operation ?? "",
    tool: cell.tool ?? "",
    inputs: stableCellInputs(cell.inputs),
    upstream: upstreamValues(document, cell).map(({ targetInput, cell: source }) => ({
      targetInput,
      sourceId: source.id,
      sourceType: source.type,
      prompt: source.prompt ?? "",
      provider: source.provider ?? "",
      model: source.model ?? "",
      operation: source.operation ?? "",
      tool: source.tool ?? "",
      inputs: stableCellInputs(source.inputs),
    })),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function firstUpstreamArtifact(
  document: NotebookDocument,
  cell: NotebookCell,
  targetInput?: string,
): string | null {
  const upstream = upstreamValues(document, cell)
    .filter((entry) => (targetInput ? entry.targetInput === targetInput : true))
    .map((entry) => entry.output)
    .find((value): value is string => typeof value === "string" && value.length > 0);
  return upstream ?? null;
}

function requiredVideoInputArtifact(
  document: NotebookDocument,
  cell: NotebookCell,
): string {
  const input = upstreamValues(document, cell)
    .find((entry) =>
      entry.targetInput === "video" || entry.targetInput === "segment");
  if (!input) {
    throw new Error(`${cell.type} cell ${cell.id} requires a video input`);
  }
  if (
    notebookCellMediaType(input.cell) !== "video"
    || input.cell.type === "split_video"
  ) {
    throw new Error(`${cell.type} cell ${cell.id} input must be video`);
  }
  if (!input.output) {
    throw new Error(`${cell.type} cell ${cell.id} video input is not completed`);
  }
  return input.output;
}

function requiredMediaOutputCellIds(
  document: NotebookDocument,
  cell: NotebookCell,
  type: "audio" | "image" | "video",
): Set<string> {
  const connectedIds = new Set(
    document.edges
      .filter((edge) =>
        edge.source === cell.id
        && edge.targetInput === "media")
      .map((edge) => edge.target),
  );
  const outputIds = new Set(
    document.cells
      .filter((candidate) =>
        connectedIds.has(candidate.id)
        && candidate.type === type)
      .map((candidate) => candidate.id),
  );
  if (outputIds.size === 0) {
    throw new Error(
      `${cell.type} cell ${cell.id} requires a downstream ${type} media cell`,
    );
  }
  return outputIds;
}

function requiredTwoWaySplitVideoOutputCellIds(
  document: NotebookDocument,
  cell: NotebookCell,
): { first: Set<string>; remaining: Set<string> } {
  const videoCellIds = requiredMediaOutputCellIds(
    document,
    cell,
    "video",
  );
  const first = new Set<string>();
  const remaining = new Set<string>();
  for (const candidate of document.cells) {
    if (!videoCellIds.has(candidate.id)) continue;
    if (candidate.inputs?.splitRole === "first") first.add(candidate.id);
    if (candidate.inputs?.splitRole === "remaining") {
      remaining.add(candidate.id);
    }
  }
  if (
    videoCellIds.size !== 2
    || first.size !== 1
    || remaining.size !== 1
  ) {
    throw new Error(
      `split_video cell ${cell.id} requires first and remaining video outputs`,
    );
  }
  return { first, remaining };
}

function parseSplitOutputGroups(
  value: unknown,
): Array<Array<{ startSeconds: number; endSeconds: number }>> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("outputsSeconds must be a non-empty list of range groups");
  }
  return value.map((group) => {
    if (!Array.isArray(group) || group.length === 0) {
      throw new Error("Each split output group must contain at least one range");
    }
    return group.map((entry) => {
      const record = entry && typeof entry === "object"
        ? entry as Record<string, unknown>
        : {};
      const startSeconds = Number(record.startSeconds);
      const endSeconds = Number(record.endSeconds);
      if (
        !Number.isFinite(startSeconds)
        || !Number.isFinite(endSeconds)
        || !(endSeconds > startSeconds)
      ) {
        throw new Error("Split output ranges must use finite start and end seconds");
      }
      return { startSeconds, endSeconds };
    });
  });
}

function requiredIndexedSplitVideoOutputCellIds(
  document: NotebookDocument,
  cell: NotebookCell,
  chunkCount: number,
): Set<string>[] {
  const videoCellIds = requiredMediaOutputCellIds(document, cell, "video");
  const outputIds = new Array<string | undefined>(chunkCount);
  for (const candidate of document.cells) {
    if (!videoCellIds.has(candidate.id)) continue;
    const chunkIndex = candidate.inputs?.chunkIndex;
    const candidateChunkCount = candidate.inputs?.chunkCount;
    if (
      !Number.isSafeInteger(chunkIndex)
      || Number(candidateChunkCount) !== chunkCount
      || Number(chunkIndex) < 0
      || Number(chunkIndex) >= chunkCount
      || outputIds[Number(chunkIndex)]
    ) {
      throw new Error(
        `split_video cell ${cell.id} has invalid indexed video outputs`,
      );
    }
    outputIds[Number(chunkIndex)] = candidate.id;
  }
  if (
    videoCellIds.size !== chunkCount
    || outputIds.filter(Boolean).length !== chunkCount
  ) {
    throw new Error(
      `split_video cell ${cell.id} requires ${chunkCount} indexed video outputs`,
    );
  }
  return Array.from(
    { length: chunkCount },
    (_, index) => new Set([outputIds[index]!]),
  );
}

function splitFrameOutputCellIds(
  document: NotebookDocument,
  videoCellIds: Set<string>,
): { first: Set<string>; last: Set<string> } {
  const connectedIds = new Set(
    document.edges
      .filter((edge) =>
        videoCellIds.has(edge.source)
        && edge.targetInput === "segment")
      .map((edge) => edge.target),
  );
  const first = new Set<string>();
  const last = new Set<string>();
  for (const candidate of document.cells) {
    if (!connectedIds.has(candidate.id) || candidate.type !== "image") continue;
    if (candidate.inputs?.frameRole === "first") first.add(candidate.id);
    if (candidate.inputs?.frameRole === "last") last.add(candidate.id);
  }
  return { first, last };
}

function withOutputVersionIds(
  cell: NotebookCell,
  artifactId: string,
): string[] {
  const persisted = Array.isArray(cell.inputs?.outputVersionArtifactIds)
    ? cell.inputs.outputVersionArtifactIds.filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0,
      )
    : [];
  return [...new Set([
    ...persisted,
    ...(cell.outputArtifactId ? [cell.outputArtifactId] : []),
    artifactId,
  ])];
}

function withMediaOutput(
  document: NotebookDocument,
  outputCellIds: Set<string>,
  artifactId: string,
  inputs: Record<string, unknown>,
): NotebookDocument {
  return {
    ...document,
    cells: document.cells.map((candidate) => {
      if (!outputCellIds.has(candidate.id)) return candidate;
      if (isImageVideoGenerationResult(candidate)) {
        const state = typeof inputs.state === "string"
          ? inputs.state
          : "completed";
        const nextInputs: Record<string, unknown> = {
          ...(candidate.inputs ?? {}),
          ...inputs,
          state,
        };
        delete nextInputs.outputVersionArtifactIds;
        return {
          ...candidate,
          outputArtifactId: artifactId,
          inputs: nextInputs,
        };
      }
      const persisted = Array.isArray(candidate.inputs?.outputVersionArtifactIds)
        ? candidate.inputs.outputVersionArtifactIds.filter(
            (value): value is string =>
              typeof value === "string" && value.length > 0,
          )
        : [];
      const outputVersionArtifactIds = [...new Set([
        ...persisted,
        ...(candidate.outputArtifactId ? [candidate.outputArtifactId] : []),
        artifactId,
      ])];
      return {
        ...candidate,
        outputArtifactId: artifactId,
        inputs: {
          ...(candidate.inputs ?? {}),
          ...inputs,
          outputVersionArtifactIds,
          state: "completed",
        },
      };
    }),
  };
}

function rollbackGenerationMediaOutput(
  document: NotebookDocument,
  cell: NotebookCell,
  staleArtifactId: string | undefined,
  outputCellIdHint?: string,
): NotebookDocument {
  const mediaOutput = findGenerationResultForRun(document, cell, {
    outputCellId: outputCellIdHint,
  });
  if (!mediaOutput) return document;
  const outputCellId = mediaOutput.outputCell.id;
  const remainingExecution = { ...executionState(document) };
  delete remainingExecution[outputCellId];
  return {
    ...document,
    cells: document.cells.map((candidate) => {
      if (candidate.id !== outputCellId) return candidate;
      const versions = Array.isArray(candidate.inputs?.outputVersionArtifactIds)
        ? candidate.inputs.outputVersionArtifactIds.filter(
            (value): value is string =>
              typeof value === "string"
              && value.length > 0
              && value !== staleArtifactId,
          )
        : [];
      const restored = versions.at(-1);
      const inputs = { ...(candidate.inputs ?? {}) };
      delete inputs.state;
      return {
        ...candidate,
        outputArtifactId: restored,
        inputs: {
          ...inputs,
          outputVersionArtifactIds: versions,
          ...(restored ? { state: "completed" } : {}),
        },
      };
    }),
    execution: remainingExecution,
  };
}

// A crash, an abort, or a failure predating the rollback in
// failAwaitingNotebookCell can leave the paired output cell holding an
// awaiting-output stamp and a placeholder artifact that will never land.
// Heal that residue when the producer starts a fresh run so the pair always
// begins clean and a later synchronous failure cannot expose stale state.
export function healGenerationMediaOutputResidue(
  document: NotebookDocument,
  cell: NotebookCell,
  outputCellId?: string,
): NotebookDocument {
  if (isConcurrentGenerationProducer(cell) && !outputCellId) {
    return document;
  }
  const mediaOutput = findGenerationResultForRun(document, cell, { outputCellId });
  if (!mediaOutput) return document;
  if (
    isConcurrentGenerationProducer(cell)
    && outputCellId
    && mediaOutput.outputCell.id !== outputCellId
  ) {
    return document;
  }
  const outputCell = mediaOutput.outputCell;
  const awaitingInputs = outputCell.inputs?.state === "awaiting-output";
  const awaitingExecution =
    executionState(document)[outputCell.id]?.status === "awaiting-output";
  if (!awaitingInputs && !awaitingExecution) return document;
  return rollbackGenerationMediaOutput(
    document,
    cell,
    outputCell.outputArtifactId,
    outputCell.id,
  );
}

function withSplitOutputs(
  document: NotebookDocument,
  targets: {
    video: Set<string>;
    first: Set<string>;
    last: Set<string>;
  },
  outputs: {
    videoArtifactId: string;
    firstFrameArtifactId: string;
    lastFrameArtifactId: string;
    durationSeconds: number;
    firstAtSeconds: number;
    lastAtSeconds: number;
  },
): NotebookDocument {
  return {
    ...document,
    cells: document.cells.map((candidate) => {
      const outputArtifactId = targets.video.has(candidate.id)
        ? outputs.videoArtifactId
        : targets.first.has(candidate.id)
          ? outputs.firstFrameArtifactId
          : targets.last.has(candidate.id)
            ? outputs.lastFrameArtifactId
            : null;
      if (!outputArtifactId) return candidate;
      return {
        ...candidate,
        outputArtifactId,
        inputs: {
          ...(candidate.inputs ?? {}),
          ...(targets.video.has(candidate.id)
            ? { durationSeconds: outputs.durationSeconds }
            : {
                atSeconds: targets.first.has(candidate.id)
                  ? outputs.firstAtSeconds
                  : outputs.lastAtSeconds,
              }),
          state: "completed",
        },
      };
    }),
  };
}

function promptFor(document: NotebookDocument, cell: NotebookCell): string {
  const upstream = upstreamValues(document, cell)
    .filter(({ cell: source }) => source.type === "prompt" || source.operation === "rewrite_prompt")
    .map(({ cell: source }) =>
      source.operation === "rewrite_prompt" && typeof source.inputs?.resolvedPrompt === "string"
        ? source.inputs.resolvedPrompt
        : source.prompt ?? "")
    .filter(Boolean);
  const own = cell.operation === "rewrite_prompt"
    ? [
        typeof cell.inputs?.featureBrief === "string"
          ? cell.inputs.featureBrief
          : "",
        cell.prompt ?? "",
        cell.inputs?.shotContext
          ? `Shot context: ${JSON.stringify(cell.inputs.shotContext)}`
          : "",
        typeof cell.inputs?.audioContext === "string"
          ? cell.inputs.audioContext
          : "",
      ]
    : [
        cell.type === "generate_image" || cell.type === "generate_video"
          ? !cell.prompt?.trim() && upstream.length > 0
            ? ""
            : resolvedInitialGenerationPrompt(document, cell)
          : cell.prompt ?? "",
      ];
  return [...new Set([...own, ...upstream].filter(Boolean))]
    .join("\n\n")
    .trim();
}

function isImageLikeCell(source: NotebookCell): boolean {
  return notebookCellMediaType(source) === "image";
}

function modelArgsWithMentions(
  definition: ToolDef,
  document: NotebookDocument,
  cell: NotebookCell,
  bookId: string,
  engine?: Engine,
): { input: Record<string, unknown>; mentions: NotebookPromptResolution } {
  const settings = cell.inputs?.generationSettings;
  const generationSettings = settings
    && typeof settings === "object"
    && !Array.isArray(settings)
    ? settings as Record<string, unknown>
    : {};
  const upstream = upstreamValues(document, cell);
  const refFor = (artifactId: string): string => `@${artifactId}`;
  const connectedArtifactIds = new Set(
    upstream
      .filter(({ cell: source, output }) =>
        typeof output === "string"
        && notebookCellMediaType(source) !== null)
      .map(({ output }) => output!),
  );
  const mentions = resolveNotebookPromptReferences({
    engine,
    document,
    prompt: promptFor(document, cell),
    connectedArtifactIds,
  });
  const prompt = mentions.prompt;
  const generationMode = typeof cell.inputs?.generationMode === "string"
    ? cell.inputs.generationMode
    : undefined;
  const args: Record<string, unknown> = {
    ...(cell.inputs ?? {}),
    ...generationSettings,
    book_id: bookId,
    prompt,
  };
  delete args.generationMode;
  delete args.generationSettings;
  if ("text" in definition.schema) {
    args.text = prompt;
  }
  if (
    definition.name === "generate_kie_gemini_omni_video"
    && args.duration === undefined
  ) {
    args.duration = "8";
  }
  if (cell.operation === "rewrite_prompt" && "model" in definition.schema) {
    args.model = typeof cell.inputs?.targetModel === "string"
      ? cell.inputs.targetModel
      : "seedance25";
  }
  let firstFrame = upstream.find((entry) =>
    entry.targetInput === "first_frame"
    && typeof entry.output === "string"
    && isImageLikeCell(entry.cell));
  let lastFrame = upstream.find((entry) =>
    entry.targetInput === "last_frame"
    && typeof entry.output === "string"
    && isImageLikeCell(entry.cell));
  const genericImages = sortByKindSlot(
    upstream.filter(({ cell: source, output, targetInput }) =>
      typeof output === "string"
      && isImageLikeCell(source)
      && targetInput !== "first_frame"
      && targetInput !== "last_frame"),
    "image",
  );
  const supportsFirstFrame = "first_frame_ref" in definition.schema;
  const supportsLastFrame = "last_frame_ref" in definition.schema
    || "end_frame_ref" in definition.schema;
  const frameMode = generationMode === "i2v"
    || (
      (generationMode === undefined || generationMode === "default")
      && Boolean(firstFrame?.output || lastFrame?.output)
    );
  if (frameMode && !firstFrame?.output && supportsFirstFrame) {
    firstFrame = genericImages.shift();
  }
  if (frameMode && !lastFrame?.output && supportsLastFrame) {
    lastFrame = genericImages.shift();
  }
  if (firstFrame?.output && "first_frame_ref" in definition.schema) {
    args.first_frame_ref = refFor(firstFrame.output);
  }
  if (lastFrame?.output && "last_frame_ref" in definition.schema) {
    args.last_frame_ref = refFor(lastFrame.output);
  }
  if (lastFrame?.output && "end_frame_ref" in definition.schema) {
    args.end_frame_ref = refFor(lastFrame.output);
  }

  const imageReferences = genericImages.map(({ output }) => refFor(output!));
  if ("image_refs" in definition.schema && imageReferences.length > 0) {
    args.image_refs = imageReferences;
  }
  if (
    "character_image_refs" in definition.schema
    && imageReferences.length > 0
  ) {
    args.character_image_refs = imageReferences;
  }
  if ("image_ref" in definition.schema && imageReferences[0]) {
    args.image_ref = imageReferences[0];
  }
  const videoReferences = sortByKindSlot(
    upstream.filter(({ cell: source, output }) =>
      typeof output === "string"
      && notebookCellMediaType(source) === "video"),
    "video",
  ).map(({ output }) => refFor(output!));
  if ("video_refs" in definition.schema && videoReferences.length > 0) {
    args.video_refs = videoReferences;
  }
  if (
    "motion_video_refs" in definition.schema
    && videoReferences.length > 0
  ) {
    args.motion_video_refs = videoReferences;
  }
  if ("video_ref" in definition.schema && videoReferences[0]) {
    args.video_ref = videoReferences[0];
  }
  if ("first_clip_ref" in definition.schema && videoReferences[0]) {
    args.first_clip_ref = videoReferences[0];
  }
  const replacementAudio = upstream.find((entry) =>
    entry.targetInput === "replace_audio" && typeof entry.output === "string");
  if (
    replacementAudio?.output
    && "replace_audio_with" in definition.schema
  ) {
    args.replace_audio_with = refFor(replacementAudio.output);
  }
  const audioReferences = sortByKindSlot(
    upstream.filter(({ cell: source, output, targetInput }) =>
      typeof output === "string"
      && notebookCellMediaType(source) === "audio"
      && targetInput !== "replace_audio"),
    "audio",
  ).map(({ output }) => refFor(output!));
  if (
    "audio_refs" in definition.schema
    && audioReferences.length > 0
    && !firstFrame?.output
    && !lastFrame?.output
  ) {
    args.audio_refs = audioReferences;
  }
  if ("audio_ref" in definition.schema && audioReferences[0]) {
    args.audio_ref = audioReferences[0];
  }
  if ("driving_audio_ref" in definition.schema && audioReferences[0]) {
    args.driving_audio_ref = audioReferences[0];
  }
  return { input: args, mentions };
}

export function modelArgs(
  definition: ToolDef,
  document: NotebookDocument,
  cell: NotebookCell,
  bookId: string,
  engine?: Engine,
): Record<string, unknown> {
  return modelArgsWithMentions(
    definition,
    document,
    cell,
    bookId,
    engine,
  ).input;
}

export function resolveNotebookGenerationTool(cell: NotebookCell): string | null {
  const tool = cell.tool?.trim();
  if (tool) return tool;
  const model = cell.model?.trim();
  if (
    model
    && (model.startsWith("generate_")
      || model.startsWith("extend_")
      || model.startsWith("upscale_")
      || Boolean(getActionSpec(model)))
  ) {
    return model;
  }
  return null;
}

export async function prepareNotebookGeneration(
  engine: Engine,
  document: NotebookDocument,
  cell: NotebookCell,
  bookId: string,
  options: { allowReferenceIssues?: boolean } = {},
): Promise<{
  tool: string;
  provider: string;
  model: string;
  input: Record<string, unknown>;
  mentions: NotebookPromptResolution;
}> {
  const tool = resolveNotebookGenerationTool(cell);
  if (!tool) throw new Error(`No generation model for ${cell.type} cell ${cell.id}`);
  const spec = getActionSpec(tool);
  if (spec) {
    const expected = cell.type === "generate_video"
      ? "video"
      : cell.type === "generate_image"
        ? "image"
        : cell.type === "generate_audio"
          ? "audio"
          : null;
    if (!expected || spec.media_type !== expected) {
      throw new Error(
        `Generation tool ${tool} produces ${spec.media_type}, not ${cell.type}`,
      );
    }
  }
  const { getAllToolDefs } = await import("../tools/index.js");
  const definition = getAllToolDefs(engine).find((candidate) => candidate.name === tool);
  if (!definition) throw new Error(`Unknown notebook generation model: ${tool}`);
  if (
    cell.type === "generate_image"
    && !("image_refs" in definition.schema)
    && !("image_ref" in definition.schema)
  ) {
    const connectedImages = upstreamValues(document, cell).filter((entry) =>
      typeof entry.output === "string" && isImageLikeCell(entry.cell)).length;
    if (connectedImages > 0) {
      throw new Error(
        `${notebookGridTag(cell.slot)} has ${connectedImages} image input(s) connected, but ${tool} `
        + "accepts no image and would ignore them — switch OPERATION to "
        + "image_to_image or edit_image, or disconnect the image input",
      );
    }
  }
  const inputContract = notebookGenerationInputContract(tool, definition.schema);
  const generationMode = typeof cell.inputs?.generationMode === "string"
    ? cell.inputs.generationMode
    : undefined;
  if (!notebookGenerationInputsAreCompatible(
    inputContract,
    document,
    cell,
    generationMode,
  )) {
    throw new Error(
      `${tool}${generationMode ? ` mode ${generationMode}` : ""} does not accept the current media inputs for ${notebookGridTag(cell.slot)}`,
    );
  }
  const preparedArgs = modelArgsWithMentions(
    definition,
    document,
    cell,
    bookId,
    engine,
  );
  const referenceIssues = [
    ...preparedArgs.mentions.unresolved,
    ...preparedArgs.mentions.unconnected,
  ];
  if (!options.allowReferenceIssues && referenceIssues.length > 0) {
    throw new Error(
      `Cannot prepare ${notebookGridTag(cell.slot)}: ${referenceIssues
        .map((reference) => reference.message)
        .join("; ")}`,
    );
  }
  const parsed = z.object(definition.schema).safeParse(preparedArgs.input);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  if (
    spec?.canonical_name === "generate_kie_grok_imagine_image_to_video"
    && !(typeof parsed.data._provider === "string" && parsed.data._provider.startsWith("xai"))
  ) {
    const imageCount = Array.isArray(parsed.data.image_refs)
      ? parsed.data.image_refs.length
      : typeof parsed.data.asset_id === "string" ? 1 : 0;
    const resolutionError = grokImagine1080pImageCountError(
      imageCount,
      parsed.data.resolution,
    );
    if (resolutionError) throw new Error(resolutionError);
  }
  if (tool === "generate_kie_kling_3_0_motion_control") {
    const motionRefs = parsed.data.motion_video_refs;
    const motionRef = Array.isArray(motionRefs)
      ? motionRefs.find((value): value is string => typeof value === "string")
      : undefined;
    if (!motionRef) {
      throw new Error("Kling 3.0 Motion Control requires one motion video");
    }
    await assertKlingMotionControlDuration(
      engine,
      motionRef,
      parsed.data.character_orientation === "image" ? "image" : "video",
    );
  }
  return {
    tool,
    provider: spec?.provider ?? "unknown",
    model: providerModelString(tool, parsed.data, spec, cell.model),
    input: parsed.data as Record<string, unknown>,
    mentions: preparedArgs.mentions,
  };
}

function payloadModelString(payload: Record<string, unknown>): string | undefined {
  const model = payload.model ?? payload.endpoint_id;
  return typeof model === "string" && model.trim() !== "" ? model : undefined;
}

function providerModelString(
  tool: string,
  input: Record<string, unknown>,
  spec: GenerationActionSpec | undefined,
  cellModel: string | undefined,
): string {
  try {
    const translated = translateToolPayload(tool, input, spec?.provider);
    const model = translated ? payloadModelString(translated.payload) : undefined;
    if (model) return model;
  } catch {
    // Payload build is best-effort here (e.g. unresolved preview mentions);
    // fall through to identifiers that are not zod schema names.
  }
  const identifier = spec?.apicity_identifier;
  if (identifier && !identifier.endsWith("Schema")) return identifier;
  if (cellModel && !cellModel.endsWith("Schema")) return cellModel;
  return tool;
}

const GENERATION_ERROR_MAX_LENGTH = 500;

function truncateGenerationError(message: string): string {
  return message.length > GENERATION_ERROR_MAX_LENGTH
    ? message.slice(0, GENERATION_ERROR_MAX_LENGTH)
    : message;
}

async function recordGenerationDispatch(
  engine: Engine,
  args: RecordGenerationArgs,
): Promise<string | null> {
  try {
    const result = await engine.generations.record(args);
    if (!result.ok) {
      logger.warn("generation-record-failed", { cellId: args.cellId, error: result.error });
      return null;
    }
    return result.value.generationId;
  } catch (cause) {
    logger.warn("generation-record-failed", { cellId: args.cellId, error: cause });
    return null;
  }
}

async function patchGeneration(
  engine: Engine,
  generationId: string | null,
  patch: GenerationPatch,
): Promise<void> {
  if (!generationId) return;
  try {
    const result = await engine.generations.update(generationId, patch);
    if (!result.ok) {
      logger.warn("generation-update-failed", { generationId, error: result.error });
    }
  } catch (cause) {
    logger.warn("generation-update-failed", { generationId, error: cause });
  }
}

function activeGenerationIdForRun(
  engine: Engine,
  notebookId: string,
  cellId: string,
  runId: string | undefined,
  providerArtifactId: string | undefined,
): string | null {
  try {
    const listed = engine.generations.listForCell(notebookId, cellId);
    if (!listed.ok) {
      logger.warn("generation-list-failed", { cellId, error: listed.error });
      return null;
    }
    const match = listed.value.find((generation) =>
      (
        generation.status === "dispatched"
        || generation.status === "awaiting_provider"
      )
      && (
        (runId !== undefined && generation.runId === runId)
        || (
          providerArtifactId !== undefined
          && generation.providerArtifactId === providerArtifactId
        )
      ));
    return match?.generationId ?? null;
  } catch (cause) {
    logger.warn("generation-list-failed", { cellId, error: cause });
    return null;
  }
}

async function generationTool(
  engine: Engine,
  document: NotebookDocument,
  cell: NotebookCell,
  bookId: string,
  options: { runId?: string; outputCellId?: string } = {},
): Promise<{
  artifactId: string;
  tool: string;
  provider: string;
  model: string;
  resolvedPrompt: string;
}> {
  const prepared = await prepareNotebookGeneration(engine, document, cell, bookId);
  const { getAllToolDefs } = await import("../tools/index.js");
  const definition = getAllToolDefs(engine).find(
    (candidate) => candidate.name === prepared.tool,
  );
  if (!definition) {
    throw new Error(`Unknown notebook generation model: ${prepared.tool}`);
  }
  const resolvedPrompt = typeof prepared.input.prompt === "string"
    ? prepared.input.prompt
    : "";
  const outputCellId = options.outputCellId
    ?? findGenerationResultForRun(document, cell, {
      runId: options.runId,
      outputCellId: options.outputCellId,
    })?.outputCell.id;
  const generationId = await recordGenerationDispatch(engine, {
    notebookId: document.id,
    cellId: cell.id,
    tool: prepared.tool,
    status: "dispatched",
    provider: prepared.provider,
    model: prepared.model,
    ...(cell.prompt ? { prompt: cell.prompt } : {}),
    ...(resolvedPrompt ? { resolvedPrompt } : {}),
    ...(options.runId ? { runId: options.runId } : {}),
    ...(outputCellId ? { outputCellId } : {}),
  });
  const fail = async (message: string): Promise<never> => {
    await patchGeneration(engine, generationId, {
      status: "failed",
      error: truncateGenerationError(message),
    });
    throw new Error(message);
  };
  let response: ToolResult;
  try {
    response = await definition.handler(prepared.input);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return fail(message);
  }
  if (response.isError) {
    return fail(response.content[0]?.text ?? `${prepared.tool} failed`);
  }
  const reference = artifactReference(textResult(response));
  if (!reference) {
    return fail(`${prepared.tool} did not return an output artifact`);
  }
  const artifact = engine.artifacts.get(reference);
  if (!artifact.ok) return fail(artifact.error.message);
  await patchGeneration(engine, generationId, {
    status: "awaiting_provider",
    providerArtifactId: artifact.value.artifactId,
  });
  return {
    artifactId: artifact.value.artifactId,
    tool: prepared.tool,
    provider: prepared.provider,
    model: prepared.model,
    resolvedPrompt,
  };
}

async function rewritePromptCell(
  engine: Engine,
  document: NotebookDocument,
  cell: NotebookCell,
  bookId: string,
): Promise<{
  artifactId: string;
  tool: string;
  resolvedPrompt: string;
  rawResult: Record<string, unknown>;
}> {
  const prepared = await prepareNotebookGeneration(
    engine,
    document,
    cell,
    bookId,
  );
  if (prepared.tool !== "rewrite_prompt") {
    throw new Error(`Note ${cell.id} must use rewrite_prompt`);
  }
  const { getAllToolDefs } = await import("../tools/index.js");
  const definition = getAllToolDefs(engine).find((candidate) =>
    candidate.name === prepared.tool);
  if (!definition) throw new Error("rewrite_prompt is unavailable");
  const response = await definition.handler(prepared.input);
  if (response.isError) {
    throw new Error(response.content[0]?.text ?? "rewrite_prompt failed");
  }
  const value = textResult(response);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("rewrite_prompt returned an invalid result");
  }
  const rawResult = value as Record<string, unknown>;
  const resolvedPrompt = typeof rawResult.rewritten_prompt === "string"
    ? rawResult.rewritten_prompt.trim()
    : "";
  if (!resolvedPrompt) {
    throw new Error("rewrite_prompt did not return rewritten_prompt");
  }
  const artifact = await engine.artifacts.create({
    kind: "script",
    label: `script ${notebookGridTag(cell.slot)} resolved prompt`,
  });
  if (!artifact.ok) throw new Error(artifact.error.message);
  const written = await engine.files.write(
    artifact.value.artifactId,
    "prompt.json",
    JSON.stringify({
      version: 1,
      originalPrompt: cell.prompt ?? "",
      resolvedPrompt,
      request: prepared.input,
      result: rawResult,
      featureId: cell.inputs?.featureId ?? null,
      shotContext: cell.inputs?.shotContext ?? null,
      audioContext: cell.inputs?.audioContext ?? null,
      resolvedAt: new Date().toISOString(),
    }, null, 2),
  );
  if (!written.ok) throw new Error(written.error.message);
  return {
    artifactId: artifact.value.artifactId,
    tool: prepared.tool,
    resolvedPrompt,
    rawResult,
  };
}

async function failedArtifact(
  engine: Engine,
  cell: NotebookCell,
  message: string,
): Promise<string> {
  const kind = notebookCellMediaType(cell) ?? "script";
  const result = await engine.artifacts.create({
    kind,
    label: kind === "script"
      ? `script ${notebookGridTag(cell.slot)} failed`
      : `${notebookGridTag(cell.slot)} failed`,
  });
  if (!result.ok) throw new Error(result.error.message);
  const written = await engine.files.write(
    result.value.artifactId,
    "error.json",
    JSON.stringify({ message, failedAt: new Date().toISOString() }),
  );
  if (!written.ok) throw new Error(written.error.message);
  return result.value.artifactId;
}

async function assembleCanonicalSequence(
  engine: Engine,
  document: NotebookDocument,
  cell: NotebookCell,
): Promise<{
  scriptArtifactId: string;
  sequenceRevision: string;
  sequenceId: string;
  clipArtifactIds: string[];
  audioArtifactId: string | null;
  assemblyDurationFrames: number;
}> {
  const orderedClips = upstreamValues(document, cell)
    .filter((entry) => /^clip:\d+$/.test(entry.targetInput))
    .sort((left, right) =>
      Number(left.targetInput.slice(5)) - Number(right.targetInput.slice(5)));
  if (orderedClips.length < 2) {
    throw new Error(`Concat cell ${cell.id} requires at least two clip inputs`);
  }
  for (let index = 0; index < orderedClips.length; index += 1) {
    const entry = orderedClips[index]!;
    if (entry.targetInput !== `clip:${index}`) {
      throw new Error(
        `Concat cell ${cell.id} requires contiguous clip:0 through clip:${orderedClips.length - 1}`,
      );
    }
    if (!entry.output || notebookCellMediaType(entry.cell) !== "video") {
      throw new Error(
        `Concat input ${entry.targetInput} must be a completed video`,
      );
    }
  }
  const clips = orderedClips.map((entry) => entry.output!);
  const audioId = firstUpstreamArtifact(document, cell, "audio")
    ?? firstUpstreamArtifact(document, cell, "source-audio");

  let primary = engine.sequences.getPrimary();
  const videoTrack = primary.tracks.find((track) =>
    track.kind === "video" && track.ordinal === 0)
    ?? primary.tracks.find((track) => track.kind === "video");
  if (!videoTrack) {
    throw new Error("Primary sequence has no video track for assembly");
  }
  if (!primary.tracks.some((track) => track.kind === "caption")) {
    const added = await engine.sequences.addTrack(primary.sequenceId, {
      kind: "caption",
      name: "Feature captions",
    });
    if (!added.ok) throw new Error(added.error.message);
    primary = engine.sequences.getPrimary();
  }
  const activeVideoTrack = primary.tracks.find((track) =>
    track.trackId === videoTrack.trackId);
  if (!activeVideoTrack || activeVideoTrack.kind !== "video") {
    throw new Error("Primary video track changed during assembly");
  }
  const audioTrack = primary.tracks.find((track) => track.kind === "audio");
  const captionTrack = primary.tracks.find((track) => track.kind === "caption");
  const fps = primary.frameRate.numerator / primary.frameRate.denominator;
  const placements: ClipPlacement[] = [];
  const clipDurations: number[] = [];
  let timelineStartFrame = 0;

  for (const clipId of clips) {
    const manifest = await engine.files.manifest(clipId);
    if (!manifest.ok) throw new Error(manifest.error.message);
    const file = manifest.value.files.find((entry) => entry.name.startsWith("original."))
      ?? manifest.value.files[0];
    if (!file) throw new Error(`Clip artifact ${clipId} has no files`);

    let durationFrames = 90;
    const streams = engine.streams.list(clipId);
    if (streams.ok) {
      const videoStream = streams.value.find((stream) => stream.kind === "video")
        ?? streams.value[0];
      if (videoStream) {
        const seconds = videoStream.durationTicks
          * videoStream.timeBase.numerator
          / videoStream.timeBase.denominator;
        durationFrames = Math.max(1, Math.round(seconds * fps));
        placements.push({
          trackId: activeVideoTrack.trackId,
          timelineStartFrame,
          durationFrames,
          source: {
            kind: "timed",
            artifactId: clipId,
            range: {
              streamId: videoStream.streamId,
              objectHash: videoStream.objectHash,
              startTick: 0,
              durationTicks: videoStream.durationTicks,
              timeBase: videoStream.timeBase,
            },
          },
          speed: { numerator: 1, denominator: 1 },
          reverse: false,
          audioPolicy: "mute",
          audio: {
            gainDb: 0,
            muted: true,
            fadeInFrames: 0,
            fadeOutFrames: 0,
          },
        });
        clipDurations.push(durationFrames);
        timelineStartFrame += durationFrames;
        continue;
      }
    }

    placements.push({
      trackId: activeVideoTrack.trackId,
      timelineStartFrame,
      durationFrames,
      source: {
        kind: "still",
        artifactId: clipId,
        sourcePath: file.name,
        objectHash: file.objectHash,
      },
    });
    clipDurations.push(durationFrames);
    timelineStartFrame += durationFrames;
  }

  if (audioId && audioTrack) {
    const audioStreams = engine.streams.list(audioId);
    if (audioStreams.ok) {
      const audioStream = audioStreams.value.find((stream) => stream.kind === "audio");
      if (audioStream) {
        const seconds = audioStream.durationTicks
          * audioStream.timeBase.numerator
          / audioStream.timeBase.denominator;
        placements.push({
          trackId: audioTrack.trackId,
          timelineStartFrame: 0,
          durationFrames: Math.min(
            timelineStartFrame,
            Math.max(1, Math.round(seconds * fps)),
          ),
          source: {
            kind: "timed",
            artifactId: audioId,
            range: {
              streamId: audioStream.streamId,
              objectHash: audioStream.objectHash,
              startTick: 0,
              durationTicks: audioStream.durationTicks,
              timeBase: audioStream.timeBase,
            },
          },
          speed: { numerator: 1, denominator: 1 },
          reverse: false,
          audioPolicy: "preserve-pitch",
          audio: {
            gainDb: 0,
            muted: false,
            fadeInFrames: 0,
            fadeOutFrames: 0,
          },
        });
      }
    }
  }
  const targetTrackIds = [
    activeVideoTrack.trackId,
    ...(audioTrack ? [audioTrack.trackId] : []),
  ];
  const occupiedDuration = primary.clips
    .filter((clip) => targetTrackIds.includes(clip.trackId))
    .reduce((maximum, clip) =>
      Math.max(maximum, clip.timelineStartFrame + clip.durationFrames), 0);
  const previousDuration = Number(cell.inputs?.assemblyDurationFrames ?? 0);
  const replacementDuration = Math.max(
    1,
    occupiedDuration,
    previousDuration,
    timelineStartFrame,
  );
  const operations: EditOperation[] = [{
    kind: "batch-replace-range",
    range: {
      sequenceId: primary.sequenceId,
      startFrame: 0,
      durationFrames: replacementDuration,
    },
    trackIds: targetTrackIds,
    placements,
    ripple: false,
  }];
  const captionTexts = Array.isArray(cell.inputs?.captions)
    ? cell.inputs.captions.filter((value): value is string =>
      typeof value === "string" && value.trim().length > 0)
    : [];
  if (captionTrack) {
    let captionStartFrame = 0;
    for (let index = 0; index < clipDurations.length; index += 1) {
      const durationFrames = clipDurations[index]!;
      const text = captionTexts[index];
      if (text) {
        operations.push({
          kind: "upsert-caption-cue",
          cue: {
            cueId: uuidv5(
              `${primary.sequenceId}:notebook-feature-caption:${index}`,
              uuidv5.URL,
            ),
            trackId: captionTrack.trackId,
            timelineStartFrame: captionStartFrame,
            durationFrames,
            text,
            styleId: "high-contrast",
          },
        });
      }
      captionStartFrame += durationFrames;
    }
  }

  const intent: EditIntent = {
    intentVersion: MVP_CONTRACT_VERSION,
    commandId: uuidv7(),
    sequenceId: primary.sequenceId,
    baseRevision: engine.head,
    actor: "notebook-assembly",
    sourceSurface: "system",
    confirmationPolicy: "reversible-single-step",
    operations,
  };
  const preview = engine.edits.preview(intent);
  if (!preview.ok) throw new Error(preview.error.message);
  const commit = await engine.edits.commit(intent, preview.value.previewHash);
  if (!commit.ok) throw new Error(commit.error.message);

  const sequenceRevision = engine.head;
  const script = await engine.artifacts.create({
    kind: "script",
    label: `${notebookGridTag(cell.slot)} assembly`,
  });
  if (!script.ok) throw new Error(script.error.message);
  const written = await engine.files.write(
    script.value.artifactId,
    "assembly.json",
    JSON.stringify({
      sequenceId: primary.sequenceId,
      sequenceRevision,
      clipArtifactIds: clips,
      audioArtifactId: audioId,
      assemblyDurationFrames: timelineStartFrame,
      captionTexts,
      assembledAt: new Date().toISOString(),
      operationCount: operations.length,
    }),
  );
  if (!written.ok) throw new Error(written.error.message);

  return {
    scriptArtifactId: script.value.artifactId,
    sequenceRevision,
    sequenceId: primary.sequenceId,
    clipArtifactIds: clips,
    audioArtifactId: audioId,
    assemblyDurationFrames: timelineStartFrame,
  };
}

async function executeLocalOrGeneration(
  engine: Engine,
  bookId: string,
  document: NotebookDocument,
  cell: NotebookCell,
  options: { confirmPaid?: boolean; runId?: string; outputCellId?: string } = {},
): Promise<{
  artifactId: string;
  tool: string;
  provider?: string;
  model?: string;
  document?: NotebookDocument;
  cellInputs?: Record<string, unknown>;
  awaitingOutput?: boolean;
}> {
  if (cell.type === "split_video" && cell.operation === "split_ranges") {
    const sourceId = requiredVideoInputArtifact(document, cell);
    const groups = parseSplitOutputGroups(cell.inputs?.outputsSeconds);
    if (groups.length === 0) {
      throw new Error(
        `split_video cell ${cell.id} requires outputsSeconds range groups`,
      );
    }
    for (const group of groups) {
      const total = group.reduce(
        (sum, range) => sum + (range.endSeconds - range.startSeconds),
        0,
      );
      if (total < MINIMUM_SPLIT_PIECE_SECONDS) {
        throw new Error(
          `split_video cell ${cell.id} requires every output range to be at least ${MINIMUM_SPLIT_PIECE_SECONDS}s`,
        );
      }
    }
    const outputCellIds = requiredIndexedSplitVideoOutputCellIds(
      document,
      cell,
      groups.length,
    );
    const results = [];
    for (const [index, group] of groups.entries()) {
      const title = `${notebookGridTag(cell.slot)} output ${String(index + 1).padStart(2, "0")}`;
      const result = group.length === 1
        ? await splitSourceRange(engine, sourceId, group[0]!, title)
        : await concatSourceRanges(engine, sourceId, group, title);
      results.push(result);
    }
    const [firstFrame, lastFrame] = await Promise.all([
      captureFrame(engine, results[0]!.artifactId, {
        role: "first",
        title: `${notebookGridTag(cell.slot)} · first frame`,
      }),
      captureFrame(engine, results.at(-1)!.artifactId, {
        role: "last",
        title: `${notebookGridTag(cell.slot)} · last frame`,
      }),
    ]);
    let withOutputs = document;
    for (const [index, result] of results.entries()) {
      withOutputs = withMediaOutput(
        withOutputs,
        outputCellIds[index]!,
        result.artifactId,
        { durationSeconds: result.durationSeconds },
      );
    }
    return {
      artifactId: results[0]!.artifactId,
      tool: "ffmpeg",
      document: withOutputs,
      cellInputs: {
        durationSeconds: results.reduce(
          (total, result) => total + result.durationSeconds,
          0,
        ),
        firstFrameArtifactId: firstFrame.artifactId,
        lastFrameArtifactId: lastFrame.artifactId,
      },
    };
  }

  if (cell.type === "split_video" && cell.operation === "split_at_points") {
    const sourceId = requiredVideoInputArtifact(document, cell);
    const rawCutPoints = cell.inputs?.cutPointsSeconds;
    const sourceDurationSeconds = Number(
      cell.inputs?.sourceDurationSeconds ?? cell.inputs?.endSeconds,
    );
    if (
      !Array.isArray(rawCutPoints)
      || rawCutPoints.length === 0
      || !Number.isFinite(sourceDurationSeconds)
    ) {
      throw new Error(
        `split_video cell ${cell.id} requires cut points and a source duration`,
      );
    }
    const cutPoints = rawCutPoints.map((value) =>
      typeof value === "number" ? value : Number.NaN);
    let previous = 0;
    for (const cutPoint of cutPoints) {
      if (
        !Number.isFinite(cutPoint)
        || cutPoint <= previous
        || sourceDurationSeconds - cutPoint < MINIMUM_SPLIT_PIECE_SECONDS
        || cutPoint - previous < MINIMUM_SPLIT_PIECE_SECONDS
      ) {
        throw new Error(
          `split_video cell ${cell.id} requires ordered cut points at least ${MINIMUM_SPLIT_PIECE_SECONDS}s apart`,
        );
      }
      previous = cutPoint;
    }
    const boundaries = [0, ...cutPoints, sourceDurationSeconds];
    const ranges = boundaries.slice(0, -1).map((startSeconds, index) => ({
      endSeconds: boundaries[index + 1]!,
      startSeconds,
    }));
    const outputCellIds = requiredIndexedSplitVideoOutputCellIds(
      document,
      cell,
      ranges.length,
    );
    const results = await splitSourceRanges(
      engine,
      sourceId,
      ranges.map((range, index) => ({
        range,
        title: `${notebookGridTag(cell.slot)} chunk ${String(index + 1).padStart(2, "0")}`,
      })),
      2,
    );
    const [firstFrame, lastFrame] = await Promise.all([
      captureFrame(engine, results[0]!.artifactId, {
        role: "first",
        title: `${notebookGridTag(cell.slot)} · first frame`,
      }),
      captureFrame(engine, results.at(-1)!.artifactId, {
        role: "last",
        title: `${notebookGridTag(cell.slot)} · last frame`,
      }),
    ]);
    let withOutputs = document;
    for (const [index, result] of results.entries()) {
      withOutputs = withMediaOutput(
        withOutputs,
        outputCellIds[index]!,
        result.artifactId,
        { durationSeconds: result.durationSeconds },
      );
    }
    return {
      artifactId: results[0]!.artifactId,
      tool: "ffmpeg",
      document: withOutputs,
      cellInputs: {
        durationSeconds: results.reduce(
          (total, result) => total + result.durationSeconds,
          0,
        ),
        firstFrameArtifactId: firstFrame.artifactId,
        lastFrameArtifactId: lastFrame.artifactId,
      },
    };
  }

  if (
    cell.type === "split_video"
    && cell.operation === "split_range"
    && typeof cell.inputs?.splitAtSeconds === "number"
  ) {
    const sourceId = requiredVideoInputArtifact(document, cell);
    const splitAtSeconds = cell.inputs.splitAtSeconds;
    const sourceDurationSeconds = Number(
      cell.inputs.sourceDurationSeconds ?? cell.inputs.endSeconds,
    );
    if (
      !Number.isFinite(splitAtSeconds)
      || !Number.isFinite(sourceDurationSeconds)
      || !(splitAtSeconds > 0)
      || !(sourceDurationSeconds > splitAtSeconds)
    ) {
      throw new Error(
        `split_video cell ${cell.id} requires a split boundary within the source duration`,
      );
    }
    const outputCellIds = requiredTwoWaySplitVideoOutputCellIds(
      document,
      cell,
    );
    const [first, remaining] = await Promise.all([
      splitSourceRange(
        engine,
        sourceId,
        { startSeconds: 0, endSeconds: splitAtSeconds },
        `${notebookGridTag(cell.slot)} first`,
      ),
      splitSourceRange(
        engine,
        sourceId,
        {
          startSeconds: splitAtSeconds,
          endSeconds: sourceDurationSeconds,
        },
        `${notebookGridTag(cell.slot)} remaining`,
      ),
    ]);
    const [firstFrame, lastFrame] = await Promise.all([
      captureFrame(engine, first.artifactId, {
        role: "first",
        title: `${notebookGridTag(cell.slot)} · first frame`,
      }),
      captureFrame(engine, remaining.artifactId, {
        role: "last",
        title: `${notebookGridTag(cell.slot)} · last frame`,
      }),
    ]);
    const withFirstOutput = withMediaOutput(
      document,
      outputCellIds.first,
      first.artifactId,
      { durationSeconds: first.durationSeconds },
    );
    return {
      artifactId: first.artifactId,
      tool: "ffmpeg",
      document: withMediaOutput(
        withFirstOutput,
        outputCellIds.remaining,
        remaining.artifactId,
        { durationSeconds: remaining.durationSeconds },
      ),
      cellInputs: {
        durationSeconds: first.durationSeconds + remaining.durationSeconds,
        firstFrameArtifactId: firstFrame.artifactId,
        lastFrameArtifactId: lastFrame.artifactId,
      },
    };
  }

  if (cell.type === "split_video" && cell.operation === "split_range") {
    const sourceId = requiredVideoInputArtifact(document, cell);
    const videoCellIds = requiredMediaOutputCellIds(
      document,
      cell,
      "video",
    );
    const frameCellIds = splitFrameOutputCellIds(document, videoCellIds);
    const startSeconds = Number(cell.inputs?.startSeconds ?? 0);
    const endSeconds = Number(cell.inputs?.endSeconds ?? 0);
    const result = await splitSourceRange(
      engine,
      sourceId,
      { startSeconds, endSeconds },
      notebookGridTag(cell.slot),
    );
    const firstFrame = await captureFrame(engine, result.artifactId, {
      role: "first",
      title: `${notebookGridTag(cell.slot)} · first frame`,
    });
    const lastFrame = await captureFrame(engine, result.artifactId, {
      role: "last",
      title: `${notebookGridTag(cell.slot)} · last frame`,
    });
    return {
      artifactId: result.artifactId,
      tool: "ffmpeg",
      document: withSplitOutputs(
        document,
        {
          video: videoCellIds,
          first: frameCellIds.first,
          last: frameCellIds.last,
        },
        {
          videoArtifactId: result.artifactId,
          firstFrameArtifactId: firstFrame.artifactId,
          lastFrameArtifactId: lastFrame.artifactId,
          durationSeconds: result.durationSeconds,
          firstAtSeconds: firstFrame.atSeconds,
          lastAtSeconds: lastFrame.atSeconds,
        },
      ),
      cellInputs: {
        durationSeconds: result.durationSeconds,
        firstFrameArtifactId: firstFrame.artifactId,
        lastFrameArtifactId: lastFrame.artifactId,
      },
    };
  }

  if (
    (cell.type === "extract_audio" && cell.operation === "extract_audio")
    || cell.inputs?.mediaRole === "extract-audio-output"
  ) {
    const sourceId = requiredVideoInputArtifact(document, cell);
    const previous = cell.outputArtifactId && cell.inputs?.audioRange === undefined
      ? await engine.metadata.artifacts.read<Record<string, unknown>>(cell.outputArtifactId, "original")
      : undefined;
    const previousRange = previous?.ok && previous.value.origin === "extract_audio"
      && previous.value.sourceArtifactId === sourceId && typeof previous.value.startSeconds === "number"
      ? previous.value : undefined;
    const savedRange = cell.inputs?.audioRange ?? previousRange;
    const rangeInputs = savedRange && typeof savedRange === "object" && !Array.isArray(savedRange)
      ? savedRange as Record<string, unknown>
      : undefined;
    const range = rangeInputs === undefined ? undefined : {
      startSeconds: Number(rangeInputs.startSeconds ?? 0),
      ...(rangeInputs.durationSeconds === undefined ? {} : { durationSeconds: Number(rangeInputs.durationSeconds) }),
    };
    const result = await extractSourceAudio(engine, sourceId, notebookGridTag(cell.slot), range);
    return {
      artifactId: result.artifactId,
      tool: "ffmpeg",
      cellInputs: {
        durationSeconds: result.durationSeconds,
        outputVersionArtifactIds: withOutputVersionIds(cell, result.artifactId),
        state: "completed",
      },
    };
  }

  if (cell.type === "analyze" && cell.operation === "analyze_source") {
    const sourceId = firstUpstreamArtifact(document, cell, "source")
      ?? firstUpstreamArtifact(document, cell);
    if (!sourceId) throw new Error(`Analyze cell ${cell.id} has no source artifact`);
    const fixture = analysisFixtureForCell(cell);
    const configuredDuration = Number(
      cell.inputs?.sourceDurationSeconds
        ?? (
          fixture && typeof fixture === "object"
            ? (fixture as { sourceDurationSeconds?: number }).sourceDurationSeconds
            : undefined
        ),
    );
    const analysisRun = fixture !== null
      ? {
          rawOutput: fixture,
          sourceDurationSeconds: Number.isFinite(configuredDuration)
            ? configuredDuration
            : 60,
          request: {
            provider: "openai",
            model: INTELLIGENCE_MODEL,
            reasoning: { effort: ANALYSIS_REASONING_EFFORT },
            mode: "fixture",
            prompt: cell.prompt ?? "",
          },
        }
      : await analyzeNotebookSource(
          engine,
          sourceId,
          cell.prompt ?? "",
          {
            ...(Number.isFinite(configuredDuration)
              ? { sourceDurationSeconds: configuredDuration }
              : {}),
          },
        );
    if (
      !Number.isFinite(analysisRun.sourceDurationSeconds)
      || analysisRun.sourceDurationSeconds <= 0
    ) {
      throw new Error(
        `Analyze cell ${cell.id} requires a positive source duration`,
      );
    }
    const next = await applyAnalysisResults(engine, document, cell.id, {
      rawOutput: analysisRun.rawOutput,
      sourceDurationSeconds: analysisRun.sourceDurationSeconds,
      request: analysisRun.request,
      sourceArtifactId: sourceId,
      ...("llmExchanges" in analysisRun
        ? { llmExchanges: analysisRun.llmExchanges }
        : {}),
      ...("evidence" in analysisRun
        ? { evidence: analysisRun.evidence }
        : {}),
      ...("boundaries" in analysisRun
        ? { boundaries: analysisRun.boundaries }
        : {}),
    });
    const completedAnalysis = next.cells.find((candidate) =>
      candidate.id === cell.id);
    if (!completedAnalysis?.outputArtifactId) {
      throw new Error("Analysis did not produce a script artifact");
    }
    return {
      artifactId: completedAnalysis.outputArtifactId,
      tool: cell.tool ?? OPENAI_ANALYSIS_TOOL,
      document: next,
    };
  }

  if (cell.type === "concat" && cell.operation === "concat_video") {
    const assembled = await assembleCanonicalSequence(
      engine,
      document,
      cell,
    );
    const currentSequence = engine.sequences.getPrimary();
    const frameSeconds = currentSequence.frameRate.denominator
      / currentSequence.frameRate.numerator;
    const captions: BurnInCaption[] = currentSequence.captions.map((caption) => ({
      text: caption.text,
      startSeconds: caption.timelineStartFrame * frameSeconds,
      durationSeconds: caption.durationFrames * frameSeconds,
    }));
    const result = await exportSequenceMaster(
      engine,
      assembled.clipArtifactIds,
      assembled.audioArtifactId,
      notebookGridTag(cell.slot),
      { captions },
    );
    return {
      artifactId: result.artifactId,
      tool: "ffmpeg",
      cellInputs: {
        sequenceRevision: assembled.sequenceRevision,
        sequenceId: assembled.sequenceId,
        clipArtifactIds: assembled.clipArtifactIds,
        audioArtifactId: assembled.audioArtifactId,
        assemblyDurationFrames: assembled.assemblyDurationFrames,
        state: "completed",
      },
    };
  }

  if (
    cell.type === "splice"
    && (
      cell.operation === "splice_video"
      || cell.operation === "smooth_scene_concat"
    )
  ) {
    const result = await executeSpliceCell(
      engine,
      bookId,
      document,
      cell,
    );
    return {
      artifactId: result.artifactId,
      tool: result.tool,
      cellInputs: {
        state: "completed",
      },
    };
  }

  if (cell.type === "prompt" && cell.operation === "rewrite_prompt") {
    if (!options.confirmPaid) {
      throw new Error(
        `Paid prompt rewrite for ${notebookGridTag(cell.slot)} requires confirmation before starting`,
      );
    }
    const output = await rewritePromptCell(engine, document, cell, bookId);
    return {
      artifactId: output.artifactId,
      tool: output.tool,
      cellInputs: {
        resolvedPrompt: output.resolvedPrompt,
        rawRewriteResult: output.rawResult,
        state: "completed",
      },
    };
  }

  if (
    (
      cell.type === "generate_video"
      || cell.type === "generate_image"
      || cell.type === "generate_audio"
    )
    && getActionSpec(resolveNotebookGenerationTool(cell) ?? "")
  ) {
    const requiresConfirmation = cell.inputs?.requiresConfirmation === true
      || (cell.tool ?? cell.model ?? "").includes("seedance")
      || (cell.tool ?? cell.model) === DEFAULT_ANIMATION_TOOL;
    if (requiresConfirmation && !options.confirmPaid) {
      throw new Error(
        `Paid generation for ${notebookGridTag(cell.slot)} requires confirmation before starting`,
      );
    }
    const output = await generationTool(engine, document, cell, bookId, {
      ...(options.runId ? { runId: options.runId } : {}),
      ...(options.outputCellId ? { outputCellId: options.outputCellId } : {}),
    });
    const surface = cell.type === "generate_image"
      ? "image_generate"
      : cell.type === "generate_video"
        ? "video_generate"
        : cell.type === "generate_audio"
          ? "audio_generate"
          : null;
    if (surface && output.resolvedPrompt) {
      void engine.prompts.record({
        surface,
        prompt: output.resolvedPrompt,
        context: {
          notebookId: document.id,
          cellId: cell.id,
          tool: output.tool,
          model: output.model,
          artifactId: output.artifactId,
        },
      }).catch(() => {});
    }
    return {
      artifactId: output.artifactId,
      tool: output.tool,
      provider: output.provider,
      model: output.model,
      awaitingOutput: true,
      cellInputs: {
        providerArtifactId: output.artifactId,
        ...(output.resolvedPrompt
          ? { resolvedPrompt: output.resolvedPrompt }
          : {}),
        state: "awaiting-output",
      },
    };
  }

  throw new Error(`Cell operation ${cell.operation ?? "unset"} is not runnable`);
}

export async function runNotebookCell(
  engine: Engine,
  bookId: string,
  notebookId: string,
  document: NotebookDocument,
  cell: NotebookCell,
  options: { confirmPaid?: boolean; runId?: string; outputCellId?: string } = {},
): Promise<{
  document: NotebookDocument;
  outputArtifactId: string;
  status: "completed" | "awaiting-output";
}> {
  let normalizedDocument = migrateStackedGenerationResults(
    engine,
    normalizeLegacyExtractCells(normalizeLegacyAnalyzeDocument(document)),
  );
  let normalizedCell = normalizedDocument.cells.find((candidate) =>
    candidate.id === cell.id) ?? normalizeLegacyAnalyzeCell(cell);
  const generateMediaOutput = normalizedCell.type === "generate_audio"
    ? ensureGenerationMediaOutput(
        engine,
        normalizedDocument,
        normalizedCell,
      )
    : isConcurrentGenerationProducer(normalizedCell)
      ? findGenerationResultForRun(normalizedDocument, normalizedCell, {
          runId: options.runId,
          outputCellId: options.outputCellId,
        })
      : null;
  if (
    isConcurrentGenerationProducer(normalizedCell)
    && !generateMediaOutput
  ) {
    if (options.outputCellId) {
      throw new Error(
        `Generation output cell not found for run: ${options.outputCellId}`,
      );
    }
    const allocated = normalizedCell.type === "generate_image"
      ? allocateGenerateImageResult(engine, normalizedDocument, normalizedCell.id, {
          runId: options.runId ?? uuidv7(),
          acceptedAt: new Date().toISOString(),
        })
      : allocateGenerateVideoResult(engine, normalizedDocument, normalizedCell.id, {
          runId: options.runId ?? uuidv7(),
          acceptedAt: new Date().toISOString(),
        });
    const reserved = await mutateNotebook(
      engine,
      notebookId,
      normalizedCell.type === "generate_image"
        ? "allocate_generate_image_output"
        : "allocate_generate_video_output",
      () => allocated.document,
      { cellId: normalizedCell.id, outputCellId: allocated.outputCell.id },
    );
    if (!reserved.ok) throw new Error(reserved.error.message);
    const refreshed = engine.notebooks.read(notebookId);
    if (!refreshed.ok) throw new Error(refreshed.error.message);
    normalizedDocument = refreshed.value;
    normalizedCell = normalizedDocument.cells.find((candidate) =>
      candidate.id === cell.id) ?? normalizedCell;
    options = { ...options, outputCellId: allocated.outputCell.id };
  }
  if (
    generateMediaOutput
    && "document" in generateMediaOutput
    && generateMediaOutput.document !== normalizedDocument
  ) {
    const repaired = await mutateNotebook(
      engine,
      notebookId,
      "ensure_generate_audio_output",
      (current) => ensureGenerationMediaOutput(
        engine,
        current,
        normalizedCell,
      ).document,
      { cellId: normalizedCell.id },
    );
    if (!repaired.ok) throw new Error(repaired.error.message);
    const refreshed = engine.notebooks.read(notebookId);
    if (!refreshed.ok) throw new Error(refreshed.error.message);
    normalizedDocument = normalizeLegacyAnalyzeDocument(refreshed.value);
    normalizedCell = normalizedDocument.cells.find((candidate) =>
      candidate.id === cell.id) ?? normalizedCell;
  }
  const nextFingerprint = notebookCellFingerprint(
    normalizedDocument,
    normalizedCell,
  );
  const startedAt = new Date().toISOString();
  const runningState: CellExecution = {
    fingerprint: nextFingerprint,
    status: "running",
    ...(normalizedCell.outputArtifactId
      ? { outputArtifactId: normalizedCell.outputArtifactId }
      : {}),
    ...(options.runId ? { runId: options.runId } : {}),
    startedAt,
    updatedAt: startedAt,
    tool: normalizedCell.tool
      || normalizedCell.model
      || normalizedCell.operation,
  };
  const started = await mutateNotebook(
    engine,
    notebookId,
    "start_notebook_cell",
    (current) => withExecution(
      healGenerationMediaOutputResidue(
        normalizeLegacyAnalyzeDocument(current),
        normalizedCell,
        options.outputCellId,
      ),
      options.outputCellId && isConcurrentGenerationProducer(normalizedCell)
        ? options.outputCellId
        : normalizedCell.id,
      runningState,
    ),
    { cellId: normalizedCell.id, runId: options.runId, outputCellId: options.outputCellId },
  );
  if (!started.ok) throw new Error(started.error.message);
  const activeDocument = withExecution(
    healGenerationMediaOutputResidue(
      normalizedDocument,
      normalizedCell,
      options.outputCellId,
    ),
    options.outputCellId && isConcurrentGenerationProducer(normalizedCell)
      ? options.outputCellId
      : normalizedCell.id,
    runningState,
  );
  const activeCell = activeDocument.cells.find((candidate) =>
    candidate.id === normalizedCell.id);
  if (!activeCell) {
    throw new Error(`Notebook cell not found: ${normalizedCell.id}`);
  }
  try {
    const output = await executeLocalOrGeneration(
      engine,
      bookId,
      activeDocument,
      activeCell,
      options,
    );
    const updatedAt = new Date().toISOString();
    const status = output.awaitingOutput ? "awaiting-output" : "completed";
    const state: CellExecution = {
      fingerprint: nextFingerprint,
      status,
      outputArtifactId: output.artifactId,
      ...(output.awaitingOutput
        ? { providerArtifactId: output.artifactId }
        : { completedAt: updatedAt }),
      ...(options.runId ? { runId: options.runId } : {}),
      updatedAt,
      tool: output.tool,
    };
    const write = await mutateNotebook(
      engine,
      notebookId,
      "run_notebook_cell",
      (current) => {
        const base = output.document ?? current;
        const mediaOutput = findGenerationResultForRun(base, activeCell, {
          runId: options.runId,
          outputCellId: options.outputCellId,
        });
        // New-style generate_video / generate_image: artifact lives on the
        // dedicated output cell. Legacy/other cells keep inline
        // outputArtifactId on the action cell.
        const actionArtifactId = mediaOutput ? undefined : output.artifactId;
        const executionCellId = options.outputCellId
          && isConcurrentGenerationProducer(activeCell)
          ? options.outputCellId
          : activeCell.id;
        let withOutput = withExecution(
          base,
          executionCellId,
          state,
          actionArtifactId,
        );
        const resolvedPrompt =
          typeof output.cellInputs?.resolvedPrompt === "string"
            ? output.cellInputs.resolvedPrompt
            : "";
        if (mediaOutput) {
          withOutput = withMediaOutput(
            withOutput,
            new Set([mediaOutput.outputCell.id]),
            output.artifactId,
            {
              state: status,
              ...(resolvedPrompt ? { resolvedPrompt } : {}),
            },
          );
        }
        const actionBefore = withOutput.cells.find((candidate) =>
          candidate.id === activeCell.id);
        const fillActionPrompt = Boolean(resolvedPrompt)
          && !actionBefore?.prompt;
        const fillActionModel = output.model !== undefined
          && output.model !== actionBefore?.model;
        const fillActionTool = fillActionModel && !actionBefore?.tool;
        const actionCellChanged = fillActionPrompt || fillActionModel;
        const concurrentProducer = isConcurrentGenerationProducer(activeCell);
        const withCells = {
          ...withOutput,
          cells: withOutput.cells.map((candidate) => {
            if (candidate.id === activeCell.id) {
              const nextInputs = { ...(candidate.inputs ?? {}) };
              if (!concurrentProducer && output.cellInputs) {
                Object.assign(nextInputs, output.cellInputs);
              } else if (concurrentProducer) {
                delete nextInputs.state;
                delete nextInputs.providerArtifactId;
                if (
                  typeof output.cellInputs?.resolvedPrompt === "string"
                  && !nextInputs.resolvedPrompt
                ) {
                  nextInputs.resolvedPrompt = output.cellInputs.resolvedPrompt;
                }
              }
              return {
                ...candidate,
                ...(fillActionPrompt ? { prompt: resolvedPrompt } : {}),
                ...(fillActionModel ? { model: output.model } : {}),
                ...(fillActionTool ? { tool: output.tool } : {}),
                inputs: nextInputs,
              };
            }
            if (candidate.id === mediaOutput?.outputCell.id) {
              if (!resolvedPrompt && output.model === undefined) {
                return candidate;
              }
              return {
                ...candidate,
                ...(resolvedPrompt ? { prompt: resolvedPrompt } : {}),
                ...(output.model !== undefined ? { model: output.model } : {}),
              };
            }
            return candidate;
          }),
        };
        // Filling the empty prompt column changes the cell's fingerprint, so
        // the stored execution fingerprint must come from the updated
        // document — otherwise the cell would immediately read as stale.
        const finalCell = withCells.cells.find((candidate) =>
          candidate.id === activeCell.id);
        const fingerprint = actionCellChanged && finalCell
          ? notebookCellFingerprint(withCells, finalCell)
          : state.fingerprint;
        if (!mediaOutput && !actionCellChanged) return withCells;
        const concurrent = isConcurrentGenerationProducer(activeCell);
        const nextExecution = { ...executionState(withCells) };
        if (
          concurrent
          && options.runId
          && nextExecution[activeCell.id]?.runId === options.runId
        ) {
          delete nextExecution[activeCell.id];
        }
        return {
          ...withCells,
          execution: {
            ...nextExecution,
            ...(concurrent
              ? {}
              : {
                  [activeCell.id]: {
                    ...state,
                    fingerprint,
                    outputArtifactId: output.artifactId,
                  },
                }),
            ...(mediaOutput
              ? {
                  [mediaOutput.outputCell.id]: {
                    fingerprint,
                    status: status === "awaiting-output"
                      ? "awaiting-output"
                      : "completed",
                    outputArtifactId: output.artifactId,
                    updatedAt: state.updatedAt,
                    ...(state.completedAt
                      ? { completedAt: state.completedAt }
                      : {}),
                    ...(state.runId ? { runId: state.runId } : {}),
                    tool: state.tool,
                  } satisfies CellExecution,
                }
              : {}),
          },
        };
      },
      {
        cellId: activeCell.id,
        outputArtifactId: output.artifactId,
        tool: output.tool,
        status,
        runId: options.runId,
      },
      { artifactId: output.artifactId },
    );
    if (!write.ok) throw new Error(write.error.message);
    const read = engine.notebooks.read(notebookId);
    if (!read.ok) throw new Error(read.error.message);
    return {
      document: read.value,
      outputArtifactId: output.artifactId,
      status,
    };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    await patchGeneration(
      engine,
      activeGenerationIdForRun(
        engine,
        notebookId,
        activeCell.id,
        options.runId,
        undefined,
      ),
      { status: "failed", error: truncateGenerationError(message) },
    );
    const outputArtifactId = await failedArtifact(engine, activeCell, message);
    const state: CellExecution = {
      fingerprint: nextFingerprint,
      status: "error",
      outputArtifactId,
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...(options.runId ? { runId: options.runId } : {}),
      tool: activeCell.tool
        || activeCell.model
        || activeCell.operation,
      error: message,
    };
    const write = await mutateNotebook(
      engine,
      notebookId,
      "run_notebook_cell_failed",
      (current) => {
        const concurrent = isConcurrentGenerationProducer(activeCell);
        const targetCellId = concurrent && options.outputCellId
          ? options.outputCellId
          : activeCell.id;
        const withFailure = withExecution(
          current,
          targetCellId,
          state,
          concurrent ? undefined : outputArtifactId,
        );
        if (!concurrent) return withFailure;
        const execution = { ...executionState(withFailure) };
        if (
          options.runId
          && execution[activeCell.id]?.runId === options.runId
        ) {
          delete execution[activeCell.id];
        }
        const cells = withFailure.cells.map((candidate) => {
          if (candidate.id !== activeCell.id) return candidate;
          const inputs = { ...(candidate.inputs ?? {}) };
          delete inputs.state;
          delete inputs.providerArtifactId;
          return { ...candidate, inputs };
        });
        return { ...withFailure, execution, cells };
      },
      {
        cellId: activeCell.id,
        outputArtifactId,
        error: message.slice(0, 500),
        runId: options.runId,
        tool: state.tool,
      },
      { artifactId: outputArtifactId },
    );
    if (!write.ok) throw new Error(write.error.message);
    throw new Error(message);
  }
}

export function notebookCellIsStale(
  engine: Engine,
  document: NotebookDocument,
  cell: NotebookCell,
): boolean {
  const execution = executionState(document)[cell.id];
  if (!execution) return true;
  if (
    execution.status === "running"
    || execution.status === "awaiting-output"
  ) {
    return false;
  }
  if (execution.fingerprint !== notebookCellFingerprint(document, cell)) return true;
  if (execution.status === "error" || execution.error) return true;
  if (execution.status === "stale" || execution.stale) return true;
  // generate_video / generate_image may hold the artifact only on the output cell.
  const artifactId = resolveNotebookCellArtifactId(document, cell)
    ?? execution.outputArtifactId;
  if (!artifactId) return true;
  if (!engine.artifacts.get(artifactId).ok) return true;
  return false;
}

function notebookCellNeedsExecution(
  engine: Engine,
  document: NotebookDocument,
  cell: NotebookCell,
): boolean {
  if (notebookCellIsRunnable(cell)) {
    return notebookCellIsStale(engine, document, cell);
  }
  const artifactId = resolveNotebookCellArtifactId(document, cell)
    ?? cell.outputArtifactId
    ?? cell.outputEntityId;
  return !artifactId || !engine.artifacts.get(artifactId).ok;
}

function notebookCellHasReusableMediaOutput(
  engine: Engine,
  document: NotebookDocument,
  cell: NotebookCell,
): boolean {
  const mediaType = notebookCellMediaType(cell);
  if (!mediaType) return false;
  const artifactId = resolveNotebookCellArtifactId(document, cell)
    ?? cell.outputArtifactId
    ?? cell.outputEntityId;
  if (!artifactId) return false;
  const artifact = engine.artifacts.get(artifactId);
  const artifactMediaType = artifact.ok && artifact.value.kind === "final"
    ? "video"
    : artifact.ok ? artifact.value.kind : null;
  if (!artifact.ok || artifactMediaType !== mediaType) return false;
  if (!notebookCellIsRunnable(cell)) return true;
  const mediaOutput = findGenerationMediaOutput(document, cell);
  if (mediaOutput) {
    const outputExecution = executionState(document)[mediaOutput.outputCell.id];
    if (
      mediaOutput.outputCell.inputs?.state === "completed"
      || outputExecution?.status === "completed"
    ) {
      return true;
    }
  }
  const execution = executionState(document)[cell.id];
  return execution?.status === "completed" && !execution.error;
}

function requiredNotebookCellIds(
  engine: Engine,
  document: NotebookDocument,
  cellIds: readonly string[],
  forceSelected: boolean,
): Set<string> {
  const cells = new Map(document.cells.map((cell) => [cell.id, cell]));
  const parents = new Map<string, string[]>();
  for (const edge of document.edges) {
    const list = parents.get(edge.target) ?? [];
    list.push(edge.source);
    parents.set(edge.target, list);
  }
  const required = new Set(cellIds);
  const expanded = new Set<string>();
  const stack = cellIds.filter((cellId) => {
    const cell = cells.get(cellId);
    return forceSelected || !cell || notebookCellNeedsExecution(
      engine,
      document,
      cell,
    );
  });
  while (stack.length > 0) {
    const id = stack.pop();
    if (!id || expanded.has(id)) continue;
    expanded.add(id);
    for (const parentId of parents.get(id) ?? []) {
      const parent = cells.get(parentId);
      if (
        parent
        && notebookCellHasReusableMediaOutput(engine, document, parent)
      ) {
        continue;
      }
      required.add(parentId);
      if (!parent) continue;
      if (!notebookCellNeedsExecution(engine, document, parent)) continue;
      stack.push(parentId);
    }
  }
  return required;
}

function generationPlanClaimField(
  plan: Record<string, unknown>,
  field: "runId" | "outputCellId",
): string | null {
  const claim = plan.executionClaim;
  return claim
    && typeof claim === "object"
    && !Array.isArray(claim)
    && typeof (claim as Record<string, unknown>)[field] === "string"
    ? (claim as Record<string, unknown>)[field] as string
    : null;
}

function generationPlanClaimRunId(
  plan: Record<string, unknown>,
): string | null {
  return generationPlanClaimField(plan, "runId");
}

export function generationPlanClaimOutputCellId(
  plan: Record<string, unknown>,
): string | null {
  return generationPlanClaimField(plan, "outputCellId");
}

function concurrentProducerIdForCell(cell: NotebookCell): string | null {
  if (isConcurrentGenerationProducer(cell)) return cell.id;
  const producerId = cell.inputs?.producerCellId;
  if (isImageVideoGenerationResult(cell) && typeof producerId === "string") {
    return producerId;
  }
  return null;
}

function awaitJobCoverageIds(payload: Record<string, unknown>): string[] {
  const ids: string[] = [];
  if (typeof payload.cellId === "string") ids.push(payload.cellId);
  if (typeof payload.outputCellId === "string") ids.push(payload.outputCellId);
  return [...new Set(ids)];
}

function awaitJobCoversExecution(input: {
  payload: Record<string, unknown>;
  notebookId: string;
  cellId: string;
  producerCellId: string | null;
  runId: string;
}): boolean {
  if (input.payload.notebookId !== input.notebookId) return false;
  if (
    typeof input.payload.runId === "string"
    && input.payload.runId !== input.runId
  ) {
    return false;
  }
  const covered = awaitJobCoverageIds(input.payload);
  if (covered.includes(input.cellId)) return true;
  if (input.producerCellId && covered.includes(input.producerCellId)) {
    const jobOutput = typeof input.payload.outputCellId === "string"
      ? input.payload.outputCellId
      : null;
    if (!jobOutput) return true;
    return jobOutput === input.cellId;
  }
  return false;
}

function resolveAwaitNotebookTarget(
  document: NotebookDocument,
  input: { cellId: string; outputCellId?: string },
): { cell: NotebookCell | undefined; outputCellId?: string } {
  const requested = document.cells.find((candidate) =>
    candidate.id === input.cellId);
  if (!requested) {
    return { cell: undefined, outputCellId: input.outputCellId };
  }
  if (isImageVideoGenerationResult(requested)) {
    const producerId = requested.inputs?.producerCellId;
    const producer = typeof producerId === "string"
      ? document.cells.find((candidate) => candidate.id === producerId)
      : undefined;
    return {
      cell: producer ?? requested,
      outputCellId: input.outputCellId ?? requested.id,
    };
  }
  return { cell: requested, outputCellId: input.outputCellId };
}

export async function claimNotebookGenerationPlan(
  engine: Engine,
  notebookId: string,
  cellId: string,
  planId: string,
  runId: string,
): Promise<Record<string, unknown>> {
  let claimedPlan: Record<string, unknown> | null = null;
  const claimedAt = new Date().toISOString();
  const result = await mutateNotebook(
    engine,
    notebookId,
    "claim_notebook_generation_plan",
    (document) => {
      const record = (document.generationPlans ?? []).find((candidate) =>
        candidate.planId === planId && candidate.cellId === cellId);
      if (!record) throw new Error("Generation plan is not preserved in this notebook");
      if (record.status !== "planned") {
        throw new Error(`Generation plan is already ${record.status}`);
      }
      if (generationPlanClaimRunId(record.plan)) {
        throw new Error("Generation plan is already claimed");
      }
      const cell = document.cells.find((candidate) => candidate.id === cellId);
      if (!cell) throw new Error("Notebook cell not found");
      const expected = record.plan.cellDefinitionFingerprint
        ?? record.plan.cellFingerprint;
      if (expected !== notebookCellDefinitionFingerprint(document, cell)) {
        throw new Error("Generation plan is stale for the selected cell");
      }
      const execution = executionState(document)[cellId];
      const concurrent = isConcurrentGenerationProducer(cell);
      if (
        !concurrent
        && (
          execution?.status === "queued"
          || execution?.status === "running"
          || execution?.status === "awaiting-output"
        )
      ) {
        throw new Error(
          `Notebook cell ${notebookGridTag(cell.slot)} is already ${execution.status}`,
        );
      }
      let working = document;
      let outputCellId: string | undefined;
      if (cell.type === "generate_image" || cell.type === "generate_video") {
        const allocated = cell.type === "generate_image"
          ? allocateGenerateImageResult(engine, working, cell.id, {
              runId,
              planId,
              acceptedAt: claimedAt,
            })
          : allocateGenerateVideoResult(engine, working, cell.id, {
              runId,
              planId,
              acceptedAt: claimedAt,
            });
        working = allocated.document;
        outputCellId = allocated.outputCell.id;
      }
      claimedPlan = {
        ...record.plan,
        executionClaim: {
          runId,
          claimedAt,
          ...(outputCellId ? { outputCellId } : {}),
        },
      };
      const state: CellExecution = {
        fingerprint: notebookCellFingerprint(working, cell),
        status: "queued",
        runId,
        startedAt: claimedAt,
        updatedAt: claimedAt,
        tool: cell.tool || cell.model || cell.operation,
      };
      const queued = outputCellId
        ? withExecution(working, outputCellId, state)
        : withExecution(working, cellId, {
            ...state,
            ...(cell.outputArtifactId
              ? { outputArtifactId: cell.outputArtifactId }
              : {}),
          });
      return {
        ...queued,
        generationPlans: (queued.generationPlans ?? []).map((candidate) =>
          candidate.planId === planId
            ? {
                ...candidate,
                status: "queued",
                plan: claimedPlan!,
                updatedAt: claimedAt,
              }
            : candidate),
      };
    },
    { notebookId, cellId, planId, runId },
  );
  if (!result.ok) throw new Error(result.error.message);
  if (!claimedPlan) throw new Error("Generation plan claim was not persisted");
  return claimedPlan;
}

interface QueuedNotebookFailureOptions {
  cellIds: readonly string[];
  runId?: string;
  error: string;
  generationPlanId?: string;
  runPlanId?: string;
  allowLegacyUnboundGenerationPlan?: boolean;
}

export async function failQueuedNotebookCells(
  engine: Engine,
  notebookId: string,
  options: QueuedNotebookFailureOptions,
): Promise<number> {
  const selected = new Set(options.cellIds);
  if (
    selected.size === 0
    && !options.generationPlanId
    && !options.runPlanId
  ) return 0;
  const snapshot = engine.notebooks.read(notebookId);
  if (!snapshot.ok) return 0;
  const queuedCellIds = new Set([
    ...[...selected].filter((cellId) => {
      const state = executionState(snapshot.value)[cellId];
      return state?.status === "queued" && state.runId === options.runId;
    }),
    ...Object.entries(executionState(snapshot.value)).flatMap(([cellId, state]) =>
      state?.status === "queued" && state.runId === options.runId ? [cellId] : []),
  ]);
  const failedCellIds = new Set([...selected].filter((cellId) => {
    const state = executionState(snapshot.value)[cellId];
    return state?.status === "error" && state.runId === options.runId;
  }));
  const terminalCellIds = new Set([...queuedCellIds, ...failedCellIds]);
  const hasGenerationPlan = (snapshot.value.generationPlans ?? []).some((record) =>
    record.status === "queued"
    && terminalCellIds.has(record.cellId)
    && record.planId === options.generationPlanId
    && (
      generationPlanClaimRunId(record.plan) === options.runId
      || (
        options.allowLegacyUnboundGenerationPlan === true
        && generationPlanClaimRunId(record.plan) === null
      )
    ));
  const hasRunPlan = Boolean(
    options.runPlanId
    && notebookRunPlanRecords(snapshot.value).some((record) =>
      record.planId === options.runPlanId
      && record.status === "queued"
      && record.runId === options.runId
      && (selected.size === 0 || terminalCellIds.size > 0)),
  );
  if (queuedCellIds.size === 0 && !hasGenerationPlan && !hasRunPlan) return 0;

  const updatedAt = new Date().toISOString();
  let terminalized = 0;
  const result = await mutateNotebook(
    engine,
    notebookId,
    "fail_queued_notebook_cells",
    (document) => {
      const execution = { ...executionState(document) };
      const transitionedCellIds = new Set<string>();
      for (const [cellId, state] of Object.entries(execution)) {
        if (state?.status !== "queued" || state.runId !== options.runId) continue;
        if (selected.size > 0 && !queuedCellIds.has(cellId) && !selected.has(cellId)) {
          continue;
        }
        execution[cellId] = {
          ...state,
          status: "error",
          completedAt: updatedAt,
          updatedAt,
          error: options.error,
        };
        transitionedCellIds.add(cellId);
      }
      const planCellIds = new Set([...selected, ...transitionedCellIds]);
      for (const [cellId, state] of Object.entries(execution)) {
        if (state?.status === "error" && state.runId === options.runId) {
          planCellIds.add(cellId);
        }
      }
      terminalized = transitionedCellIds.size;
      return {
        ...document,
        execution,
        cells: document.cells.map((cell) =>
          transitionedCellIds.has(cell.id)
            ? {
                ...cell,
                inputs: { ...(cell.inputs ?? {}), state: "error" },
              }
            : cell),
        generationPlans: (document.generationPlans ?? []).map((record) =>
          record.status === "queued"
          && planCellIds.has(record.cellId)
          && record.planId === options.generationPlanId
          && (
            generationPlanClaimRunId(record.plan) === options.runId
            || (
              options.allowLegacyUnboundGenerationPlan === true
              && generationPlanClaimRunId(record.plan) === null
            )
          )
            ? {
                ...record,
                status: "failed",
                updatedAt,
                error: truncateGenerationError(options.error),
              }
            : record),
        notebookRunPlans: notebookRunPlanRecords(document).map((record) =>
          record.planId === options.runPlanId
          && record.status === "queued"
          && record.runId === options.runId
          && (selected.size === 0 || planCellIds.size > 0)
            ? {
                ...record,
                status: "failed",
                updatedAt,
                error: options.error,
              }
            : record),
      };
    },
    {
      cellIds: [...selected],
      runId: options.runId,
      error: options.error.slice(0, 500),
      generationPlanId: options.generationPlanId,
      runPlanId: options.runPlanId,
      allowLegacyUnboundGenerationPlan: options.allowLegacyUnboundGenerationPlan,
    },
  );
  if (!result.ok) throw new Error(result.error.message);
  return terminalized;
}

export interface AwaitNotebookOutputPayload {
  type: "await_notebook_output";
  bookId: string;
  notebookId: string;
  cellId: string;
  providerArtifactId: string;
  runId: string;
  outputCellId?: string;
  runPlanId?: string;
  generationPlan?: Record<string, unknown>;
  actor?: string;
  cellIds?: string[];
}

function notebookRunPlanRecords(
  document: NotebookDocument,
): NotebookRunPlan[] {
  return document.notebookRunPlans ?? [];
}

async function updateNotebookRunPlanState(
  engine: Engine,
  notebookId: string,
  planId: string,
  status: string,
  details: Partial<NotebookRunPlan> = {},
): Promise<void> {
  const result = await mutateNotebook(
    engine,
    notebookId,
    "update_notebook_run_plan",
    (document) => ({
      ...document,
      notebookRunPlans: notebookRunPlanRecords(document).map((record) =>
        record.planId === planId
        && typeof details.runId === "string"
        && record.runId === details.runId
          ? {
              ...record,
              status,
              ...details,
              updatedAt: new Date().toISOString(),
            }
          : record),
    }),
    { planId, status, ...details },
  );
  if (!result.ok) throw new Error(result.error.message);
}

function paidCellAuthorized(
  document: NotebookDocument,
  cell: NotebookCell,
  input: RunNotebookPayload,
): boolean {
  if (!notebookCellIsPaid(cell)) return true;
  const expectedFingerprint = notebookCellDefinitionFingerprint(document, cell);
  if (input.runPlanId) {
    const record = notebookRunPlanRecords(document).find((candidate) =>
      candidate.planId === input.runPlanId);
    const fingerprints = record?.cellDefinitionFingerprints;
    return Boolean(
      record
      && (record.status === "queued" || record.status === "awaiting-output")
      && record.runId === input.runId
      && fingerprints?.[cell.id] === expectedFingerprint,
    );
  }
  const planId = input.generationPlan?.planId;
  if (typeof planId !== "string") return false;
  const records = document.generationPlans ?? [];
  const record = records.find((candidate) =>
    candidate.planId === planId && candidate.cellId === cell.id);
  const plan = record?.plan;
  return Boolean(
    record
    && (record.status === "queued" || record.status === "awaiting-output")
    && generationPlanClaimRunId(record.plan) === input.runId
    && plan
    && typeof plan === "object"
    && !Array.isArray(plan)
    && (
      (plan as Record<string, unknown>).cellDefinitionFingerprint
        ?? (plan as Record<string, unknown>).cellFingerprint
    ) === expectedFingerprint,
  );
}

function dispatchedPromptFor(
  cell: NotebookCell,
  dispatchedPayload: Record<string, unknown> | null,
): string {
  if (
    typeof cell.inputs?.resolvedPrompt === "string"
    && cell.inputs.resolvedPrompt
  ) {
    return cell.inputs.resolvedPrompt;
  }
  const payloadInput = dispatchedPayload?.input;
  const payloadPrompt = payloadInput
    && typeof payloadInput === "object"
    && !Array.isArray(payloadInput)
    ? (payloadInput as Record<string, unknown>).prompt
    : dispatchedPayload?.prompt;
  return typeof payloadPrompt === "string" ? payloadPrompt : "";
}

async function finishAwaitingNotebookCell(
  engine: Engine,
  input: AwaitNotebookOutputPayload,
): Promise<{ outputArtifactId: string; document: NotebookDocument }> {
  const read = engine.notebooks.read(input.notebookId);
  if (!read.ok) throw new Error(read.error.message);
  const resolvedTarget = resolveAwaitNotebookTarget(read.value, input);
  const cell = resolvedTarget.cell;
  if (!cell) throw new Error(`Awaiting notebook cell not found: ${input.cellId}`);
  input = {
    ...input,
    cellId: cell.id,
    ...(resolvedTarget.outputCellId
      ? { outputCellId: resolvedTarget.outputCellId }
      : {}),
  };
  const initialOutput = isConcurrentGenerationProducer(cell)
    ? findGenerationResultForRun(read.value, cell, {
        runId: input.runId,
        outputCellId: input.outputCellId,
      })
    : null;
  if (isConcurrentGenerationProducer(cell) && !initialOutput) {
    throw new Error(`Awaiting generation result not found for run ${input.runId}`);
  }
  const generationId = activeGenerationIdForRun(
    engine,
    input.notebookId,
    cell.id,
    input.runId,
    input.providerArtifactId,
  );
  const current = executionState(read.value)[
    initialOutput?.outputCell.id ?? cell.id
  ];
  if (
    current?.status === "completed"
    && current.outputArtifactId
    && engine.artifacts.get(current.outputArtifactId).ok
  ) {
    await patchGeneration(engine, generationId, {
      status: "completed",
      outputArtifactId: current.outputArtifactId,
    });
    return {
      outputArtifactId: current.outputArtifactId,
      document: read.value,
    };
  }
  let outputArtifactId = input.providerArtifactId;
  const payloadResult = await engine.metadata.artifacts.read<
    Record<string, unknown>
  >(input.providerArtifactId, "generation-payload");
  const dispatchedPayload = payloadResult.ok ? payloadResult.value : null;
  const resolvedPrompt = dispatchedPromptFor(cell, dispatchedPayload);
  const cellInputs: Record<string, unknown> = {
    providerArtifactId: input.providerArtifactId,
    ...(dispatchedPayload ? { dispatchedPayload } : {}),
    ...(resolvedPrompt ? { resolvedPrompt } : {}),
    state: "completed",
  };
  if (notebookCellMediaType(cell) === "video") {
    const audioArtifactId = firstUpstreamArtifact(
      read.value,
      cell,
      "replace_audio",
    );
    if (audioArtifactId) {
      const durationSeconds = Math.max(
        1,
        Number(cell.inputs?.duration ?? 15),
      );
      const normalized = await normalizeSceneVideo(
        engine,
        input.providerArtifactId,
        audioArtifactId,
        `${notebookGridTag(cell.slot)} normalized`,
        durationSeconds,
      );
      outputArtifactId = normalized.artifactId;
      cellInputs.normalizedFromArtifactId = input.providerArtifactId;
      cellInputs.normalizedDurationSeconds = normalized.durationSeconds;
    }
  }
  const completedAt = new Date().toISOString();
  const state: CellExecution = {
    fingerprint: current?.fingerprint
      ?? notebookCellFingerprint(read.value, cell),
    status: "completed",
    outputArtifactId,
    providerArtifactId: input.providerArtifactId,
    runId: input.runId,
    completedAt,
    updatedAt: completedAt,
    tool: current?.tool ?? cell.tool ?? cell.model,
  };
  const updated = await mutateNotebook(
    engine,
    input.notebookId,
    "complete_notebook_provider_output",
    (document) => {
      let working = document;
      let resolvedOutput = findGenerationResultForRun(working, cell, {
        runId: input.runId,
        outputCellId: input.outputCellId,
      });
      if (
        cell.type === "generate_audio"
        && !resolvedOutput
      ) {
        const ensured = ensureGenerationMediaOutput(engine, working, cell);
        working = ensured.document;
        resolvedOutput = {
          outputCell: ensured.outputCell,
          outputEdge: ensured.outputEdge,
        };
      }
      const concurrent = isConcurrentGenerationProducer(cell);
      const executionCellId = concurrent && resolvedOutput
        ? resolvedOutput.outputCell.id
        : cell.id;
      let withOutput = withExecution(
        working,
        executionCellId,
        state,
        concurrent || resolvedOutput ? undefined : outputArtifactId,
      );
      if (resolvedOutput) {
        withOutput = withMediaOutput(
          withOutput,
          new Set([resolvedOutput.outputCell.id]),
          outputArtifactId,
          {
            state: "completed",
            ...(resolvedPrompt ? { resolvedPrompt } : {}),
            ...(dispatchedPayload ? { dispatchedPayload } : {}),
          },
        );
      }
      const outputCellId = resolvedOutput?.outputCell.id;
      const actionBefore = withOutput.cells.find((candidate) =>
        candidate.id === cell.id);
      const fillActionPrompt = Boolean(resolvedPrompt)
        && !actionBefore?.prompt;
      const withCells = {
        ...withOutput,
        cells: withOutput.cells.map((candidate) => {
          if (candidate.id === cell.id) {
            const nextInputs = { ...(candidate.inputs ?? {}) };
            if (!concurrent) Object.assign(nextInputs, cellInputs);
            else {
              delete nextInputs.state;
              delete nextInputs.providerArtifactId;
              if (resolvedPrompt && !nextInputs.resolvedPrompt) {
                nextInputs.resolvedPrompt = resolvedPrompt;
              }
            }
            return {
              ...candidate,
              ...(fillActionPrompt ? { prompt: resolvedPrompt } : {}),
              inputs: nextInputs,
            };
          }
          if (candidate.id === outputCellId && resolvedPrompt) {
            return { ...candidate, prompt: resolvedPrompt };
          }
          return candidate;
        }),
      };
      // Filling the empty prompt column changes the cell's fingerprint, so
      // the stored execution fingerprint must come from the updated document
      // — otherwise the completed cell would immediately read as stale.
      const finalCell = withCells.cells.find((candidate) =>
        candidate.id === cell.id);
      const fingerprint = fillActionPrompt && finalCell
        ? notebookCellFingerprint(withCells, finalCell)
        : state.fingerprint;
      const nextExecution = { ...executionState(withCells) };
      if (concurrent && nextExecution[cell.id]?.runId === input.runId) {
        delete nextExecution[cell.id];
      }
      return {
        ...withCells,
        execution: {
          ...nextExecution,
          ...(concurrent
            ? {}
            : {
                [cell.id]: {
                  ...state,
                  fingerprint,
                  outputArtifactId,
                },
              }),
          ...(outputCellId
            ? {
                [outputCellId]: {
                  fingerprint,
                  status: "completed",
                  outputArtifactId,
                  completedAt,
                  updatedAt: completedAt,
                  ...(input.runId ? { runId: input.runId } : {}),
                  tool: state.tool,
                } satisfies CellExecution,
              }
            : {}),
        },
      };
    },
    {
      cellId: cell.id,
      providerArtifactId: input.providerArtifactId,
      outputArtifactId,
      runId: input.runId,
      tool: state.tool,
    },
    { artifactId: outputArtifactId },
  );
  if (!updated.ok) throw new Error(updated.error.message);
  await patchGeneration(engine, generationId, {
    status: "completed",
    outputArtifactId,
  });
  const refreshed = engine.notebooks.read(input.notebookId);
  if (!refreshed.ok) throw new Error(refreshed.error.message);
  return { outputArtifactId, document: refreshed.value };
}

async function failAwaitingNotebookCell(
  engine: Engine,
  input: AwaitNotebookOutputPayload,
  message: string,
): Promise<NotebookDocument> {
  const updatedAt = new Date().toISOString();
  const result = await mutateNotebook(
    engine,
    input.notebookId,
    "fail_notebook_provider_output",
    (document) => {
      const resolvedTarget = resolveAwaitNotebookTarget(document, input);
      const cell = resolvedTarget.cell;
      if (!cell) return document;
      const outputCellId = resolvedTarget.outputCellId;
      const concurrent = isConcurrentGenerationProducer(cell);
      const runMatchedOutput = concurrent
        ? document.cells.find((candidate) =>
          candidate.id !== cell.id
          && (
            candidate.inputs?.generationRunId === input.runId
            || executionState(document)[candidate.id]?.runId === input.runId
          ))
        : undefined;
      const failTargetId = (concurrent
        ? outputCellId ?? runMatchedOutput?.id
        : undefined) ?? cell.id;
      const current = executionState(document)[failTargetId]
        ?? executionState(document)[cell.id];
      const withFailure = withExecution(document, failTargetId, {
        fingerprint: current?.fingerprint
          ?? notebookCellFingerprint(document, cell),
        status: "error",
        outputArtifactId: input.providerArtifactId,
        providerArtifactId: input.providerArtifactId,
        runId: input.runId,
        completedAt: updatedAt,
        updatedAt,
        tool: current?.tool ?? cell.tool ?? cell.model,
        error: message,
      }, isConcurrentGenerationProducer(cell) ? undefined : input.providerArtifactId);
      if (isConcurrentGenerationProducer(cell)) {
        const execution = { ...executionState(withFailure) };
        if (
          execution[cell.id]?.runId === input.runId
          && execution[cell.id]?.status === "awaiting-output"
        ) {
          delete execution[cell.id];
        }
        return {
          ...withFailure,
          execution,
          cells: withFailure.cells.map((candidate) =>
            candidate.id === failTargetId
              ? {
                  ...candidate,
                  inputs: {
                    ...(candidate.inputs ?? {}),
                    state: "error",
                  },
                }
              : candidate),
        };
      }
      return rollbackGenerationMediaOutput(
        withFailure,
        cell,
        input.providerArtifactId,
        outputCellId,
      );
    },
    {
      cellId: input.cellId,
      providerArtifactId: input.providerArtifactId,
      runId: input.runId,
      error: message.slice(0, 500),
    },
    { artifactId: input.providerArtifactId },
  );
  if (!result.ok) throw new Error(result.error.message);
  await patchGeneration(
    engine,
    activeGenerationIdForRun(
      engine,
      input.notebookId,
      input.cellId,
      input.runId,
      input.providerArtifactId,
    ),
    { status: "failed", error: truncateGenerationError(message) },
  );
  const read = engine.notebooks.read(input.notebookId);
  if (!read.ok) throw new Error(read.error.message);
  return read.value;
}

export async function failNotebookProviderOutput(
  engine: Engine,
  input: AwaitNotebookOutputPayload,
): Promise<NotebookDocument> {
  return await failAwaitingNotebookCell(
    engine,
    input,
    notebookProviderFailureMessage(engine, input),
  );
}

function runHasAwaitingCells(
  document: NotebookDocument,
  runId: string,
): boolean {
  return Object.values(executionState(document)).some((execution) =>
    execution.runId === runId && execution.status === "awaiting-output");
}

async function enqueueNotebookResume(
  input: AwaitNotebookOutputPayload,
  document: NotebookDocument,
): Promise<void> {
  if (runHasAwaitingCells(document, input.runId)) return;
  await queue.enqueue(`resume-notebook-${input.runId}`, {
    type: "run_notebook",
    bookId: input.bookId,
    notebookId: input.notebookId,
    runId: input.runId,
    resume: true,
    force: false,
    ...(input.cellIds ? { cellIds: input.cellIds } : {}),
    ...(input.outputCellId ? { outputCellId: input.outputCellId } : {}),
    ...(input.runPlanId ? { runPlanId: input.runPlanId } : {}),
    ...(input.generationPlan ? { generationPlan: input.generationPlan } : {}),
    ...(input.actor ? { actor: input.actor } : {}),
  });
}

async function awaitNotebookOutput(
  engine: Engine,
  input: AwaitNotebookOutputPayload,
): Promise<void> {
  const deadline = Date.now() + 45 * 60_000;
  while (Date.now() < deadline) {
    const status = await engine.status.get(input.providerArtifactId);
    if (!status.ok) throw new Error(status.error.message);
    if (status.value === "ready") {
      const completed = await finishAwaitingNotebookCell(engine, input);
      if (
        input.generationPlan
        && !input.runPlanId
        && typeof input.generationPlan.planId === "string"
      ) {
        await updateGenerationPlanState(
          engine,
          input.notebookId,
          input.generationPlan.planId,
          "continued",
          { outputArtifactId: completed.outputArtifactId, runId: input.runId },
        );
      }
      await enqueueNotebookResume(input, completed.document);
      return;
    }
    if (status.value === "error") {
      const document = await failNotebookProviderOutput(engine, input);
      await enqueueNotebookResume(input, document);
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
  }
  const document = await failAwaitingNotebookCell(
    engine,
    input,
    `Provider output ${input.providerArtifactId} timed out`,
  );
  await enqueueNotebookResume(input, document);
}

export function registerRunNotebookJob(engine: Engine): void {
  registerJobHandler("await_notebook_output", async (payload) => {
    const input = payload as unknown as AwaitNotebookOutputPayload;
    try {
      await awaitNotebookOutput(engine, input);
      return { status: "completed" };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      try {
        await failAwaitingNotebookCell(engine, input, message);
      } catch {
        // Best-effort: surface the original await failure if we cannot write
        // execution state (for example, notebook already deleted).
      }
      throw cause;
    }
  });
  const runNotebookHandler = async (payload: Record<string, unknown>) => {
    const input = payload as unknown as RunNotebookPayload;
    const runId = input.runId ?? uuidv7();
    const initial = engine.notebooks.read(input.notebookId);
    if (!initial.ok) throw new Error(initial.error.message);
    let document = normalizeLegacyAnalyzeDocument(initial.value);
    if (document !== initial.value) {
      const normalized = await mutateNotebook(
        engine,
        input.notebookId,
        "normalize_legacy_analyze_cells",
        normalizeLegacyAnalyzeDocument,
      );
      if (!normalized.ok) throw new Error(normalized.error.message);
      const refreshed = engine.notebooks.read(input.notebookId);
      if (!refreshed.ok) throw new Error(refreshed.error.message);
      document = refreshed.value;
    }
    const selected = input.cellIds ? new Set(input.cellIds) : null;
    const required = selected
      ? requiredNotebookCellIds(
          engine,
          document,
          [...selected],
          input.force === true,
        )
      : new Set<string>();
    const ordered = topologicalOrder(document);
    const requestedOutputCellId = input.outputCellId
      ?? generationPlanClaimOutputCellId(input.generationPlan ?? {})
      ?? undefined;
    const outputs: Record<string, string> = {};
    const errors: string[] = [];
    const blocked = new Set<string>();
    const waiting = new Set<string>();
    for (const cell of ordered) {
      if (!notebookCellIsRunnable(cell)) {
        const output = resolveNotebookCellArtifactId(document, cell)
          ?? cell.outputArtifactId
          ?? cell.outputEntityId;
        if (output) outputs[cell.id] = output;
        continue;
      }
      if (selected && !required.has(cell.id)) continue;
      const upstreamBlocked = document.edges
        .filter((edge) => edge.target === cell.id)
        .some((edge) => blocked.has(edge.source));
      if (upstreamBlocked) {
        blocked.add(cell.id);
        errors.push(`${notebookGridTag(cell.slot)}: blocked by failed upstream dependency`);
        continue;
      }
      const upstreamWaiting = document.edges
        .filter((edge) => edge.target === cell.id)
        .some((edge) => waiting.has(edge.source));
      if (upstreamWaiting) {
        waiting.add(cell.id);
        continue;
      }
      const invocationOutput = isConcurrentGenerationProducer(cell)
        ? findGenerationResultForRun(document, cell, {
            runId,
            outputCellId: requestedOutputCellId,
          })
        : null;
      const invocationExecution = invocationOutput
        ? executionState(document)[invocationOutput.outputCell.id]
        : undefined;
      const currentExecution = invocationExecution?.runId === runId
        ? invocationExecution
        : executionState(document)[cell.id];
      if (
        currentExecution?.status === "awaiting-output"
        || currentExecution?.status === "running"
      ) {
        waiting.add(cell.id);
        continue;
      }
      if (
        input.resume
        && currentExecution?.runId === runId
        && currentExecution.status === "error"
      ) {
        const message = currentExecution.error ?? "provider output failed";
        errors.push(`${notebookGridTag(cell.slot)}: ${message}`);
        blocked.add(cell.id);
        continue;
      }
      if (
        input.resume
        && invocationOutput
        && currentExecution?.runId === runId
        && currentExecution.status === "completed"
      ) {
        const artifactId = currentExecution.outputArtifactId
          ?? invocationOutput.outputCell.outputArtifactId;
        if (artifactId && engine.artifacts.get(artifactId).ok) {
          outputs[cell.id] = artifactId;
          continue;
        }
      }
      const stale = notebookCellIsStale(engine, document, cell);
      const forceCell = input.force === true
        && (!selected || selected.has(cell.id));
      if (!forceCell && !stale) {
        const artifactId = resolveNotebookCellArtifactId(document, cell)
          ?? cell.outputArtifactId;
        if (artifactId) outputs[cell.id] = artifactId;
        continue;
      }
      const paidAuthorized = paidCellAuthorized(document, cell, input);
      if (notebookCellIsPaid(cell) && !paidAuthorized) {
        const message =
          `${notebookGridTag(cell.slot)}: the saved plan no longer matches this cell's contents; rerun the cell to replan`;
        errors.push(message);
        blocked.add(cell.id);
        continue;
      }
      try {
        const result = await runNotebookCell(
          engine,
          input.bookId,
          input.notebookId,
          document,
          cell,
          {
            confirmPaid: paidAuthorized,
            runId,
            ...(requestedOutputCellId
              ? { outputCellId: requestedOutputCellId }
              : {}),
          },
        );
        document = result.document;
        outputs[cell.id] = result.outputArtifactId;
        if (
          input.generationPlan
          && !input.runPlanId
          && typeof input.generationPlan.planId === "string"
        ) {
          await writeGenerationPlanProvenance(
            engine,
            input,
            cell,
            result.outputArtifactId,
          );
          await updateGenerationPlanState(
            engine,
            input.notebookId,
            input.generationPlan.planId,
            result.status === "awaiting-output"
              ? "awaiting-output"
              : "continued",
            { outputArtifactId: result.outputArtifactId, runId },
          );
        }
        if (result.status === "awaiting-output") {
          waiting.add(cell.id);
          await queue.enqueue(
            `await-notebook-${runId}-${cell.id}-${result.outputArtifactId}`,
            {
              type: "await_notebook_output",
              bookId: input.bookId,
              notebookId: input.notebookId,
              cellId: cell.id,
              providerArtifactId: result.outputArtifactId,
              runId,
              ...(requestedOutputCellId
                ? {
                    outputCellId: requestedOutputCellId,
                  }
                : {}),
              ...(input.runPlanId ? { runPlanId: input.runPlanId } : {}),
              ...(input.generationPlan
                ? { generationPlan: input.generationPlan }
                : {}),
              ...(input.actor ? { actor: input.actor } : {}),
              ...(input.cellIds ? { cellIds: input.cellIds } : {}),
            },
          );
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        errors.push(`${notebookGridTag(cell.slot)}: ${message}`);
        blocked.add(cell.id);
        if (
          input.generationPlan
          && !input.runPlanId
          && typeof input.generationPlan.planId === "string"
        ) {
          await updateGenerationPlanState(
            engine,
            input.notebookId,
            input.generationPlan.planId,
            "failed",
            { error: message, runId },
          );
        }
        const refreshed = engine.notebooks.read(input.notebookId);
        if (refreshed.ok) document = refreshed.value;
      }
    }
    if (waiting.size > 0) {
      if (input.runPlanId) {
        await updateNotebookRunPlanState(
          engine,
          input.notebookId,
          input.runPlanId,
          "awaiting-output",
          {
            runId,
            outputs,
            ...(errors.length > 0 ? { error: errors.join("\n") } : {}),
          },
        );
      }
      if (errors.length > 0) {
        throw new Error(
          `Notebook run is awaiting output with cell errors:\n${errors.join("\n")}`,
        );
      }
      return {
        id: runId,
        notebookId: input.notebookId,
        status: "awaiting-output",
        cellOrder: ordered.map((cell) => cell.id),
        outputs,
        waitingCellIds: [...waiting],
        errors,
      };
    }
    const now = new Date().toISOString();
    const run: NotebookRun = {
      id: runId,
      notebookId: input.notebookId,
      status: errors.length === 0 ? "completed" : "failed",
      startedAt: now,
      completedAt: now,
      cellOrder: ordered.map((cell) => cell.id),
      outputs,
      ...(errors.length > 0 ? { error: errors.join("\n") } : {}),
    };
    const recorded = await engine.notebooks.recordRun(run);
    if (!recorded.ok) throw new Error(recorded.error.message);
    if (input.runPlanId) {
      await updateNotebookRunPlanState(
        engine,
        input.notebookId,
        input.runPlanId,
        errors.length === 0 ? "completed" : "failed",
        {
          runId,
          outputs,
          ...(errors.length > 0 ? { error: errors.join("\n") } : {}),
        },
      );
    }
    if (errors.length > 0) throw new Error(errors.join("\n"));
    return run;
  };
  registerJobHandler("run_notebook", async (payload) => {
    const input = payload as unknown as RunNotebookPayload;
    try {
      return await runNotebookHandler(payload);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const generationPlanId = typeof input.generationPlan?.planId === "string"
        ? input.generationPlan.planId
        : undefined;
      if (typeof input.runId === "string") {
        await failQueuedNotebookCells(engine, input.notebookId, {
          cellIds: input.cellIds ?? [],
          runId: input.runId,
          error: message,
          ...(generationPlanId ? { generationPlanId } : {}),
          ...(input.runPlanId ? { runPlanId: input.runPlanId } : {}),
        }).catch(() => undefined);
      }
      throw cause;
    }
  });
}

export async function reconcileAwaitingNotebookOutputs(
  engine: Engine,
  bookId: string,
): Promise<number> {
  const activeJobs = engine.jobs.queue.list({
    states: ["queued", "running", "completing"],
    type: "await_notebook_output",
  });
  const failedJobs = engine.jobs.queue.list({
    states: ["failed", "aborted"],
    type: "await_notebook_output",
  });
  let enqueued = 0;
  for (const notebook of engine.notebooks.list()) {
    const execution = executionState(notebook);
    for (const [cellId, state] of Object.entries(execution)) {
      if (
        state.status !== "awaiting-output"
        || !state.providerArtifactId
        || !state.runId
      ) {
        continue;
      }
      const stateRunId = state.runId;
      const providerArtifactId = state.providerArtifactId;
      const cell = notebook.cells.find((candidate) => candidate.id === cellId);
      const producerCellId = cell
        ? concurrentProducerIdForCell(cell)
        : null;
      const coveredByActive = activeJobs.some((job) =>
        awaitJobCoversExecution({
          payload: job.payload,
          notebookId: notebook.id,
          cellId,
          producerCellId,
          runId: stateRunId,
        }));
      if (coveredByActive) continue;
      const matchingFailed = failedJobs
        .filter((job) =>
          awaitJobCoversExecution({
            payload: job.payload,
            notebookId: notebook.id,
            cellId,
            producerCellId,
            runId: stateRunId,
          }))
        .sort((left, right) => right.id - left.id);
      const latestFailed = matchingFailed[0];
      const awaitProducerId = producerCellId ?? cellId;
      const awaitOutputCellId = cell && isImageVideoGenerationResult(cell)
        ? cellId
        : undefined;
      if (latestFailed) {
        const message = latestFailed.error?.message
          ?? `Notebook await ${latestFailed.state}`;
        await failAwaitingNotebookCell(
          engine,
          {
            type: "await_notebook_output",
            bookId,
            notebookId: notebook.id,
            cellId: awaitProducerId,
            providerArtifactId,
            runId: stateRunId,
            ...(awaitOutputCellId ? { outputCellId: awaitOutputCellId } : {}),
          },
          message,
        );
        continue;
      }
      const runPlan = notebookRunPlanRecords(notebook).find((record) =>
        record.runId === stateRunId
        && (
          record.status === "queued"
          || record.status === "awaiting-output"
        ));
      const generationRecords = notebook.generationPlans ?? [];
      const generationRecord = generationRecords.find((candidate) =>
        (candidate.cellId === awaitProducerId || candidate.cellId === cellId)
        && (
          candidate.status === "queued"
          || candidate.status === "awaiting-output"
        )
        && (
          generationPlanClaimRunId(candidate.plan) === stateRunId
          || generationPlanClaimRunId(candidate.plan) === null
        ));
      const generationPlan = runPlan?.plan ?? generationRecord?.plan;
      await queue.enqueue(
        `reconcile-await-notebook-${stateRunId}-${awaitProducerId}-${
          awaitOutputCellId ?? cellId
        }-${Date.now()}`,
        {
          type: "await_notebook_output",
          bookId,
          notebookId: notebook.id,
          cellId: awaitProducerId,
          providerArtifactId,
          runId: stateRunId,
          ...(awaitOutputCellId ? { outputCellId: awaitOutputCellId } : {}),
          ...(typeof runPlan?.planId === "string"
            ? { runPlanId: runPlan.planId }
            : {}),
          ...(generationPlan ? { generationPlan } : {}),
          cellIds: [awaitProducerId],
          actor: "notebook-reconciler",
        },
      );
      enqueued += 1;
    }
  }
  return enqueued;
}

export async function reconcileGenerationMediaOutputs(
  engine: Engine,
): Promise<number> {
  let repaired = 0;
  for (const notebook of engine.notebooks.list()) {
    const normalized = ensureGenerationMediaOutputs(engine, notebook);
    if (normalized === notebook) continue;
    const result = await mutateNotebook(
      engine,
      notebook.id,
      "reconcile_generation_media_outputs",
      (current) => ensureGenerationMediaOutputs(engine, current),
    );
    if (!result.ok) throw new Error(result.error.message);
    repaired += 1;
  }
  return repaired;
}

async function notebookRunHasLiveWork(
  engine: Engine,
  document: NotebookDocument,
  runId: string,
  runPlanId?: string,
): Promise<boolean> {
  if (notebookRunPlanRecords(document).some((record) =>
    (record.runId === runId || record.planId === runPlanId)
    && record.status === "awaiting-output")) return true;
  const activeJobs = engine.jobs.queue.list({
    states: ["queued", "running", "completing"],
  });
  if (activeJobs.some((job) =>
    job.payload.notebookId === document.id
    && job.payload.runId === runId
    && (job.type === "run_notebook" || job.type === "await_notebook_output"))) {
    return true;
  }
  const pending = await engine.jobs.pending.findAll();
  if (!pending.ok) return true;
  const activeArtifactIds = new Set(pending.value.map((task) => task.artifactId));
  for (const job of activeJobs) {
    if (job.artifactId) activeArtifactIds.add(job.artifactId);
  }
  if (activeArtifactIds.size === 0) return false;
  const runArtifactIds = new Set<string>();
  for (const state of Object.values(executionState(document))) {
    if (state.runId !== runId) continue;
    if (state.providerArtifactId) runArtifactIds.add(state.providerArtifactId);
    if (state.outputArtifactId) runArtifactIds.add(state.outputArtifactId);
  }
  for (const cell of document.cells) {
    const generations = engine.generations.listForCell(document.id, cell.id);
    if (!generations.ok) return true;
    for (const generation of generations.value) {
      if (generation.runId !== runId) continue;
      if (generation.providerArtifactId) {
        runArtifactIds.add(generation.providerArtifactId);
      }
      if (generation.outputArtifactId) {
        runArtifactIds.add(generation.outputArtifactId);
      }
    }
  }
  return [...runArtifactIds].some((artifactId) =>
    activeArtifactIds.has(artifactId));
}

export async function reconcileQueuedNotebookCells(
  engine: Engine,
): Promise<number> {
  let terminalized = 0;
  for (const listed of engine.notebooks.list()) {
    for (const [cellId, listedState] of Object.entries(executionState(listed))) {
      if (listedState.status !== "queued" || !listedState.runId) continue;
      const read = engine.notebooks.read(listed.id);
      if (!read.ok) continue;
      const document = read.value;
      const state = executionState(document)[cellId];
      if (state?.status !== "queued" || state.runId !== listedState.runId) continue;
      const cell = document.cells.find((candidate) => candidate.id === cellId);
      const invocationResult = Boolean(cell && isImageVideoGenerationResult(cell));
      const producerCellId = cell
        ? concurrentProducerIdForCell(cell) ?? cell.id
        : cellId;
      const producer = document.cells.find((candidate) =>
        candidate.id === producerCellId) ?? cell;
      if (!cell || (!invocationResult && !notebookCellIsRunnable(cell))) continue;
      const terminalJobs = engine.jobs.queue.list({
        states: ["done", "failed", "aborted"],
        type: "run_notebook",
      });
      const matchingTerminal = terminalJobs
        .filter((job) => {
          if (
            job.payload.notebookId !== document.id
            || job.payload.runId !== state.runId
          ) return false;
          const cellIds = job.payload.cellIds;
          const jobOutputCellId = typeof job.payload.outputCellId === "string"
            ? job.payload.outputCellId
            : null;
          return !Array.isArray(cellIds)
            || cellIds.includes(cellId)
            || cellIds.includes(producerCellId)
            || jobOutputCellId === cellId;
        })
        .sort((left, right) => right.id - left.id);
      const terminalJob = matchingTerminal[0];
      if (terminalJob?.state === "done") continue;
      const claimedPlans = (document.generationPlans ?? []).filter((record) =>
        record.cellId === producerCellId
        && record.status === "queued"
        && generationPlanClaimRunId(record.plan) === state.runId
        && (
          !invocationResult
          || generationPlanClaimOutputCellId(record.plan) === cellId
          || generationPlanClaimOutputCellId(record.plan) === null
        ));
      if (
        !terminalJob
        && producer
        && notebookCellIsPaid(producer)
        && claimedPlans.length !== 1
      ) continue;
      const runPlanId = typeof terminalJob?.payload.runPlanId === "string"
        ? terminalJob.payload.runPlanId
        : undefined;
      if (await notebookRunHasLiveWork(
        engine,
        document,
        state.runId,
        runPlanId,
      )) continue;
      const latest = engine.notebooks.read(document.id);
      if (!latest.ok) continue;
      const latestState = executionState(latest.value)[cellId];
      if (latestState?.status !== "queued" || latestState.runId !== state.runId) {
        continue;
      }
      if (await notebookRunHasLiveWork(
        engine,
        latest.value,
        state.runId,
        runPlanId,
      )) continue;
      const message = terminalJob?.error?.message
        ?? (terminalJob
          ? `Notebook run ${terminalJob.state} before queued cell ${
              notebookGridTag(cell.slot)
            } started`
          : `Queued notebook run has no persisted job for ${
              notebookGridTag(cell.slot)
            }`);
      const plan = terminalJob?.payload.generationPlan;
      const terminalPlanId = plan
        && typeof plan === "object"
        && !Array.isArray(plan)
        && typeof (plan as Record<string, unknown>).planId === "string"
        ? (plan as Record<string, unknown>).planId as string
        : undefined;
      const generationPlanId = terminalPlanId ?? claimedPlans[0]?.planId;
      terminalized += await failQueuedNotebookCells(engine, document.id, {
        cellIds: [...new Set([cellId, producerCellId])],
        runId: state.runId,
        error: message,
        ...(generationPlanId ? { generationPlanId } : {}),
        ...(runPlanId ? { runPlanId } : {}),
        ...(terminalJob ? { allowLegacyUnboundGenerationPlan: true } : {}),
      });
    }
  }
  for (const listed of engine.notebooks.list()) {
    for (const listedPlan of notebookRunPlanRecords(listed)) {
      if (listedPlan.status !== "queued" || !listedPlan.runId) continue;
      const read = engine.notebooks.read(listed.id);
      if (!read.ok) continue;
      const document = read.value;
      const plan = notebookRunPlanRecords(document).find((candidate) =>
        candidate.planId === listedPlan.planId);
      if (
        plan?.status !== "queued"
        || plan.runId !== listedPlan.runId
      ) continue;
      const terminalJobs = engine.jobs.queue.list({
        states: ["done", "failed", "aborted"],
        type: "run_notebook",
      });
      const terminalJob = terminalJobs
        .filter((job) =>
          job.payload.notebookId === document.id
          && job.payload.runId === plan.runId)
        .sort((left, right) => right.id - left.id)[0];
      if (terminalJob?.state === "done") continue;
      if (await notebookRunHasLiveWork(
        engine,
        document,
        plan.runId,
        plan.planId,
      )) continue;
      const latest = engine.notebooks.read(document.id);
      if (!latest.ok) continue;
      const latestPlan = notebookRunPlanRecords(latest.value).find((candidate) =>
        candidate.planId === plan.planId);
      if (
        latestPlan?.status !== "queued"
        || latestPlan.runId !== plan.runId
      ) continue;
      if (await notebookRunHasLiveWork(
        engine,
        latest.value,
        plan.runId,
        plan.planId,
      )) continue;
      const message = terminalJob?.error?.message
        ?? (terminalJob
          ? `Notebook run ${terminalJob.state} before aggregate plan completed`
          : "Claimed aggregate notebook run has no persisted job");
      await failQueuedNotebookCells(engine, document.id, {
        cellIds: [],
        runId: plan.runId,
        runPlanId: plan.planId,
        error: message,
      });
      const reconciled = engine.notebooks.read(document.id);
      if (
        reconciled.ok
        && notebookRunPlanRecords(reconciled.value).some((candidate) =>
          candidate.planId === plan.planId && candidate.status === "failed")
      ) terminalized += 1;
    }
  }
  return terminalized;
}

export async function abortLeasedNotebookRunsOnStartup(
  engine: Engine,
): Promise<number> {
  const leased = engine.jobs.queue.list({
    states: ["running", "completing"],
    type: "run_notebook",
  });
  let aborted = 0;
  for (const job of leased) {
    if (await engine.jobs.queue.abort(
      job.id,
      "Server restarted before notebook run completed",
    )) aborted += 1;
  }
  return aborted;
}

export function topologicalOrder(notebook: NotebookDocument): NotebookCell[] {
  const cells = new Map(notebook.cells.map((cell) => [cell.id, cell]));
  const incoming = new Map(notebook.cells.map((cell) => [cell.id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const edge of notebook.edges) {
    if (!cells.has(edge.source) || !cells.has(edge.target)) {
      throw new Error(`Notebook edge references a missing cell: ${edge.id}`);
    }
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
    const targets = outgoing.get(edge.source) ?? [];
    targets.push(edge.target);
    outgoing.set(edge.source, targets);
  }
  const ready = notebook.cells
    .filter((cell) => incoming.get(cell.id) === 0)
    .map((cell) => cell.id);
  const ordered: NotebookCell[] = [];
  while (ready.length > 0) {
    const id = ready.shift();
    if (!id) continue;
    const cell = cells.get(id);
    if (cell) ordered.push(cell);
    for (const target of outgoing.get(id) ?? []) {
      const count = (incoming.get(target) ?? 0) - 1;
      incoming.set(target, count);
      if (count === 0) ready.push(target);
    }
  }
  if (ordered.length !== notebook.cells.length) throw new Error("Notebook graph contains a cycle");
  return ordered;
}
