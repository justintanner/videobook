import { createHash } from "node:crypto";
import { v5 as uuidv5, v7 as uuidv7 } from "uuid";
import { z } from "zod";
import type {
  EditIntent,
  EditOperation,
  Engine,
  ClipPlacement,
  NotebookCell,
  NotebookDocument,
  NotebookRunPlan,
  NotebookRun,
} from "videobook-engine";
import { MVP_CONTRACT_VERSION } from "videobook-engine";
import { mutateNotebook } from "../notebook-mutations.js";
import {
  ensureExtractFrameImageOutput,
  findExtractFrameImageOutput,
} from "../notebook-cell-outputs.js";
import { queue, registerJobHandler, waitForJob } from "../queue.js";
import type { ToolDef, ToolResult } from "../tools/tool-def.js";
import { smoothSceneConcatDef } from "../tools/smooth-scene-concat.js";
import { spliceVideoDef } from "../tools/splice-video.js";
import { getActionSpec } from "../generation-registry.js";
import {
  captureFrame,
  exportSequenceMaster,
  extractSourceAudio,
  normalizeSceneVideo,
  splitSourceRange,
  type BurnInCaption,
} from "../notebook-media-ops.js";
import { analyzeNotebookSource } from "../notebook-live-analysis.js";
import { analysisFixtureForCell } from "../notebook-fixtures.js";
import { applyAnalysisResults } from "../notebook-workflow.js";
import {
  DEFAULT_ANIMATION_TOOL,
  DEFAULT_IMAGE_TOOL,
  DEFAULT_VIDEO_TOOL,
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

export interface RunNotebookPayload {
  type: "run_notebook";
  bookId: string;
  notebookId: string;
  cellIds?: string[];
  force?: boolean;
  generationPlan?: Record<string, unknown>;
  runPlanId?: string;
  runId?: string;
  resume?: boolean;
  actor?: string;
  jobId?: string;
}

export type NotebookCellExecutionStatus =
  | "running"
  | "awaiting-output"
  | "completed"
  | "stale"
  | "error";

export interface CellExecution {
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

export const defaultNotebookGenerationModel: Record<
  "image" | "video" | "audio",
  string
> = {
  image: DEFAULT_IMAGE_TOOL,
  video: DEFAULT_VIDEO_TOOL,
  audio: "generate_elevenlabs_text_to_audio",
};

export function notebookCellMediaType(
  cell: NotebookCell,
): "image" | "video" | "audio" | null {
  if (
    cell.type === "image"
    || cell.type === "extract_frame"
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
  return (
    cell.type !== "audio"
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
    first_asset_id: firstArtifact.value.slug,
    second_asset_id: secondArtifact.value.slug,
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
        output: source.outputArtifactId ?? source.outputEntityId,
      }];
    });
}

