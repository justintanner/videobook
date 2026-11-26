import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import type { Engine, NotebookCell, NotebookDocument } from "videobook-engine";
import { findVideoFile, resolveNotebookCellArtifactId } from "videobook-engine";
import { normalizeNotebookReference } from "videobook-engine/notebook-mentions";
import { dubLabel } from "../artifact-label.js";
import { currentBookContext } from "../book-context.js";
import {
  DUB_VIDEO_MAX_DURATION_SECONDS,
  DUB_VIDEO_MAX_LANGUAGES,
  DUB_VIDEO_MODELS,
  dubGenerationOptions,
  dubLanguageCandidates,
  estimateDubCost,
  isDubVideoModel,
  resolveDubLanguages,
  type DubQuality,
} from "../dub-video.js";
import { referenceVideoDuration } from "../reference-video-duration.js";
import { generationInputPort, generationInputTarget } from "../generation-input-targets.js";
import { runNotebookCell } from "../jobs/run-notebook.js";
import { resolveModel } from "../media/descriptor.js";
import { mutateNotebook } from "../notebook-mutations.js";
import { resolveNotebookArtifactReference } from "../notebook-reference-resolver.js";
import { placeNewGenerator } from "../notebook-rounds-placement.js";
import { queue } from "../queue.js";
import { requireArtifactKind, toolError } from "./_shared.js";
import { enqueueMediaGeneration, validateMediaGeneration } from "./generate-media.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

type DubArgs = {
  book_id: string;
  asset_id: string;
  language: string | string[];
  quality?: DubQuality;
  lip_sync?: boolean;
  speakers?: number;
  dynamic_duration?: boolean;
  notebook_id?: string;
};

type DubEntry = {
  language: string;
  asset_id: string;
  job_id: string;
  cell_id?: string;
};

type DubNotebookTarget = {
  notebookId: string;
  sourceCellId: string;
  sourceCellLabel?: string;
};

function textResult(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function sameGenerationSettings(
  existing: NotebookCell,
  modelId: string,
  settings: Record<string, unknown>,
): boolean {
  if (
    existing.model !== modelId
    || existing.provider !== "fal"
    || existing.operation !== "edit_video"
    || existing.tool !== "generate_video"
  ) {
    return false;
  }
  const current = existing.inputs?.generationSettings;
  if (!current || typeof current !== "object" || Array.isArray(current)) return false;
  const record = current as Record<string, unknown>;
  const currentKeys = Object.keys(record).sort();
  const nextKeys = Object.keys(settings).sort();
  return currentKeys.length === nextKeys.length
    && currentKeys.every((key, index) => key === nextKeys[index] && record[key] === settings[key]);
}

function findExistingDubGenerator(
  document: NotebookDocument,
  sourceCellId: string,
  language: string,
): NotebookCell | undefined {
  return document.cells.find((cell) => {
    if (cell.type !== "generate_video" || !isDubVideoModel(cell.model)) return false;
    const settings = cell.inputs?.generationSettings;
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) return false;
    if ((settings as Record<string, unknown>).output_language !== language) return false;
    const videoEdges = document.edges.filter((edge) =>
      edge.target === cell.id && generationInputTarget("video", edge.targetInput) === "video");
    return videoEdges.length === 1 && videoEdges[0]!.source === sourceCellId;
  });
}

function findSourceCell(
  document: NotebookDocument,
  artifactId: string,
  preferredCellId: string | undefined,
): NotebookCell | null {
  if (preferredCellId) {
    const preferred = document.cells.find((cell) => cell.id === preferredCellId);
    if (preferred && preferred.outputArtifactId === artifactId) return preferred;
  }
  const direct = document.cells.find((cell) => cell.outputArtifactId === artifactId);
  if (direct) return direct;
  if (preferredCellId) {
    const preferred = document.cells.find((cell) =>
      cell.id === preferredCellId && resolveNotebookCellArtifactId(document, cell) === artifactId);
    if (preferred) return preferred;
  }
  return document.cells.find((cell) => resolveNotebookCellArtifactId(document, cell) === artifactId) ?? null;
}

