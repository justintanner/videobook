import { createHash } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import type {
  EditIntent,
  EditOperation,
  Engine,
  NotebookCell,
  NotebookDocument,
  NotebookRun,
} from "videobook-engine";
import { MVP_CONTRACT_VERSION } from "videobook-engine";
import { mutateNotebook } from "../notebook-mutations.js";
import { registerJobHandler } from "../queue.js";
import type { ToolDef, ToolResult } from "../tools/tool-def.js";
import { getActionSpec } from "../generation-registry.js";
import {
  captureFrame,
  exportSequenceMaster,
  extractSourceAudio,
  splitSourceRange,
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
  actor?: string;
  jobId?: string;
}

interface CellExecution {
  fingerprint: string;
  outputArtifactId?: string;
  completedAt?: string;
  tool?: string;
  error?: string;
}

function generationPlanStage(
  plan: Record<string, unknown>,
): Record<string, unknown> | null {
  const stages = Array.isArray(plan.stages) ? plan.stages : [];
  const stage = stages.find((candidate) =>
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
  const stage = generationPlanStage(plan);
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
      cell.id === cellId && outputArtifactId
        ? { ...cell, outputArtifactId }
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

function fingerprint(
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
    inputs: cell.inputs ?? {},
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
    .map(({ cell: source }) => source.prompt ?? "")
    .filter(Boolean);
  return [cell.prompt ?? "", ...upstream].filter(Boolean).join("\n\n").trim();
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
      && targetInput !== "first_frame"
      && targetInput !== "last_frame")
    .map(({ output }) => refFor(output!));
  if ("image_slugs" in definition.schema && imageReferences.length > 0) {
    args.image_slugs = imageReferences;
  }
  if ("image_slug" in definition.schema && imageReferences[0]) {
    args.image_slug = imageReferences[0];
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

async function failedArtifact(
  engine: Engine,
  cell: NotebookCell,
  message: string,
): Promise<string> {
  const result = await engine.artifacts.create({
    kind: cell.type === "video" ? "video" : "image",
    name: `${cell.title} failed`,
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

function orderedClipArtifactIds(
  clips: Array<{ timelineStartFrame: number; artifactId?: string; source?: { artifactId?: string } }>,
): string[] {
  return clips
    .slice()
    .sort((left, right) => left.timelineStartFrame - right.timelineStartFrame)
    .map((clip) => {
      if (typeof clip.artifactId === "string" && clip.artifactId) return clip.artifactId;
      return clip.source?.artifactId;
    })
    .filter((value): value is string => typeof value === "string");
}

function sameArtifactOrder(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

/**
 * Export is revision-pinned: the assembly revision must exist, and the primary
 * sequence at HEAD must still match the sequence as assembled (clip order).
 */
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
  const pinnedClips = orderedClipArtifactIds(atPin.value.clips);
  const headClips = orderedClipArtifactIds(primary.clips);

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
      .sort((left, right) => left.position.x - right.position.x)
      .map((candidate) => candidate.outputArtifactId!);
  }
  if (clips.length === 0) {
    throw new Error(`Sequence cell ${cell.id} has no clip inputs`);
  }

  const primary = engine.sequences.getPrimary();
  const videoTrack = primary.tracks.find((track) =>
    track.kind === "video" && track.ordinal === 0)
    ?? primary.tracks.find((track) => track.kind === "video");
  if (!videoTrack) {
    throw new Error("Primary sequence has no video track for assembly");
  }
  const fps = primary.frameRate.numerator / primary.frameRate.denominator;
  const operations: EditOperation[] = [];
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
        operations.push({
          kind: "insert-clip",
          mode: "insert",
          placement: {
            trackId: videoTrack.trackId,
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
          },
        });
        timelineStartFrame += durationFrames;
        continue;
      }
    }

    operations.push({
      kind: "insert-clip",
      mode: "insert",
      placement: {
        trackId: videoTrack.trackId,
        timelineStartFrame,
        durationFrames,
        source: {
          kind: "still",
          artifactId: clipId,
          sourcePath: file.name,
          objectHash: file.objectHash,
        },
      },
    });
    timelineStartFrame += durationFrames;
  }

  if (audioId) {
    const audioTrack = primary.tracks.find((track) => track.kind === "audio");
    const audioStreams = engine.streams.list(audioId);
    if (audioTrack && audioStreams.ok) {
      const audioStream = audioStreams.value.find((stream) => stream.kind === "audio");
      if (audioStream) {
        const seconds = audioStream.durationTicks
          * audioStream.timeBase.numerator
          / audioStream.timeBase.denominator;
        operations.push({
          kind: "insert-clip",
          mode: "insert",
          placement: {
            trackId: audioTrack.trackId,
            timelineStartFrame: 0,
            durationFrames: Math.max(1, Math.round(seconds * fps)),
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
          },
        });
      }
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
    const sourceId = firstUpstreamArtifact(document, cell, "source")
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
      range: typeof cell.inputs?.startSeconds === "number"
        && typeof cell.inputs?.endSeconds === "number"
        ? {
          startSeconds: Number(cell.inputs.startSeconds),
          endSeconds: Number(cell.inputs.endSeconds),
        }
        : undefined,
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
    const result = await exportSequenceMaster(
      engine,
      clipArtifactIds,
      audioArtifactId,
      cell.title,
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
    return { artifactId: output.artifactId, tool: output.tool };
  }

  throw new Error(`Cell type ${cell.type} is not runnable`);
}

export async function runNotebookCell(
  engine: Engine,
  bookId: string,
  notebookId: string,
  document: NotebookDocument,
  cell: NotebookCell,
  options: { confirmPaid?: boolean } = {},
): Promise<{ document: NotebookDocument; outputArtifactId: string }> {
  const nextFingerprint = fingerprint(document, cell);
  try {
    const output = await executeLocalOrGeneration(
      engine,
      bookId,
      document,
      cell,
      options,
    );
    const completedAt = new Date().toISOString();
    const state: CellExecution = {
      fingerprint: nextFingerprint,
      outputArtifactId: output.artifactId,
      completedAt,
      tool: output.tool,
    };
    const write = await mutateNotebook(
      engine,
      notebookId,
      "run_notebook_cell",
      (current) => {
        const base = output.document ?? current;
        const withOutput = withExecution(base, cell.id, state, output.artifactId);
        if (!output.cellInputs) return withOutput;
        return {
          ...withOutput,
          cells: withOutput.cells.map((candidate) =>
            candidate.id === cell.id
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
      { cellId: cell.id, outputArtifactId: output.artifactId, tool: output.tool },
    );
    if (!write.ok) throw new Error(write.error.message);
    const read = engine.notebooks.read(notebookId);
    if (!read.ok) throw new Error(read.error.message);
    return { document: read.value, outputArtifactId: output.artifactId };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const outputArtifactId = await failedArtifact(engine, cell, message);
    const state: CellExecution = {
      fingerprint: nextFingerprint,
      outputArtifactId,
      completedAt: new Date().toISOString(),
      tool: cell.tool
        || cell.model
        || defaultNotebookGenerationModel[cell.type as "image" | "video"],
      error: message,
    };
    const write = await mutateNotebook(
      engine,
      notebookId,
      "run_notebook_cell_failed",
      (current) => withExecution(current, cell.id, state, outputArtifactId),
      { cellId: cell.id, outputArtifactId, error: message },
    );
    if (!write.ok) throw new Error(write.error.message);
    throw new Error(message);
  }
}

function isCellStale(
  engine: Engine,
  document: NotebookDocument,
  cell: NotebookCell,
): boolean {
  const execution = executionState(document)[cell.id];
  if (!execution) return true;
  if (execution.fingerprint !== fingerprint(document, cell)) return true;
  if (execution.error) return true;
  if ((execution as CellExecution & { stale?: boolean }).stale) return true;
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

export function registerRunNotebookJob(engine: Engine): void {
  registerJobHandler("run_notebook", async (payload) => {
    const input = payload as unknown as RunNotebookPayload & {
      confirmPaid?: boolean;
    };
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
      const stale = isCellStale(engine, document, cell);
      if (!input.force && !stale) {
        if (cell.outputArtifactId) outputs[cell.id] = cell.outputArtifactId;
        continue;
      }
      try {
        const result = await runNotebookCell(
          engine,
          input.bookId,
          input.notebookId,
          document,
          cell,
          { confirmPaid: input.confirmPaid === true },
        );
        document = result.document;
        outputs[cell.id] = result.outputArtifactId;
        if (
          input.generationPlan
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
            "awaiting-output",
            { outputArtifactId: result.outputArtifactId },
          );
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        errors.push(`${cell.title}: ${message}`);
        blocked.add(cell.id);
        if (
          input.generationPlan
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
    const now = new Date().toISOString();
    const run: NotebookRun = {
      id: uuidv7(),
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
        planId: input.generationPlan?.planId,
        parentActionId: input.generationPlan?.parentActionId,
        jobId: input.jobId,
      },
    });
    if (errors.length > 0) throw new Error(errors.join("\n"));
    return run;
  });
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
