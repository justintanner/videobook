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
  NotebookRun,
  Sequence,
} from "videobook-engine";
import { MVP_CONTRACT_VERSION } from "videobook-engine";
import { mutateNotebook } from "../notebook-mutations.js";
import { queue, registerJobHandler } from "../queue.js";
import type { ToolDef, ToolResult } from "../tools/tool-def.js";
import { getActionSpec } from "../generation-registry.js";
import {
  captureFrame,
  exportSequenceMaster,
  extractSourceAudio,
  normalizeSceneVideo,
  splitSourceRange,
  type BurnInCaption,
} from "../notebook-media-ops.js";
import { applyAnalysisResults } from "../notebook-workflow.js";
import { DEFAULT_ANIMATION_TOOL } from "../notebook-action-catalog.js";

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
      const raw = notebook.properties?.generationPlans;
      const plans = Array.isArray(raw) ? raw : [];
      return {
        ...notebook,
        properties: {
          ...(notebook.properties ?? {}),
          generationPlans: plans.map((entry) => {
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
              return entry;
            }
            const record = entry as Record<string, unknown>;
            return record.planId === planId
              ? {
                  ...record,
                  status,
                  updatedAt,
                  ...(details.outputArtifactId
                    ? { outputArtifactId: details.outputArtifactId }
                    : {}),
                  ...(details.error ? { error: details.error } : {}),
                }
              : entry;
          }),
        },
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

export const defaultNotebookGenerationModel: Record<"image" | "video", string> = {
  image: "generate_kie_gpt_image_2_text_to_image",
  video: DEFAULT_ANIMATION_TOOL,
};

const LOCAL_RUNNABLE_TYPES = new Set([
  "source",
  "analysis",
  "split",
  "audio",
  "frame",
  "prompt",
  "sequence",
  "export",
  "image",
  "video",
]);

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