function resolveDubNotebookTarget(
  engine: Engine,
  artifactId: string,
  explicitNotebookId: string | undefined,
  preferredCellId: string | undefined,
): DubNotebookTarget | null {
  if (explicitNotebookId) {
    const notebook = engine.notebooks.read(explicitNotebookId);
    if (!notebook.ok) return null;
    const sourceCell = findSourceCell(notebook.value, artifactId, preferredCellId);
    return sourceCell
      ? {
          notebookId: notebook.value.id,
          sourceCellId: sourceCell.id,
          ...(sourceCell.label ? { sourceCellLabel: sourceCell.label } : {}),
        }
      : null;
  }
  const matching = engine.notebooks.list().flatMap((document) => {
    const sourceCell = findSourceCell(document, artifactId, preferredCellId);
    return sourceCell ? [{ document, sourceCell }] : [];
  });
  if (matching.length !== 1) return null;
  const sole = matching[0]!;
  return {
    notebookId: sole.document.id,
    sourceCellId: sole.sourceCell.id,
    ...(sole.sourceCell.label ? { sourceCellLabel: sole.sourceCell.label } : {}),
  };
}

async function upsertDubGeneratorCell(
  engine: Engine,
  input: {
    notebookId: string;
    sourceCellId: string;
    language: string;
    modelId: string;
    label: string;
    generationSettings: Record<string, unknown>;
  },
): Promise<{ document: NotebookDocument; cell: NotebookCell }> {
  let targetCellId: string | null = null;
  const updated = await mutateNotebook(
    engine,
    input.notebookId,
    "upsert_dub_generator_cell",
    (notebook) => {
      const existing = findExistingDubGenerator(notebook, input.sourceCellId, input.language);
      if (existing) {
        targetCellId = existing.id;
        if (sameGenerationSettings(existing, input.modelId, input.generationSettings)) {
          return notebook;
        }
        return {
          ...notebook,
          cells: notebook.cells.map((cell) => cell.id === existing.id
            ? {
                ...cell,
                provider: "fal",
                model: input.modelId,
                operation: "edit_video",
                tool: "generate_video",
                inputs: {
                  ...(cell.inputs ?? {}),
                  generationSettings: input.generationSettings,
                },
              }
            : cell),
        };
      }
      const created = engine.notebooks.createCell({
        type: "generate_video",
        label: input.label,
        slot: placeNewGenerator(notebook, [input.sourceCellId]),
        provider: "fal",
        model: input.modelId,
        operation: "edit_video",
        tool: "generate_video",
        inputs: {
          generationSettings: input.generationSettings,
        },
      });
      const edge = engine.notebooks.createEdge({
        source: input.sourceCellId,
        target: created.id,
        targetInput: generationInputPort("video", 1),
      });
      targetCellId = created.id;
      return {
        ...notebook,
        cells: [...notebook.cells, created],
        edges: [...notebook.edges, edge],
      };
    },
    { sourceCellId: input.sourceCellId, language: input.language, modelId: input.modelId },
  );
  if (!updated.ok) throw new Error(updated.error.message);
  const refreshed = engine.notebooks.read(input.notebookId);
  if (!refreshed.ok) throw new Error(refreshed.error.message);
  const cell = refreshed.value.cells.find((candidate) => candidate.id === targetCellId);
  if (!cell) throw new Error(`Dub generator cell not found: ${String(targetCellId)}`);
  return { document: refreshed.value, cell };
}