function stableCellInputs(
  inputs: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const volatile = new Set([
    "state",
    "resolvedPrompt",
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
    slug: cell.slug,
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
    slug: cell.slug,
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
      slug: source.slug,
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
    .find((entry) => entry.targetInput === "video");
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
    .filter(({ cell: source }) => source.operation === "rewrite_prompt")
    .map(({ cell: source }) =>
      typeof source.inputs?.resolvedPrompt === "string"
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
    : [cell.prompt ?? ""];
  return [...new Set([...own, ...upstream].filter(Boolean))]
    .join("\n\n")
    .trim();
}

function artifactSlugRef(engine: Engine, artifactId: string): string {
  const artifact = engine.artifacts.get(artifactId);
  if (artifact.ok && artifact.value.slug) return `@${artifact.value.slug}`;
  return `@${artifactId}`;
}

function isImageLikeCell(source: NotebookCell): boolean {
  return notebookCellMediaType(source) === "image";
}

export function modelArgs(
  definition: ToolDef,
  document: NotebookDocument,
  cell: NotebookCell,
  bookId: string,
  engine?: Engine,
): Record<string, unknown> {
  const args: Record<string, unknown> = {
    ...(cell.inputs ?? {}),
    book_id: bookId,
    prompt: promptFor(document, cell),
  };
  if (
    definition.name === "generate_kie_gemini_omni_video"
    && args.duration === undefined
  ) {
    args.duration = "8";
  }
  if (cell.operation === "rewrite_prompt" && "model" in definition.schema) {
    args.model = typeof cell.inputs?.targetModel === "string"
      ? cell.inputs.targetModel
      : "seedance2";
  }
  const upstream = upstreamValues(document, cell);
  const refFor = (artifactId: string): string =>
    engine ? artifactSlugRef(engine, artifactId) : `@${artifactId}`;

  const firstFrame = upstream.find((entry) =>
    entry.targetInput === "first_frame" && typeof entry.output === "string");
  const lastFrame = upstream.find((entry) =>
    entry.targetInput === "last_frame" && typeof entry.output === "string");
  if (firstFrame?.output && "first_frame_slug" in definition.schema) {
    args.first_frame_slug = refFor(firstFrame.output);
  }
  if (lastFrame?.output && "last_frame_slug" in definition.schema) {
    args.last_frame_slug = refFor(lastFrame.output);
  }
  if (lastFrame?.output && "end_frame_slug" in definition.schema) {
    args.end_frame_slug = refFor(lastFrame.output);
  }

  const imageReferences = upstream
    .filter(({ cell: source, output, targetInput }) =>
      typeof output === "string"
      && isImageLikeCell(source)
      && targetInput !== "first_frame"
      && targetInput !== "last_frame")
    .map(({ output }) => refFor(output!));
  if ("image_slugs" in definition.schema && imageReferences.length > 0) {
    args.image_slugs = imageReferences;
  }
  if ("image_slug" in definition.schema && imageReferences[0]) {
    args.image_slug = imageReferences[0];
  }
  const videoReferences = upstream
    .filter(({ cell: source, output }) =>
      typeof output === "string"
      && notebookCellMediaType(source) === "video")
    .map(({ output }) => refFor(output!));
  if ("video_slugs" in definition.schema && videoReferences.length > 0) {
    args.video_slugs = videoReferences;
  }
  if ("video_slug" in definition.schema && videoReferences[0]) {
    args.video_slug = videoReferences[0];
  }
  if ("first_clip_slug" in definition.schema && videoReferences[0]) {
    args.first_clip_slug = videoReferences[0];
  }
  const replacementAudio = upstream.find((entry) =>
    entry.targetInput === "replace_audio" && typeof entry.output === "string");
  if (
    replacementAudio?.output
    && "replace_audio_with" in definition.schema
  ) {
    args.replace_audio_with = refFor(replacementAudio.output);
  }
  const audioReferences = upstream
    .filter(({ cell: source, output, targetInput }) =>
      typeof output === "string"
      && notebookCellMediaType(source) === "audio"
      && targetInput !== "replace_audio")
    .map(({ output }) => refFor(output!));
  if (
    "audio_slugs" in definition.schema
    && audioReferences.length > 0
    && !firstFrame?.output
    && !lastFrame?.output
  ) {
    args.audio_slugs = audioReferences;
  }
  if ("audio_slug" in definition.schema && audioReferences[0]) {
    args.audio_slug = audioReferences[0];
  }
  if ("driving_audio_slug" in definition.schema && audioReferences[0]) {
    args.driving_audio_slug = audioReferences[0];
  }
  return args;
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
): Promise<{
  tool: string;
  provider: string;
  model: string;
  input: Record<string, unknown>;
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
    && !("image_slugs" in definition.schema)
    && !("image_slug" in definition.schema)
  ) {
    const connectedImages = upstreamValues(document, cell).filter((entry) =>
      typeof entry.output === "string" && isImageLikeCell(entry.cell)).length;
    if (connectedImages > 0) {
      throw new Error(
        `@${cell.slug} has ${connectedImages} image input(s) connected, but ${tool} `
        + "accepts no image and would ignore them — switch OPERATION to "
        + "image_to_image or edit_image, or disconnect the image input",
      );
    }
  }
  const inputContract = notebookGenerationInputContract(tool, definition.schema);
  if (!notebookGenerationInputsAreCompatible(inputContract, document, cell)) {
    throw new Error(
      `${tool} does not accept the current media inputs for @${cell.slug}`,
    );
  }
  const parsed = z.object(definition.schema).safeParse(
    modelArgs(definition, document, cell, bookId, engine),
  );
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  return {
    tool,
    provider: spec?.provider ?? "unknown",
    model: spec?.apicity_identifier ?? cell.model ?? tool,
    input: parsed.data as Record<string, unknown>,
  };
}

async function generationTool(
  engine: Engine,
  document: NotebookDocument,
  cell: NotebookCell,
  bookId: string,
): Promise<{ artifactId: string; tool: string }> {
  const prepared = await prepareNotebookGeneration(engine, document, cell, bookId);
  const { getAllToolDefs } = await import("../tools/index.js");
  const definition = getAllToolDefs(engine).find(
    (candidate) => candidate.name === prepared.tool,
  );
  if (!definition) {
    throw new Error(`Unknown notebook generation model: ${prepared.tool}`);
  }
  const response = await definition.handler(prepared.input);
  if (response.isError) {
    throw new Error(response.content[0]?.text ?? `${prepared.tool} failed`);
  }
  const reference = artifactReference(textResult(response));
  if (!reference) {
    throw new Error(`${prepared.tool} did not return an output artifact`);
  }
  const artifact = engine.artifacts.get(reference);
  if (!artifact.ok) throw new Error(artifact.error.message);
  return { artifactId: artifact.value.artifactId, tool: prepared.tool };
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
    name: `script ${cell.slug} resolved prompt`,
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
    name: kind === "script"
      ? `script ${cell.slug} failed`
      : `${cell.slug} failed`,
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
    name: `${cell.slug} assembly`,
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
  options: { confirmPaid?: boolean } = {},
): Promise<{
  artifactId: string;
  tool: string;
  document?: NotebookDocument;
  cellInputs?: Record<string, unknown>;
  awaitingOutput?: boolean;
}> {
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
      cell.slug,
    );
    const firstFrame = await captureFrame(engine, result.artifactId, {
      role: "first",
      title: `${cell.slug} · first frame`,
    });
    const lastFrame = await captureFrame(engine, result.artifactId, {
      role: "last",
      title: `${cell.slug} · last frame`,
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

  if (cell.type === "extract_audio" && cell.operation === "extract_audio") {
    const sourceId = requiredVideoInputArtifact(document, cell);
    const outputCellIds = requiredMediaOutputCellIds(
      document,
      cell,
      "audio",
    );
    const result = await extractSourceAudio(engine, sourceId, cell.slug);
    return {
      artifactId: result.artifactId,
      tool: "ffmpeg",
      document: withMediaOutput(
        document,
        outputCellIds,
        result.artifactId,
        { durationSeconds: result.durationSeconds },
      ),
      cellInputs: { durationSeconds: result.durationSeconds },
    };
  }

  if (cell.type === "extract_frame" && cell.operation === "extract_frame") {
    const sourceId = requiredVideoInputArtifact(document, cell);
    const outputCellIds = requiredMediaOutputCellIds(
      document,
      cell,
      "image",
    );
    const configuredMode = cell.inputs?.frameMode;
    const frameMode = configuredMode === "time" || configuredMode === "last"
      ? configuredMode
      : "first";
    const timestampSeconds = Number(cell.inputs?.timestampSeconds);
    if (
      frameMode === "time"
      && (!Number.isFinite(timestampSeconds) || timestampSeconds < 0)
    ) {
      throw new Error(
        `extract_frame cell ${cell.id} requires a nonnegative timestamp`,
      );
    }
    const result = await captureFrame(engine, sourceId, {
      role: frameMode,
      ...(frameMode === "time" ? { timestampSeconds } : {}),
      title: `${cell.slug} · ${frameMode} frame`,
    });
    const outputInputs = {
      frameMode,
      ...(frameMode === "time" ? { timestampSeconds } : {}),
      atSeconds: result.atSeconds,
    };
    return {
      artifactId: result.artifactId,
      tool: "ffmpeg",
      document: withMediaOutput(
        document,
        outputCellIds,
        result.artifactId,
        outputInputs,
      ),
      cellInputs: outputInputs,
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
      cell.slug,
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
        `Paid prompt rewrite for @${cell.slug} requires confirmation before starting`,
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
        `Paid generation for @${cell.slug} requires confirmation before starting`,
      );
    }
    const output = await generationTool(engine, document, cell, bookId);
    return {
      artifactId: output.artifactId,
      tool: output.tool,
      awaitingOutput: true,
      cellInputs: {
        providerArtifactId: output.artifactId,
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
  options: { confirmPaid?: boolean; runId?: string } = {},
): Promise<{
  document: NotebookDocument;
  outputArtifactId: string;
  status: "completed" | "awaiting-output";
}> {
  let normalizedDocument = normalizeLegacyAnalyzeDocument(document);
  let normalizedCell = normalizedDocument.cells.find((candidate) =>
    candidate.id === cell.id) ?? normalizeLegacyAnalyzeCell(cell);
  if (
    normalizedCell.type === "extract_frame"
    && !findExtractFrameImageOutput(normalizedDocument, normalizedCell.id)
  ) {
    const repaired = await mutateNotebook(
      engine,
      notebookId,
      "ensure_extract_frame_image_output",
      (current) => ensureExtractFrameImageOutput(
        engine,
        current,
        normalizedCell.id,
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
      normalizeLegacyAnalyzeDocument(current),
      normalizedCell.id,
      runningState,
    ),
    { cellId: normalizedCell.id, runId: options.runId },
  );
  if (!started.ok) throw new Error(started.error.message);
  const activeDocument = withExecution(
    normalizedDocument,
    normalizedCell.id,
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
        const withOutput = withExecution(
          base,
          activeCell.id,
          state,
          output.artifactId,
        );
        if (!output.cellInputs) return withOutput;
        return {
          ...withOutput,
          cells: withOutput.cells.map((candidate) =>
            candidate.id === activeCell.id
              ? {
                  ...candidate,
                  inputs: {
                    ...(candidate.inputs ?? {}),
                    ...output.cellInputs,
                  },
                }
              : candidate),
        };
      },
      {
        cellId: activeCell.id,
        outputArtifactId: output.artifactId,
        tool: output.tool,
        status,
        runId: options.runId,
      },
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
      (current) => withExecution(
        current,
        activeCell.id,
        state,
        outputArtifactId,
      ),
      {
        cellId: activeCell.id,
        outputArtifactId,
        error: message,
        runId: options.runId,
      },
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
  if (!cell.outputArtifactId) return true;
  if (!engine.artifacts.get(cell.outputArtifactId).ok) return true;
  return false;
}

function ancestorsOf(
  document: NotebookDocument,
  cellId: string,
): Set<string> {
  const parents = new Map<string, string[]>();
  for (const edge of document.edges) {
    const list = parents.get(edge.target) ?? [];
    list.push(edge.source);
    parents.set(edge.target, list);
  }
  const seen = new Set<string>();
  const stack = [...(parents.get(cellId) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    stack.push(...(parents.get(id) ?? []));
  }
  return seen;
}

interface AwaitNotebookOutputPayload {
  type: "await_notebook_output";
  bookId: string;
  notebookId: string;
  cellId: string;
  providerArtifactId: string;
  runId: string;
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

export async function updateNotebookRunPlanState(
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
    && plan
    && typeof plan === "object"
    && !Array.isArray(plan)
    && (
      (plan as Record<string, unknown>).cellDefinitionFingerprint
        ?? (plan as Record<string, unknown>).cellFingerprint
    ) === expectedFingerprint,
  );
}

async function finishAwaitingNotebookCell(
  engine: Engine,
  input: AwaitNotebookOutputPayload,
): Promise<{ outputArtifactId: string; document: NotebookDocument }> {
  const read = engine.notebooks.read(input.notebookId);
  if (!read.ok) throw new Error(read.error.message);
  const cell = read.value.cells.find((candidate) => candidate.id === input.cellId);
  if (!cell) throw new Error(`Awaiting notebook cell not found: ${input.cellId}`);
  const current = executionState(read.value)[cell.id];
  if (
    current?.status === "completed"
    && current.outputArtifactId
    && engine.artifacts.get(current.outputArtifactId).ok
  ) {
    return {
      outputArtifactId: current.outputArtifactId,
      document: read.value,
    };
  }
  let outputArtifactId = input.providerArtifactId;
  const cellInputs: Record<string, unknown> = {
    providerArtifactId: input.providerArtifactId,
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
        `${cell.slug} normalized`,
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
      const withOutput = withExecution(
        document,
        cell.id,
        state,
        outputArtifactId,
      );
      return {
        ...withOutput,
        cells: withOutput.cells.map((candidate) =>
          candidate.id === cell.id
            ? {
                ...candidate,
                inputs: {
                  ...(candidate.inputs ?? {}),
                  ...cellInputs,
                },
              }
            : candidate),
      };
    },
    {
      cellId: cell.id,
      providerArtifactId: input.providerArtifactId,
      outputArtifactId,
      runId: input.runId,
    },
  );
  if (!updated.ok) throw new Error(updated.error.message);
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
      const cell = document.cells.find((candidate) => candidate.id === input.cellId);
      if (!cell) return document;
      const current = executionState(document)[cell.id];
      return withExecution(document, cell.id, {
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
      }, input.providerArtifactId);
    },
    {
      cellId: input.cellId,
      providerArtifactId: input.providerArtifactId,
      runId: input.runId,
      error: message,
    },
  );
  if (!result.ok) throw new Error(result.error.message);
  const read = engine.notebooks.read(input.notebookId);
  if (!read.ok) throw new Error(read.error.message);
  return read.value;
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
          { outputArtifactId: completed.outputArtifactId },
        );
      }
      await enqueueNotebookResume(input, completed.document);
      return;
    }
    if (status.value === "error") {
      const document = await failAwaitingNotebookCell(
        engine,
        input,
        `Provider output ${input.providerArtifactId} failed`,
      );
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
  registerJobHandler("run_notebook", async (payload) => {
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
    const required = new Set<string>();
    if (selected) {
      for (const cellId of selected) {
        required.add(cellId);
        for (const ancestor of ancestorsOf(document, cellId)) {
          required.add(ancestor);
        }
      }
    }
    const ordered = topologicalOrder(document);
    const outputs: Record<string, string> = {};
    const errors: string[] = [];
    const blocked = new Set<string>();
    const waiting = new Set<string>();
    for (const cell of ordered) {
      if (!notebookCellIsRunnable(cell)) {
        const output = cell.outputArtifactId ?? cell.outputEntityId;
        if (output) outputs[cell.id] = output;
        continue;
      }
      if (selected && !required.has(cell.id)) continue;
      const upstreamBlocked = document.edges
        .filter((edge) => edge.target === cell.id)
        .some((edge) => blocked.has(edge.source));
      if (upstreamBlocked) {
        blocked.add(cell.id);
        errors.push(`@${cell.slug}: blocked by failed upstream dependency`);
        continue;
      }
      const upstreamWaiting = document.edges
        .filter((edge) => edge.target === cell.id)
        .some((edge) => waiting.has(edge.source));
      if (upstreamWaiting) {
        waiting.add(cell.id);
        continue;
      }
      const currentExecution = executionState(document)[cell.id];
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
        errors.push(`@${cell.slug}: ${message}`);
        blocked.add(cell.id);
        continue;
      }
      const stale = notebookCellIsStale(engine, document, cell);
      const forceCell = input.force === true
        && (!selected || selected.has(cell.id));
      if (!forceCell && !stale) {
        if (cell.outputArtifactId) outputs[cell.id] = cell.outputArtifactId;
        continue;
      }
      const paidAuthorized = paidCellAuthorized(document, cell, input);
      if (notebookCellIsPaid(cell) && !paidAuthorized) {
        const message =
          `@${cell.slug}: paid execution requires a current persisted plan for this exact cell revision`;
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
          { confirmPaid: paidAuthorized, runId },
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
            { outputArtifactId: result.outputArtifactId },
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
        errors.push(`@${cell.slug}: ${message}`);
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
            { error: message },
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
  const activeCells = new Set(activeJobs.flatMap((job) => {
    const notebookId = typeof job.payload.notebookId === "string"
      ? job.payload.notebookId
      : null;
    const cellId = typeof job.payload.cellId === "string"
      ? job.payload.cellId
      : null;
    return notebookId && cellId ? [`${notebookId}:${cellId}`] : [];
  }));
  let enqueued = 0;
  for (const notebook of engine.notebooks.list()) {
    const execution = executionState(notebook);
    for (const [cellId, state] of Object.entries(execution)) {
      if (
        state.status !== "awaiting-output"
        || !state.providerArtifactId
        || !state.runId
        || activeCells.has(`${notebook.id}:${cellId}`)
      ) {
        continue;
      }
      const matchingFailed = failedJobs
        .filter((job) =>
          job.payload.notebookId === notebook.id
          && job.payload.cellId === cellId
          && job.payload.runId === state.runId)
        .sort((left, right) =>
          (right.operationId ?? "").localeCompare(left.operationId ?? ""));
      const latestFailed = matchingFailed[0];
      if (latestFailed) {
        const message = latestFailed.error?.message
          ?? `Notebook await ${latestFailed.state}`;
        await failAwaitingNotebookCell(
          engine,
          {
            type: "await_notebook_output",
            bookId,
            notebookId: notebook.id,
            cellId,
            providerArtifactId: state.providerArtifactId,
            runId: state.runId,
          },
          message,
        );
        continue;
      }
      const runPlan = notebookRunPlanRecords(notebook).find((record) =>
        record.runId === state.runId
        && (
          record.status === "queued"
          || record.status === "awaiting-output"
        ));
      const generationRecords = notebook.generationPlans ?? [];
      const generationRecord = generationRecords.find((candidate) =>
        candidate.cellId === cellId
        && (
          candidate.status === "queued"
          || candidate.status === "awaiting-output"
        ));
      const generationPlan = runPlan?.plan ?? generationRecord?.plan;
      await queue.enqueue(
        `reconcile-await-notebook-${state.runId}-${cellId}-${Date.now()}`,
        {
          type: "await_notebook_output",
          bookId,
          notebookId: notebook.id,
          cellId,
          providerArtifactId: state.providerArtifactId,
          runId: state.runId,
          ...(typeof runPlan?.planId === "string"
            ? { runPlanId: runPlan.planId }
            : {}),
          ...(generationPlan ? { generationPlan } : {}),
          cellIds: [cellId],
          actor: "notebook-reconciler",
        },
      );
      enqueued += 1;
    }
  }
  return enqueued;
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