function executionState(document: NotebookDocument): Record<string, CellExecution> {
  const raw = document.properties?.execution;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  return raw as Record<string, CellExecution>;
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
    properties: { ...(document.properties ?? {}), execution },
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
        output: source.outputArtifactId ?? source.entityId,
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
    title: cell.title,
    prompt: cell.prompt ?? "",
    provider: cell.provider ?? "",
    model: cell.model ?? defaultNotebookGenerationModel[cell.type as "image" | "video"] ?? "",
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
    title: cell.title,
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
      title: source.title,
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

async function objectHashForArtifact(
  engine: Engine,
  artifactId: string,
): Promise<string | null> {
  const manifest = await engine.files.manifest(artifactId);
  if (!manifest.ok) return null;
  return manifest.value.files[0]?.objectHash ?? null;
}

function promptFor(document: NotebookDocument, cell: NotebookCell): string {
  const upstream = upstreamValues(document, cell)
    .filter(({ cell: source }) => source.type === "prompt")
    .map(({ cell: source }) =>
      typeof source.inputs?.resolvedPrompt === "string"
        ? source.inputs.resolvedPrompt
        : source.prompt ?? "")
    .filter(Boolean);
  const own = cell.type === "prompt"
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
  return source.type === "image" || source.type === "frame";
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
  if (cell.type === "prompt" && "model" in definition.schema) {
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

  const imageReferences = upstream
    .filter(({ cell: source, output, targetInput }) =>
      typeof output === "string"
      && isImageLikeCell(source)
      && (
        (
          targetInput !== "first_frame"
          && targetInput !== "last_frame"
        )
        || !("first_frame_slug" in definition.schema)
      ))
    .map(({ output }) => refFor(output!));
  if ("image_slugs" in definition.schema && imageReferences.length > 0) {
    args.image_slugs = imageReferences;
  }
  if ("image_slug" in definition.schema && imageReferences[0]) {
    args.image_slug = imageReferences[0];
  }
  const videoReferences = upstream
    .filter(({ cell: source, output, targetInput }) =>
      typeof output === "string"
      && (
        targetInput === "reference_video"
        || targetInput === "video"
        || (
          targetInput === "segment"
          && (source.type === "video" || source.type === "split")
        )
      ))
    .map(({ output }) => refFor(output!));
  if ("video_slugs" in definition.schema && videoReferences.length > 0) {
    args.video_slugs = videoReferences;
  }
  if ("video_slug" in definition.schema && videoReferences[0]) {
    args.video_slug = videoReferences[0];
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
      && source.type === "audio"
      && (
        targetInput === "reference_audio"
        || targetInput === "audio"
        || targetInput === "scene_audio"
      ))
    .map(({ output }) => refFor(output!));
  if (
    "audio_slugs" in definition.schema
    && audioReferences.length > 0
    && !firstFrame?.output
    && !lastFrame?.output
  ) {
    args.audio_slugs = audioReferences;
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
  return defaultNotebookGenerationModel[cell.type as "image" | "video"] ?? null;
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
  const { getAllToolDefs } = await import("../tools/index.js");
  const definition = getAllToolDefs(engine).find((candidate) => candidate.name === tool);
  if (!definition) throw new Error(`Unknown notebook generation model: ${tool}`);
  const parsed = z.object(definition.schema).safeParse(
    modelArgs(definition, document, cell, bookId, engine),
  );
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  const spec = getActionSpec(tool);
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
    throw new Error(`Prompt cell ${cell.id} must use rewrite_prompt`);
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
    name: `script ${cell.title} resolved prompt`,
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
  const kind = cell.type === "video"
    ? "video"
    : cell.type === "image" || cell.type === "frame"
      ? "image"
      : "script";
  const result = await engine.artifacts.create({
    kind,
    name: kind === "script"
      ? `script ${cell.title} failed`
      : `${cell.title} failed`,
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

function orderedVideoClipArtifactIds(
  sequence: Sequence,
): string[] {
  const videoTracks = new Set(
    sequence.tracks
      .filter((track) => track.kind === "video")
      .map((track) => track.trackId),
  );
  return sequence.clips
    .filter((clip) => videoTracks.has(clip.trackId))
    .slice()
    .sort((left, right) => left.timelineStartFrame - right.timelineStartFrame)
    .map((clip) => clip.source.artifactId)
    .filter((value): value is string => typeof value === "string");
}

function sameArtifactOrder(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

export function assertSequenceMatchesAssembly(
  engine: Engine,
  clipArtifactIds: string[],
  pinnedRevision: string,
  sequenceId: string,
): void {
  if (!pinnedRevision.trim()) {
    throw new Error("Sequence has not been assembled; run assembly before export");
  }
  if (clipArtifactIds.length === 0) {
    throw new Error("Export has no assembled clips on the sequence");
  }

  const atPin = engine.sequences.getAtRevision(sequenceId, pinnedRevision);
  if (!atPin.ok) {
    throw new Error(
      `Sequence revision is stale; pinned revision is not readable: ${pinnedRevision}`,
    );
  }

  const primary = engine.sequences.getPrimary();
  const pinnedClips = orderedVideoClipArtifactIds(atPin.value);
  const headClips = orderedVideoClipArtifactIds(primary);

  if (!sameArtifactOrder(pinnedClips, clipArtifactIds)) {
    throw new Error(
      "Sequence revision is stale; assembly pin does not match recorded clip order",
    );
  }
  if (!sameArtifactOrder(headClips, clipArtifactIds)) {
    throw new Error(
      "Sequence revision is stale; primary sequence changed after assembly",
    );
  }
  if (!sameArtifactOrder(pinnedClips, headClips)) {
    throw new Error(
      "Sequence revision is stale; sequence at HEAD diverged from the assembly revision",
    );
  }
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
  let clips = upstreamValues(document, cell)
    .filter((entry) =>
      entry.targetInput.startsWith("clip")
      || entry.cell.type === "video"
      || entry.targetInput === "segment")
    .map((entry) => entry.output)
    .filter((value): value is string => typeof value === "string");
  const audioId = firstUpstreamArtifact(document, cell, "audio")
    ?? firstUpstreamArtifact(document, cell, "source-audio");
  if (clips.length === 0) {
    clips = document.cells
      .filter((candidate) => candidate.type === "video" && candidate.outputArtifactId)
      .sort((left, right) =>
        left.slot.row - right.slot.row
        || left.slot.column - right.slot.column)
      .map((candidate) => candidate.outputArtifactId!);
  }
  if (clips.length === 0) {
    throw new Error(`Sequence cell ${cell.id} has no clip inputs`);
  }

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
    name: `${cell.title} assembly`,
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
  if (cell.type === "split") {
    const sourceId = firstUpstreamArtifact(document, cell, "source")
      ?? firstUpstreamArtifact(document, cell)
      ?? (typeof cell.inputs?.sourceArtifactId === "string"
        ? cell.inputs.sourceArtifactId
        : null);
    if (!sourceId) throw new Error(`Split cell ${cell.id} has no source artifact`);
    const startSeconds = Number(cell.inputs?.startSeconds ?? 0);
    const endSeconds = Number(cell.inputs?.endSeconds ?? 0);
    const result = await splitSourceRange(
      engine,
      sourceId,
      { startSeconds, endSeconds },
      cell.title,
    );
    return { artifactId: result.artifactId, tool: "ffmpeg" };
  }

  if (cell.type === "audio") {
    const sourceId = firstUpstreamArtifact(document, cell, "segment")
      ?? firstUpstreamArtifact(document, cell, "source")
      ?? firstUpstreamArtifact(document, cell)
      ?? (typeof cell.inputs?.artifactId === "string" ? cell.inputs.artifactId : null);
    if (!sourceId) throw new Error(`Audio cell ${cell.id} has no source artifact`);
    const result = await extractSourceAudio(engine, sourceId, cell.title);
    return { artifactId: result.artifactId, tool: "ffmpeg" };
  }

  if (cell.type === "frame") {
    const segmentId = firstUpstreamArtifact(document, cell, "segment")
      ?? firstUpstreamArtifact(document, cell);
    if (!segmentId) throw new Error(`Frame cell ${cell.id} has no segment artifact`);
    const role = cell.inputs?.frameRole === "last" ? "last" : "first";
    const result = await captureFrame(engine, segmentId, {
      role,
      title: cell.title,
    });
    return { artifactId: result.artifactId, tool: "ffmpeg" };
  }

  if (cell.type === "source") {
    const artifactId = cell.outputArtifactId
      ?? firstUpstreamArtifact(document, cell);
    if (!artifactId) throw new Error(`Source cell ${cell.id} has no media artifact`);
    const hash = await objectHashForArtifact(engine, artifactId);
    if (!hash) throw new Error(`Source cell ${cell.id} has no material files`);
    return { artifactId, tool: "ffmpeg" };
  }

  if (cell.type === "analysis") {
    const sourceId = firstUpstreamArtifact(document, cell, "source")
      ?? firstUpstreamArtifact(document, cell);
    if (!sourceId) throw new Error(`Analysis cell ${cell.id} has no source artifact`);
    const fixture = cell.inputs?.fixtureAnalysis
      ?? cell.inputs?.analysisFixture
      ?? null;
    if (!fixture) {
      if (!process.env.KIE_API_KEY) {
        throw new Error(
          "Analysis requires KIE_API_KEY or a fixtureAnalysis input for offline runs",
        );
      }
      throw new Error(
        "Live KIE analysis is key-gated; provide fixtureAnalysis for offline DAG runs",
      );
    }
    const duration = Number(
      cell.inputs?.sourceDurationSeconds
        ?? (fixture as { sourceDurationSeconds?: number }).sourceDurationSeconds
        ?? 60,
    );
    const next = await applyAnalysisResults(engine, document, cell.id, {
      rawOutput: fixture,
      sourceDurationSeconds: duration,
      request: {
        provider: cell.provider ?? "kie",
        model: cell.model ?? "gemini-3.5-flash",
        prompt: cell.prompt ?? "",
        mode: "fixture",
      },
      sourceArtifactId: sourceId,
    });
    const analysis = next.cells.find((candidate) => candidate.id === cell.id);
    if (!analysis?.outputArtifactId) {
      throw new Error("Analysis did not produce a script artifact");
    }
    return {
      artifactId: analysis.outputArtifactId,
      tool: cell.tool ?? "kie_gemini_analysis",
      document: next,
    };
  }

  if (cell.type === "sequence") {
    const assembled = await assembleCanonicalSequence(
      engine,
      document,
      cell,
    );
    return {
      artifactId: assembled.scriptArtifactId,
      tool: "engine_sequence",
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

  if (cell.type === "export") {
    const sequenceCell = upstreamValues(document, cell)
      .find((entry) => entry.cell.type === "sequence")
      ?.cell
      ?? document.cells.find((candidate) => candidate.type === "sequence");
    if (!sequenceCell) {
      throw new Error(`Export cell ${cell.id} has no sequence upstream`);
    }
    const pinnedRevision = typeof sequenceCell.inputs?.sequenceRevision === "string"
      ? sequenceCell.inputs.sequenceRevision
      : null;
    if (!pinnedRevision) {
      throw new Error("Sequence has not been assembled; run assembly before export");
    }
    const sequenceId = typeof sequenceCell.inputs?.sequenceId === "string"
      ? sequenceCell.inputs.sequenceId
      : engine.sequences.getPrimary().sequenceId;
    const clipArtifactIds = Array.isArray(sequenceCell.inputs?.clipArtifactIds)
      ? sequenceCell.inputs.clipArtifactIds.filter((value): value is string =>
        typeof value === "string")
      : [];
    const audioArtifactId = typeof sequenceCell.inputs?.audioArtifactId === "string"
      ? sequenceCell.inputs.audioArtifactId
      : null;
    if (clipArtifactIds.length === 0) {
      throw new Error(`Export cell ${cell.id} has no assembled clips on the sequence`);
    }
    assertSequenceMatchesAssembly(
      engine,
      clipArtifactIds,
      pinnedRevision,
      sequenceId,
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
      clipArtifactIds,
      audioArtifactId,
      cell.title,
      { captions },
    );
    return {
      artifactId: result.artifactId,
      tool: "ffmpeg",
      cellInputs: {
        sequenceRevision: pinnedRevision,
        sequenceId,
        state: "completed",
      },
    };
  }

  if (cell.type === "prompt") {
    if (!options.confirmPaid) {
      throw new Error(
        `Paid prompt rewrite for ${cell.title} requires confirmation before starting`,
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

  if (cell.type === "image" || cell.type === "video") {
    const requiresConfirmation = cell.inputs?.requiresConfirmation === true
      || (cell.tool ?? cell.model ?? "").includes("seedance")
      || (cell.tool ?? cell.model ?? defaultNotebookGenerationModel.video)
        === DEFAULT_ANIMATION_TOOL;
    if (requiresConfirmation && !options.confirmPaid) {
      throw new Error(
        `Paid generation for ${cell.title} requires confirmation before starting`,
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

  throw new Error(`Cell type ${cell.type} is not runnable`);
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
  const nextFingerprint = notebookCellFingerprint(document, cell);
  const startedAt = new Date().toISOString();
  const runningState: CellExecution = {
    fingerprint: nextFingerprint,
    status: "running",
    ...(cell.outputArtifactId
      ? { outputArtifactId: cell.outputArtifactId }
      : {}),
    ...(options.runId ? { runId: options.runId } : {}),
    startedAt,
    updatedAt: startedAt,
    tool: cell.tool
      || cell.model
      || defaultNotebookGenerationModel[cell.type as "image" | "video"],
  };
  const started = await mutateNotebook(
    engine,
    notebookId,
    "start_notebook_cell",
    (current) => withExecution(current, cell.id, runningState),
    { cellId: cell.id, runId: options.runId },
  );
  if (!started.ok) throw new Error(started.error.message);
  const activeDocument = withExecution(document, cell.id, runningState);
  const activeCell = activeDocument.cells.find((candidate) =>
    candidate.id === cell.id);
  if (!activeCell) throw new Error(`Notebook cell not found: ${cell.id}`);
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
        || defaultNotebookGenerationModel[activeCell.type as "image" | "video"],
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
): Array<Record<string, unknown>> {
  const raw = document.properties?.notebookRunPlans;
  return Array.isArray(raw)
    ? raw.filter((entry): entry is Record<string, unknown> =>
      Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
    : [];
}

export async function updateNotebookRunPlanState(
  engine: Engine,
  notebookId: string,
  planId: string,
  status: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  const result = await mutateNotebook(
    engine,
    notebookId,
    "update_notebook_run_plan",
    (document) => ({
      ...document,
      properties: {
        ...(document.properties ?? {}),
        notebookRunPlans: notebookRunPlanRecords(document).map((record) =>
          record.planId === planId
            ? {
                ...record,
                status,
                ...details,
                updatedAt: new Date().toISOString(),
              }
            : record),
      },
    }),
    { planId, status, ...details },
  );
  if (!result.ok) throw new Error(result.error.message);
}

function paidCell(cell: NotebookCell): boolean {
  return cell.type === "prompt"
    || cell.type === "image"
    || cell.type === "video";
}

function paidCellAuthorized(
  document: NotebookDocument,
  cell: NotebookCell,
  input: RunNotebookPayload,
): boolean {
  if (!paidCell(cell)) return true;
  const expectedFingerprint = notebookCellDefinitionFingerprint(document, cell);
  if (input.runPlanId) {
    const record = notebookRunPlanRecords(document).find((candidate) =>
      candidate.planId === input.runPlanId);
    const fingerprints = record?.cellDefinitionFingerprints;
    return Boolean(
      record
      && (record.status === "queued" || record.status === "awaiting-output")
      && fingerprints
      && typeof fingerprints === "object"
      && !Array.isArray(fingerprints)
      && (fingerprints as Record<string, unknown>)[cell.id]
        === expectedFingerprint,
    );
  }
  const planId = input.generationPlan?.planId;
  if (typeof planId !== "string") return false;
  const records = Array.isArray(document.properties?.generationPlans)
    ? document.properties.generationPlans
    : [];
  const record = records.find((candidate) =>
    candidate
    && typeof candidate === "object"
    && !Array.isArray(candidate)
    && (candidate as Record<string, unknown>).planId === planId
    && (candidate as Record<string, unknown>).cellId === cell.id) as
      | Record<string, unknown>
      | undefined;
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
  if (cell.type === "video") {
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
        `${cell.title} normalized`,
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
    await awaitNotebookOutput(
      engine,
      payload as unknown as AwaitNotebookOutputPayload,
    );
    return { status: "completed" };
  });
  registerJobHandler("run_notebook", async (payload) => {
    const input = payload as unknown as RunNotebookPayload;
    const runId = input.runId ?? uuidv7();
    const initial = engine.notebooks.read(input.notebookId);
    if (!initial.ok) throw new Error(initial.error.message);
    const selected = input.cellIds ? new Set(input.cellIds) : null;
    const required = new Set<string>();
    if (selected) {
      for (const cellId of selected) {
        required.add(cellId);
        for (const ancestor of ancestorsOf(initial.value, cellId)) {
          required.add(ancestor);
        }
      }
    }
    let document = initial.value;
    const ordered = topologicalOrder(document);
    const outputs: Record<string, string> = {};
    const errors: string[] = [];
    const blocked = new Set<string>();
    const waiting = new Set<string>();
    for (const cell of ordered) {
      if (!LOCAL_RUNNABLE_TYPES.has(cell.type)) {
        const output = cell.outputArtifactId ?? cell.entityId;
        if (output) outputs[cell.id] = output;
        continue;
      }
      if (selected && !required.has(cell.id)) continue;
      const upstreamBlocked = document.edges
        .filter((edge) => edge.target === cell.id)
        .some((edge) => blocked.has(edge.source));
      if (upstreamBlocked) {
        blocked.add(cell.id);
        errors.push(`${cell.title}: blocked by failed upstream dependency`);
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
        errors.push(`${cell.title}: ${message}`);
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
      if (paidCell(cell) && !paidAuthorized) {
        const message =
          `${cell.title}: paid execution requires a current persisted plan for this exact cell revision`;
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
        errors.push(`${cell.title}: ${message}`);
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
          { runId, outputs },
        );
      }
      await engine.history.recordAction({
        operation: "run_notebook",
        scope: "book",
        phase: "started",
        actor: "human",
        lane: "notebook",
        writeSet: [`notebook:${input.notebookId}`],
        details: {
          notebookId: input.notebookId,
          runId,
          cellIds: input.cellIds ?? [],
          outputs,
          waitingCellIds: [...waiting],
          errors,
          planId: input.runPlanId ?? input.generationPlan?.planId,
          jobId: input.jobId,
        },
      });
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
    await engine.history.recordAction({
      operation: "run_notebook",
      scope: "book",
      phase: errors.length === 0 ? "completed" : "failed",
      actor: "human",
      lane: "notebook",
      writeSet: [`notebook:${input.notebookId}`],
      details: {
        notebookId: input.notebookId,
        cellIds: input.cellIds ?? [],
        outputs,
        errors,
        planId: input.runPlanId ?? input.generationPlan?.planId,
        parentActionId: input.generationPlan?.parentActionId,
        jobId: input.jobId,
      },
    });
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
      const runPlan = notebookRunPlanRecords(notebook).find((record) =>
        record.runId === state.runId
        && (
          record.status === "queued"
          || record.status === "awaiting-output"
        ));
      const generationRecords = Array.isArray(
        notebook.properties?.generationPlans,
      )
        ? notebook.properties.generationPlans
        : [];
      const generationRecord = generationRecords.find((candidate) =>
        candidate
        && typeof candidate === "object"
        && !Array.isArray(candidate)
        && (candidate as Record<string, unknown>).cellId === cellId
        && (
          (candidate as Record<string, unknown>).status === "queued"
          || (candidate as Record<string, unknown>).status
            === "awaiting-output"
        )) as Record<string, unknown> | undefined;
      const generationPlan = runPlan?.plan
        && typeof runPlan.plan === "object"
        && !Array.isArray(runPlan.plan)
        ? runPlan.plan as Record<string, unknown>
        : generationRecord?.plan
          && typeof generationRecord.plan === "object"
          && !Array.isArray(generationRecord.plan)
          ? generationRecord.plan as Record<string, unknown>
          : undefined;
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