async function runNotebookDub(
  engine: Engine,
  input: {
    bookId: string;
    target: DubNotebookTarget;
    sourceArtifactId: string;
    sourceLabel: string | undefined;
    language: string;
    quality: DubQuality;
    lipSync: boolean;
    modelId: string;
    options: Record<string, unknown>;
  },
): Promise<DubEntry> {
  const label = dubLabel(input.sourceLabel, input.language);
  const dubMeta = {
    source_artifact_id: input.sourceArtifactId,
    language: input.language,
    quality: input.quality,
    lip_sync: input.lipSync,
  };
  const { document, cell } = await upsertDubGeneratorCell(engine, {
    notebookId: input.target.notebookId,
    sourceCellId: input.target.sourceCellId,
    language: input.language,
    modelId: input.modelId,
    label,
    generationSettings: input.options,
  });
  const runId = uuidv7();
  const ran = await runNotebookCell(
    engine,
    input.bookId,
    input.target.notebookId,
    document,
    cell,
    {
      confirmPaid: true,
      runId,
      artifactLabel: label,
      artifactMetadata: { dub: dubMeta },
    },
  );
  if (ran.status === "awaiting-output") {
    await queue.enqueue(
      `await-notebook-${runId}-${cell.id}-${ran.outputArtifactId}`,
      {
        type: "await_notebook_output",
        bookId: input.bookId,
        notebookId: input.target.notebookId,
        cellId: cell.id,
        providerArtifactId: ran.outputArtifactId,
        runId,
        ...(ran.outputCellId ? { outputCellId: ran.outputCellId } : {}),
        cellIds: [cell.id],
        actor: "dub_video",
      },
    );
  }
  return {
    language: input.language,
    asset_id: ran.outputArtifactId,
    job_id: ran.jobId ?? `run-notebook-${input.target.notebookId}-${cell.id}-${runId}`,
    ...(ran.outputCellId ? { cell_id: ran.outputCellId } : {}),
  };
}

export function dubVideoDef(engine: Engine): ToolDef {
  return {
    name: "dub_video",
    description:
      "Dub a book video into 1-5 target languages with HeyGen Translate (fal). Each language creates a new dubbed video artifact with automatic transcription enabled; the source video is untouched.",
    schema: {
      book_id: z.string().describe("Book id"),
      asset_id: z.string().describe("Video artifact id (with or without a leading @) or notebook grid address such as @a1"),
      language: z.union([
        z.string().min(1),
        z.array(z.string().min(1)).min(1).max(DUB_VIDEO_MAX_LANGUAGES),
      ]).describe("Target language or array of 1-5 target languages (HeyGen Translate output_language names; comma/and-separated strings also work)"),
      quality: z.enum(["speed", "precision"]).optional().describe("HeyGen Translate tier: 'speed' ($0.05/s, default) or 'precision' ($0.10/s, better lip sync)"),
      lip_sync: z.boolean().optional().describe("Re-sync the speaker's lips to the translated speech (default true; false translates audio only)"),
      speakers: z.number().int().min(1).max(10).optional().describe("Optional number of speakers (1-10) sent as speaker_num"),
      dynamic_duration: z.boolean().optional().describe("Let HeyGen change the dubbed video's length to fit the translated speech (enable_dynamic_duration); default false keeps the source duration"),
      notebook_id: z.string().uuid().optional().describe("Optional notebook UUID; defaults to the active or sole notebook containing the source video"),
    },
    handler: async (rawArgs) => {
      if (!process.env.FAL_API_KEY?.trim()) {
        return toolError("FAL_API_KEY environment variable is not set");
      }
      const args = rawArgs as DubArgs;
      const quality: DubQuality = args.quality ?? "speed";
      const lipSync = args.lip_sync ?? true;
      const model = resolveModel(DUB_VIDEO_MODELS[quality]);

      const resolvedLanguages = resolveDubLanguages(args.language, dubLanguageCandidates(quality));
      if (!resolvedLanguages.ok) return toolError(resolvedLanguages.error);

      const explicitNotebookId = args.notebook_id ?? currentBookContext()?.notebookId;
      let candidateNotebooks: NotebookDocument[];
      if (explicitNotebookId) {
        const read = engine.notebooks.read(explicitNotebookId);
        if (!read.ok) return toolError(read.error.message);
        candidateNotebooks = [read.value];
      } else {
        candidateNotebooks = engine.notebooks.list();
      }
      const normalizedRef = normalizeNotebookReference(args.asset_id);
      if (!normalizedRef) return toolError("asset_id is required");
      const refResult = resolveNotebookArtifactReference({
        engine,
        documents: candidateNotebooks,
        reference: normalizedRef,
      });
      if ("code" in refResult) {
        if (refResult.code === "ambiguous") {
          return toolError(`Video source @${normalizedRef} is ambiguous; include notebook_id`);
        }
        if (refResult.code === "no_output" || refResult.code === "not_media") {
          return toolError(`Video source @${normalizedRef} has no media output yet`);
        }
        return toolError(`Video source @${normalizedRef} was not found`);
      }

      const artifactId = refResult.artifactId;
      const kindGate = await requireArtifactKind(engine, artifactId, ["video"], "dub_video");
      if (kindGate) return kindGate;

      const manifestResult = await engine.files.manifest(artifactId);
      if (!manifestResult.ok) return toolError(manifestResult.error.message);
      const videoFile = manifestResult.value.files.find((file) => file.name.toLowerCase() === "original.mp4")
        ?? findVideoFile(manifestResult.value.files);
      if (!videoFile) return toolError(`No video file found in asset ${artifactId}`);

      const durationSeconds = await referenceVideoDuration(engine, [artifactId], { probeMissing: true });
      if (durationSeconds === undefined) {
        return toolError(`Could not determine duration of video asset ${artifactId}`);
      }
      if (durationSeconds > DUB_VIDEO_MAX_DURATION_SECONDS) {
        return toolError(
          `Video ${artifactId} is ${Math.round(durationSeconds * 10) / 10}s long, which exceeds HeyGen Translate's ${DUB_VIDEO_MAX_DURATION_SECONDS}s (8-minute) limit. Use trim_video to shorten it first.`,
        );
      }

      const languagePlans = resolvedLanguages.languages.map((language) => ({
        language,
        options: dubGenerationOptions({
          language,
          lipSync,
          speakers: args.speakers,
          dynamicDuration: args.dynamic_duration,
        }),
      }));

      for (const plan of languagePlans) {
        const invalid = await validateMediaGeneration(
          engine,
          model,
          { book_id: args.book_id, operation: "edit_video", options: plan.options },
          { video: [artifactId] },
        );
        if (invalid) return toolError(invalid);
      }

      const estimate = estimateDubCost({
        durationSeconds,
        languageCount: languagePlans.length,
        quality,
        dynamicDuration: args.dynamic_duration,
      });
      const sourceArtifact = engine.artifacts.get(artifactId);
      const target = resolveDubNotebookTarget(engine, artifactId, explicitNotebookId, refResult.cellId);
      const sourceLabel = (sourceArtifact.ok ? sourceArtifact.value.label : undefined) ?? target?.sourceCellLabel;

      const dubs: DubEntry[] = [];
      try {
        for (const plan of languagePlans) {
          if (target) {
            dubs.push(await runNotebookDub(engine, {
              bookId: args.book_id,
              target,
              sourceArtifactId: artifactId,
              sourceLabel,
              language: plan.language,
              quality,
              lipSync,
              modelId: model.id,
              options: plan.options,
            }));
          } else {
            const label = dubLabel(sourceLabel, plan.language);
            const enqueued = await enqueueMediaGeneration(
              engine,
              model,
              { book_id: args.book_id, operation: "edit_video", options: plan.options },
              { video: [artifactId] },
              {
                label,
                metadata: {
                  dub: {
                    source_artifact_id: artifactId,
                    language: plan.language,
                    quality,
                    lip_sync: lipSync,
                  },
                },
              },
            );
            if (!enqueued.ok) return toolError(enqueued.error);
            dubs.push({
              language: plan.language,
              asset_id: enqueued.assetId,
              job_id: enqueued.jobId,
            });
          }
        }
      } catch (cause) {
        return toolError(cause instanceof Error ? cause.message : String(cause));
      }

      return textResult({
        dubs,
        status: "enqueued",
        estimated_usd: estimate.usd,
      });
    },
  };
}
