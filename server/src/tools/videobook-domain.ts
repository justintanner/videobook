import type {
  Engine,
  EntityDocument,
  EntityType,
  NotebookCell,
  NotebookCellReference,
  NotebookCellType,
  NotebookDocument,
  NotebookGridSlot,
  PinnedSearchResult,
} from "videobook-engine";
import {
  nextHorizontalSlotFrom,
  NOTEBOOK_CELL_TYPES,
  notebookGridTag,
} from "videobook-engine";
import { slotRight } from "../notebook-placement.js";
import { z } from "zod";
import { v7 as uuidv7 } from "uuid";
import type { BookManager } from "../book-manager.js";
import {
  ensureGenerateAudioOutput,
  normalizeLegacyExtractCells,
} from "../notebook-cell-outputs.js";
import { mutateNotebook } from "../notebook-mutations.js";
import { queue, stopBookQueue } from "../queue.js";
import {
  claimNotebookGenerationPlan,
  failQueuedNotebookCells,
  generationPlanClaimOutputCellId,
  notebookCellDefinitionFingerprint,
  notebookCellIsPaid,
  notebookCellIsRunnable,
  notebookCellMediaType,
  markNotebookCellQueued,
  prepareNotebookGeneration,
} from "../jobs/run-notebook.js";
import {
  buildGenerationInsertPlan,
  continueQueuedInsert,
} from "./command-plan.js";
import {
  assessToolCallEstimate,
  logUnavailableCostEstimate,
} from "../jobs/cost-estimate-assessment.js";
import { estimateCostDef } from "./estimate-cost.js";
import { pairForCell } from "./list-cell-generations.js";
import type { ToolDef, ToolResult } from "./tool-def.js";
import {
  listNotebookActions,
  markDescendantsStale,
  normalizeCellActionFields,
  normalizeLegacyAnalyzeDocument,
  selectedCellDetails,
  validateCellConfiguration,
} from "../notebook-action-catalog.js";
import { notebookGenerationInputContract } from "../notebook-generation-contract.js";
import { notebookGenerationControls } from "../notebook-generation-controls.js";
import { hydrateNotebookProviderFailures } from "../notebook-provider-failure.js";
import { buildSevenStageScaffold } from "../notebook-workflow.js";
import { translateToolPayload } from "../payload-builders.js";
import { applyPreviewPlaceholderUrls } from "../preview-payload.js";
import {
  enqueueNotebookRunPlan,
  notebookRunPlanRecords,
  planNotebookRun,
  planSelectedNotebookSubgraph,
} from "../notebook-run-plan.js";
import {
  reconcileInitialGenerationPrompt,
  refreshInitialGenerationPrompts,
  seedInitialGenerationPrompt,
} from "../notebook-initial-generation-prompt.js";

const bookSchema = { book_id: z.string().uuid() };
const cellTypeSchema = z.enum(NOTEBOOK_CELL_TYPES);
const notebookGridSlotSchema = z.object({
  row: z.number().int().min(0).max(25),
  column: z.number().int().min(0).max(12),
});

function notebookConnectionError(
  notebook: NotebookDocument,
  sourceId: string,
  targetId: string,
  targetInput: string,
): string | null {
  const source = notebook.cells.find((cell) => cell.id === sourceId);
  const target = notebook.cells.find((cell) => cell.id === targetId);
  if (!source) return `Source cell not found: ${sourceId}`;
  if (!target) return `Target cell not found: ${targetId}`;
  if (
    target.type === "image"
    && targetInput !== "media"
    && targetInput !== "segment"
  ) {
    return "Image cells accept media or segment inputs";
  }
  if (target.type === "analysis") {
    if (targetInput !== "result") {
      return "Analysis result cells accept only the result input";
    }
    if (source.type !== "analyze") {
      return "Analysis result cells require an Analyze source";
    }
    const existing = notebook.edges.find((edge) =>
      edge.source === source.id && edge.targetInput === "result");
    return existing && existing.target !== target.id
      ? "Analyze cells can have only one Analysis result"
      : null;
  }
  if (
    target.type === "extract_audio"
    || target.inputs?.mediaRole === "extract-audio-output"
  ) {
    if (targetInput !== "video" && targetInput !== "segment") {
      return "Extract audio cells accept only the video input";
    }
    return notebookCellMediaType(source) === "video"
      && source.type !== "split_video"
      ? null
      : "Extract audio cells require a video-producing source";
  }
  if (target.type === "split_video") {
    if (targetInput === "analysis") {
      return source.type === "analysis"
        ? null
        : "Split video analysis input requires an Analysis result cell";
    }
    if (targetInput !== "video") {
      return "Split video cells accept video and analysis inputs";
    }
    return notebookCellMediaType(source) === "video"
      && source.type !== "split_video"
      ? null
      : "Split video cells require a video-producing source";
  }
  if (target.type === "prompt" && targetInput === "analysis") {
    return source.type === "analysis"
      ? null
      : "Prompt analysis input requires an Analysis result cell";
  }
  if (
    targetInput === "media"
    && target.type === "audio"
    && source.type !== "extract_audio"
    && source.type !== "generate_audio"
  ) {
    return "Audio media outputs require an extract audio or generate audio source";
  }
  if (
    targetInput === "media"
    && target.type === "video"
    && source.type !== "split_video"
    && source.type !== "generate_video"
  ) {
    return "Video media outputs require a split video or generate video source";
  }
  if (
    targetInput === "media"
    && target.type === "image"
    && source.type !== "generate_image"
  ) {
    return "Image media outputs require a generate image source";
  }
  if (
    targetInput === "segment"
    && target.type === "image"
    && (notebookCellMediaType(source) !== "video"
      || source.type === "split_video")
  ) {
    return "Image frame outputs require a video-producing source";
  }
  return null;
}

function markCellStale(
  notebook: NotebookDocument,
  cellId: string,
): NotebookDocument {
  const execution = { ...(notebook.execution ?? {}) };
  const current = execution[cellId];
  execution[cellId] = current
    && typeof current === "object"
    && !Array.isArray(current)
    ? { ...current as Record<string, unknown>, stale: true }
    : { stale: true };
  return {
    ...notebook,
    execution,
    cells: notebook.cells.map((cell) =>
      cell.id === cellId
        ? {
            ...cell,
            outputArtifactId: undefined,
            inputs: {
              ...(cell.inputs ?? {}),
              state: "pending",
            },
          }
        : cell),
  };
}

function markCellAndDescendantsStale(
  notebook: NotebookDocument,
  cellId: string,
): NotebookDocument {
  return markCellStale(markDescendantsStale(notebook, cellId), cellId);
}

const cellReferenceSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum([
    "artifact",
    "stream",
    "source-range",
    "transcript",
    "sequence",
    "cell-output",
  ]),
  target_id: z.string().min(1),
  snapshot: z.record(z.string(), z.unknown()),
  ordinal: z.number().int().nonnegative(),
});
const rationalSchema = z.object({
  numerator: z.number().int().positive(),
  denominator: z.number().int().positive(),
});
const sourceRangeSchema = z.object({
  streamId: z.string().min(1),
  objectHash: z.string().min(1),
  startTick: z.number().int().nonnegative(),
  durationTicks: z.number().int().positive(),
  timeBase: rationalSchema,
});
const searchLocationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("still"),
    artifactId: z.string().uuid(),
    sourcePath: z.string().min(1),
    objectHash: z.string().min(1),
  }),
  z.object({
    kind: z.literal("timed"),
    artifactId: z.string().uuid(),
    range: sourceRangeSchema,
  }),
  z.object({
    kind: z.literal("document"),
    artifactId: z.string().uuid(),
    sourcePath: z.string().min(1),
    objectHash: z.string().min(1),
    startUtf8Byte: z.number().int().nonnegative(),
    endUtf8Byte: z.number().int().positive(),
  }),
]);
const searchQuerySchema = z.record(z.string(), z.unknown());
const searchSignalSchema = z.object({
  kind: z.enum(["visual", "speech", "ocr", "audio", "metadata", "exact", "near"]),
  rank: z.number().int().positive(),
  score: z.number().optional(),
  explanation: z.string().optional(),
});
const pinnedSearchResultSchema = z.object({
  id: z.string().uuid(),
  artifact_id: z.string().uuid(),
  object_hash: z.string().min(1),
  location: searchLocationSchema,
  representative_tick: z.number().int().nonnegative().optional(),
  query: searchQuerySchema,
  signals: z.array(searchSignalSchema),
  selected_revision: z.string().min(1),
  ordinal: z.number().int().nonnegative(),
  created_at: z.number().int().nonnegative(),
});
const cellInputSchema = z.object({
  id: z.string().uuid().optional(),
  type: cellTypeSchema,
  label: z.string().optional(),
  slot: notebookGridSlotSchema,
  output_entity_id: z.string().uuid().optional(),
  prompt: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  operation: z.string().optional(),
  tool: z.string().optional(),
  inputs: z.record(z.string(), z.unknown()).optional(),
  output_artifact_id: z.string().uuid().optional(),
  references: z.array(cellReferenceSchema).optional(),
  pinned_results: z.array(pinnedSearchResultSchema).optional(),
});

type CellInput = z.infer<typeof cellInputSchema>;

function referenceFromInput(
  input: z.infer<typeof cellReferenceSchema>,
): NotebookCellReference {
  return {
    id: input.id,
    kind: input.kind,
    targetId: input.target_id,
    snapshot: input.snapshot,
    ordinal: input.ordinal,
  };
}

function pinnedResultFromInput(
  input: z.infer<typeof pinnedSearchResultSchema>,
): PinnedSearchResult {
  return {
    id: input.id,
    artifactId: input.artifact_id,
    objectHash: input.object_hash,
    location: input.location,
    ...(input.representative_tick === undefined
      ? {}
      : { representativeTick: input.representative_tick }),
    query: input.query,
    signals: input.signals,
    selectedRevision: input.selected_revision,
    ordinal: input.ordinal,
    createdAt: input.created_at,
  };
}

function json(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function failure(message: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

type GenerationPlanStatus =
  | "planned"
  | "queued"
  | "awaiting-output"
  | "failed"
  | "omitted"
  | "continued";

type NotebookGenerationPlanRecord = {
  planId: string;
  cellId: string;
  status: GenerationPlanStatus;
  plan: Record<string, unknown>;
  outputArtifactId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

function notebookGenerationPlans(
  notebook: NotebookDocument,
): NotebookGenerationPlanRecord[] {
  return (notebook.generationPlans ?? []) as NotebookGenerationPlanRecord[];
}

async function persistNotebookGenerationPlan(
  engine: Engine,
  notebookId: string,
  next: NotebookGenerationPlanRecord,
): Promise<void> {
  const result = await mutateNotebook(
    engine,
    notebookId,
    "persist_generation_plan",
    (notebook) => ({
      ...notebook,
      generationPlans: [
        ...notebookGenerationPlans(notebook)
          .filter((candidate) => candidate.planId !== next.planId),
        next,
      ],
    }),
    {
      planId: next.planId,
      cellId: next.cellId,
      status: next.status,
      outputArtifactId: next.outputArtifactId,
      error: next.error,
    },
  );
  if (!result.ok) throw new Error(result.error.message);
}

async function notebookGenerationPlan(
  engine: Engine,
  notebook: NotebookDocument,
  cellId: string,
  sourceSurface: "ui" | "slash" | "chat",
  actor: string,
  destination: {
    trackId?: string;
    timelineStartFrame: number;
    durationFrames?: number;
  },
): Promise<Record<string, unknown>> {
  const cell = notebook.cells.find((candidate) => candidate.id === cellId);
  if (!cell || !notebookCellIsPaid(cell)) {
    throw new Error("Choose a configured generation cell");
  }
  const prepared = await prepareNotebookGeneration(
    engine,
    notebook,
    cell,
    engine.book.get().bookId,
  );
  const assessment = await assessToolCallEstimate(
    engine,
    prepared.tool,
    prepared.input,
  );
  if (!assessment.available) {
    await logUnavailableCostEstimate({
      assessment,
      engine,
      correlation: {
        bookId: engine.book.get().bookId,
        notebookId: notebook.id,
        cellId: cell.id,
        tool: prepared.tool,
        provider: prepared.provider,
        model: prepared.model,
        stage: "plan-generation",
      },
    });
  }
  const estimatedCost = assessment.available ? assessment.usd : undefined;
  const estimateUnavailable = !assessment.available;
  const cellDefinitionFingerprint = notebookCellDefinitionFingerprint(
    notebook,
    cell,
  );
  if (cell.operation === "rewrite_prompt") {
    const planId = uuidv7();
    const enriched: Record<string, unknown> = {
      planVersion: 1,
      planId,
      sourceSurface,
      actor,
      bookId: engine.book.get().bookId,
      summary: `Rewrite ${notebookGridTag(cell.slot)} for Seedance 2`,
      normalizedReferences: [{
        kind: "notebook",
        targetId: notebook.id,
        revision: engine.head,
      }],
      stages: [{
        stageId: `${planId}:queued:0`,
        kind: "queued",
        summary: `Run ${prepared.tool}`,
        jobType: "generation",
        tool: "run_notebook_cell",
        input: {
          notebook_id: notebook.id,
          cell_id: cell.id,
          generation_tool: prepared.tool,
          generation_input: prepared.input,
        },
        provider: prepared.provider,
        model: prepared.model,
        ...(estimateUnavailable
          ? { estimateUnavailable: true }
          : { estimatedCostUsd: estimatedCost }),
        insertsOutput: false,
      }],
      confirmation: {
        required: true,
        policy: "always",
        reason: estimateUnavailable
          ? "Prompt rewrite pricing is unavailable and requires explicit confirmation"
          : `This prompt rewrite can incur up to $${Number(estimatedCost).toFixed(4)}`,
      },
      cellDefinitionFingerprint,
    };
    const now = new Date().toISOString();
    await persistNotebookGenerationPlan(engine, notebook.id, {
      planId,
      cellId: cell.id,
      status: "planned",
      plan: enriched,
      createdAt: now,
      updatedAt: now,
    });
    return enriched;
  }
  const sequence = engine.sequences.getPrimary();
  const outputTrackKind: "video" | "audio" = cell.type === "generate_audio"
    ? "audio"
    : "video";
  const track = destination.trackId
    ? sequence.tracks.find((candidate) =>
        candidate.trackId === destination.trackId)
    : sequence.tracks.find((candidate) =>
        candidate.kind === outputTrackKind
        && candidate.enabled
        && !candidate.locked);
  if (!track || track.kind !== outputTrackKind) {
    throw new Error(
      `No editable ${outputTrackKind} track is available for the generated output`,
    );
  }
  const plan = buildGenerationInsertPlan(engine, {
    tool: prepared.tool,
    input: {
      notebook_id: notebook.id,
      cell_id: cell.id,
      generation_tool: prepared.tool,
      generation_input: prepared.input,
    },
    provider: prepared.provider,
    model: prepared.model,
    ...(estimateUnavailable
      ? { estimate_unavailable: true }
      : { estimated_cost_usd: estimatedCost }),
    track_id: track.trackId,
    timeline_start_frame: destination.timelineStartFrame,
    ...(destination.durationFrames === undefined
      ? {}
      : { duration_frames: destination.durationFrames }),
  }, sourceSurface, actor);
  const stages = Array.isArray(plan.stages)
    ? plan.stages.map((stage) => {
        if (!stage || typeof stage !== "object" || Array.isArray(stage)) return stage;
        return {
          ...stage,
          tool: "run_notebook_cell",
        };
      })
    : [];
  const enriched = {
    ...plan,
    cellDefinitionFingerprint,
    normalizedReferences: [
      ...(Array.isArray(plan.normalizedReferences)
        ? plan.normalizedReferences
        : []),
      {
        kind: "notebook",
        targetId: notebook.id,
        revision: engine.head,
      },
    ],
    stages,
  };
  const now = new Date().toISOString();
  await persistNotebookGenerationPlan(engine, notebook.id, {
    planId: String(enriched.planId),
    cellId: cell.id,
    status: "planned",
    plan: enriched,
    createdAt: now,
    updatedAt: now,
  });
  return enriched;
}

function cellFromInput(
  input: CellInput,
): Omit<NotebookCell, "id"> & { id?: string } {
  return {
    ...(input.id ? { id: input.id } : {}),
    type: input.type,
    ...(input.label === undefined ? {} : { label: input.label }),
    slot: input.slot,
    ...(input.output_entity_id
      ? { outputEntityId: input.output_entity_id }
      : {}),
    ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
    ...(input.provider === undefined ? {} : { provider: input.provider }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.operation === undefined ? {} : { operation: input.operation }),
    ...(input.tool === undefined ? {} : { tool: input.tool }),
    ...(input.inputs === undefined ? {} : { inputs: input.inputs }),
    ...(input.output_artifact_id ? { outputArtifactId: input.output_artifact_id } : {}),
    ...(input.references === undefined
      ? {}
      : { references: input.references.map(referenceFromInput) }),
    ...(input.pinned_results === undefined
      ? {}
      : { pinnedResults: input.pinned_results.map(pinnedResultFromInput) }),
  };
}

function cellPayload(cell: NotebookCell): Record<string, unknown> {
  return {
    id: cell.id,
    type: cell.type,
    ...(cell.label === undefined ? {} : { label: cell.label }),
    address: notebookGridTag(cell.slot),
    slot: cell.slot,
    ...(cell.outputEntityId
      ? { output_entity_id: cell.outputEntityId }
      : {}),
    ...(cell.prompt === undefined ? {} : { prompt: cell.prompt }),
    ...(cell.provider === undefined ? {} : { provider: cell.provider }),
    ...(cell.model === undefined ? {} : { model: cell.model }),
    ...(cell.operation === undefined ? {} : { operation: cell.operation }),
    ...(cell.tool === undefined ? {} : { tool: cell.tool }),
    ...(cell.inputs === undefined ? {} : { inputs: cell.inputs }),
    ...(cell.outputArtifactId ? { output_artifact_id: cell.outputArtifactId } : {}),
    ...(cell.references === undefined
      ? {}
      : {
          references: cell.references.map((reference) => ({
            id: reference.id,
            kind: reference.kind,
            target_id: reference.targetId,
            snapshot: reference.snapshot,
            ordinal: reference.ordinal,
          })),
        }),
    ...(cell.pinnedResults === undefined
      ? {}
      : {
          pinned_results: cell.pinnedResults.map((result) => ({
            id: result.id,
            artifact_id: result.artifactId,
            object_hash: result.objectHash,
            location: result.location,
            ...(result.representativeTick === undefined
              ? {}
              : { representative_tick: result.representativeTick }),
            query: result.query,
            signals: result.signals,
            selected_revision: result.selectedRevision,
            ordinal: result.ordinal,
            created_at: result.createdAt,
          })),
        }),
  };
}

function notebookPayload(
  engine: Engine,
  notebook: NotebookDocument,
): Record<string, unknown> {
  const normalized = hydrateNotebookProviderFailures(
    engine,
    normalizeLegacyAnalyzeDocument(normalizeLegacyExtractCells(notebook)),
  );
  return {
    id: normalized.id,
    name: normalized.name,
    revision: engine.head,
    created_at: normalized.createdAt,
    ...(normalized.description === undefined
      ? {}
      : { description: normalized.description }),
    ...(normalized.lifecycleState === undefined
      ? {}
      : { lifecycleState: normalized.lifecycleState }),
    ...(normalized.workflowVersion === undefined
      ? {}
      : { workflowVersion: normalized.workflowVersion }),
    ...(normalized.analysisRevision === undefined
      ? {}
      : { analysisRevision: normalized.analysisRevision }),
    ...(normalized.fixture === undefined ? {} : { fixture: normalized.fixture }),
    execution: normalized.execution ?? {},
    generationPlans: normalized.generationPlans ?? [],
    notebookRunPlans: normalized.notebookRunPlans ?? [],
    cells: normalized.cells.map(cellPayload),
    edges: normalized.edges,
  };
}

function entityDefs(engine: Engine, type: EntityType): ToolDef[] {
  const plural = type === "character" ? "characters" : `${type}s`;
  return [
    {
      name: `create_${type}_entity`,
      description: `Create a reusable ${type}`,
      scope: "book",
      schema: {
        ...bookSchema,
        name: z.string().min(1),
        description: z.string().optional(),
        prompt: z.string().optional(),
        data: z.record(z.string(), z.unknown()).optional(),
      },
      handler: async (args) => {
        const result = await engine.entities.create(type, String(args.name), {
          ...(typeof args.description === "string" ? { description: args.description } : {}),
          ...(typeof args.prompt === "string" ? { prompt: args.prompt } : {}),
          data: args.data as Record<string, unknown> | undefined,
        });
        return result.ok ? json(result.value) : failure(result.error.message);
      },
    },
    {
      name: `list_${plural}`,
      description: `List reusable ${plural}`,
      scope: "book",
      schema: bookSchema,
      handler: async () => json(engine.entities.list(type)),
    },
    {
      name: `get_${type}_entity`,
      description: `Read a reusable ${type}`,
      scope: "book",
      schema: { ...bookSchema, entity_id: z.string().uuid() },
      handler: async (args) => {
        const result = engine.entities.read(String(args.entity_id));
        return result.ok ? json(result.value) : failure(result.error.message);
      },
    },
    {
      name: `update_${type}_entity`,
      description: `Update a reusable ${type}`,
      scope: "book",
      schema: { ...bookSchema, entity: z.record(z.string(), z.unknown()) },
      handler: async (args) => {
        const result = await engine.entities.write(args.entity as unknown as EntityDocument);
        return result.ok ? json(result.value) : failure(result.error.message);
      },
    },
    {
      name: `delete_${type}_entity`,
      description: `Delete a reusable ${type}`,
      scope: "book",
      schema: { ...bookSchema, entity_id: z.string().uuid() },
      handler: async (args) => {
        const result = await engine.entities.delete(String(args.entity_id));
        return result.ok ? json(result.value) : failure(result.error.message);
      },
    },
  ];
}

export function videobookDomainDefs(
  engine: Engine,
  books: BookManager,
): ToolDef[] {
  return [
    {
      name: "list_books",
      description: "List all Videobook books",
      scope: "global",
      schema: { sort: z.enum(["newest", "oldest"]).optional() },
      handler: async (args) => {
        await books.ready();
        return json(books.list({
          ...(args.sort === "newest" || args.sort === "oldest" ? { sort: args.sort } : {}),
        }));
      },
    },
    {
      name: "create_book",
      description: "Create a book with a Main notebook",
      scope: "global",
      schema: { name: z.string().min(1) },
      handler: async (args) => {
        const result = await books.create(String(args.name));
        return result.ok ? json(result.value) : failure(result.error.message);
      },
    },
    {
      name: "list_legacy_books",
      description: "List schema-v4 books awaiting an explicit copy-forward migration",
      scope: "global",
      schema: {},
      handler: async () => {
        await books.ready();
        return json(books.listLegacy());
      },
    },
    {
      name: "migrate_legacy_book",
      description: "Copy a confirmed schema-v4 book to v5 and archive the untouched source",
      scope: "global",
      schema: {
        book_id: z.string().uuid(),
        expected_source_head: z.string().min(1),
      },
      handler: async (args) => {
        const result = await books.migrateLegacy(
          String(args.book_id),
          String(args.expected_source_head),
        );
        return result.ok ? json(result.value) : failure(result.error.message);
      },
    },
    {
      name: "rename_book",
      description: "Rename a book",
      scope: "global",
      schema: { ...bookSchema, name: z.string().min(1) },
      handler: async (args) => {
        const result = await books.rename(String(args.book_id), String(args.name));
        return result.ok ? json(result.value) : failure(result.error.message);
      },
    },
    {
      name: "delete_book",
      description: "Permanently delete a book after typed name confirmation",
      scope: "global",
      schema: { ...bookSchema, confirm_name: z.string().min(1) },
      handler: async (args) => {
        const result = await books.delete(String(args.book_id), {
          confirmName: String(args.confirm_name),
          beforeDelete: async (book) => stopBookQueue(book.bookId),
        });
        return result.ok ? json(result.value) : failure(result.error.message);
      },
    },
    {
      name: "get_book",
      description: "Read the current book identity",
      scope: "book",
      schema: bookSchema,
      handler: async () => json(engine.book.get()),
    },
    {
      name: "check_duplicate_bytes",
      description: "Find existing book files with the same immutable content hash before import",
      scope: "book",
      schema: {
        ...bookSchema,
        object_hash: z.string().regex(/^[0-9a-f]{64}$/i),
      },
      handler: async (args) => {
        const objectHash = String(args.object_hash).toLowerCase();
        const matches = [];
        for (const artifact of engine.artifacts.list()) {
          const manifest = await engine.files.manifest(artifact.artifactId);
          if (!manifest.ok) continue;
          for (const file of manifest.value.files) {
            if (file.objectHash.toLowerCase() !== objectHash) continue;
            matches.push({
              artifact_id: artifact.artifactId,
              ...(artifact.label === undefined ? {} : { label: artifact.label }),
              kind: artifact.kind,
              filename: file.name,
              object_hash: file.objectHash,
            });
          }
        }
        return json({ object_hash: objectHash, matches });
      },
    },
    {
      name: "list_notebooks",
      description: "List canonical notebook documents",
      scope: "book",
      schema: bookSchema,
      handler: async () => json(engine.notebooks.list().map((notebook) =>
        notebookPayload(engine, notebook))),
    },
    {
      name: "get_primary_sequence",
      description: "Read the canonical primary sequence",
      scope: "book",
      schema: bookSchema,
      handler: async () => json(engine.sequences.getPrimary()),
    },
    {
      name: "add_sequence_track",
      description: "Append a canonical video, audio, or caption track",
      scope: "book",
      schema: {
        ...bookSchema,
        kind: z.enum(["video", "audio", "caption"]),
        name: z.string().min(1).optional(),
      },
      handler: async (args) => {
        const sequence = engine.sequences.getPrimary();
        const result = await engine.sequences.addTrack(sequence.sequenceId, {
          kind: args.kind as "video" | "audio" | "caption",
          ...(typeof args.name === "string" ? { name: args.name } : {}),
        });
        return result.ok ? json(result.value) : failure(result.error.message);
      },
    },
    {
      name: "remove_sequence_track",
      description: "Remove an empty canonical track while preserving required track kinds",
      scope: "book",
      schema: {
        ...bookSchema,
        track_id: z.string().uuid(),
      },
      handler: async (args) => {
        const result = await engine.sequences.removeTrack(String(args.track_id));
        return result.ok ? json(result.value) : failure(result.error.message);
      },
    },
    {
      name: "plan_notebook_generation",
      description: "Plan a notebook prompt, image, or video generation with provider, model, cost, and revision-pinned execution",
      scope: "book",
      schema: {
        ...bookSchema,
        notebook_id: z.string().uuid(),
        cell_id: z.string().uuid(),
        source_surface: z.enum(["ui", "slash", "chat"]),
        actor: z.string().min(1),
        track_id: z.string().uuid().optional(),
        timeline_start_frame: z.number().int().nonnegative(),
        duration_frames: z.number().int().positive().optional(),
      },
      handler: async (args) => {
        try {
          const notebook = engine.notebooks.read(String(args.notebook_id));
          if (!notebook.ok) return failure(notebook.error.message);
          return json(await notebookGenerationPlan(
            engine,
            notebook.value,
            String(args.cell_id),
            args.source_surface as "ui" | "slash" | "chat",
            String(args.actor),
            {
              ...(typeof args.track_id === "string"
                ? { trackId: args.track_id }
                : {}),
              timelineStartFrame: Number(args.timeline_start_frame),
              ...(typeof args.duration_frames === "number"
                ? { durationFrames: args.duration_frames }
                : {}),
            },
          ));
        } catch (error) {
          return failure(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "list_notebook_generation_plans",
      description: "List durable generation plans and their retryable lifecycle state",
      scope: "book",
      schema: {
        ...bookSchema,
        notebook_id: z.string().uuid(),
      },
      handler: async (args) => {
        const notebook = engine.notebooks.read(String(args.notebook_id));
        return notebook.ok
          ? json(notebookGenerationPlans(notebook.value))
          : failure(notebook.error.message);
      },
    },
    {
      name: "plan_notebook_run",
      description: "Plan every missing or stale notebook cell with aggregate provider cost and media disclosure",
      scope: "book",
      schema: {
        ...bookSchema,
        notebook_id: z.string().uuid(),
        source_surface: z.enum(["ui", "slash", "chat"]),
        actor: z.string().min(1),
        force: z.boolean().optional(),
      },
      handler: async (args) => {
        try {
          const notebook = engine.notebooks.read(String(args.notebook_id));
          if (!notebook.ok) return failure(notebook.error.message);
          return json(await planNotebookRun(
            engine,
            notebook.value,
            args.source_surface as "ui" | "slash" | "chat",
            String(args.actor),
            { force: args.force === true },
          ));
        } catch (error) {
          return failure(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "plan_notebook_subgraph",
      description:
        "Plan the selected cell plus required stale ancestors, with paid-stage fingerprints, cost, and confirmation",
      scope: "book",
      schema: {
        ...bookSchema,
        notebook_id: z.string().uuid(),
        cell_id: z.string().uuid(),
        source_surface: z.enum(["ui", "slash", "chat"]),
        actor: z.string().min(1),
      },
      handler: async (args) => {
        try {
          const notebook = engine.notebooks.read(String(args.notebook_id));
          if (!notebook.ok) return failure(notebook.error.message);
          return json(await planSelectedNotebookSubgraph(
            engine,
            notebook.value,
            String(args.cell_id),
            args.source_surface as "ui" | "slash" | "chat",
            String(args.actor),
          ));
        } catch (error) {
          return failure(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "list_notebook_run_plans",
      description: "List durable aggregate workbook run plans and their lifecycle state",
      scope: "book",
      schema: {
        ...bookSchema,
        notebook_id: z.string().uuid(),
      },
      handler: async (args) => {
        const notebook = engine.notebooks.read(String(args.notebook_id));
        return notebook.ok
          ? json(notebookRunPlanRecords(notebook.value))
          : failure(notebook.error.message);
      },
    },
    {
      name: "enqueue_notebook_run",
      description: "Revalidate and enqueue a persisted aggregate workbook plan",
      scope: "book",
      schema: {
        ...bookSchema,
        notebook_id: z.string().uuid(),
        plan_id: z.string().uuid(),
        actor: z.string().min(1),
        confirm_unpriced: z.boolean(),
      },
      handler: async (args) => {
        try {
          return json(await enqueueNotebookRunPlan(
            engine,
            String(args.notebook_id),
            String(args.plan_id),
            {
              actor: String(args.actor),
              confirmUnpriced: args.confirm_unpriced === true,
            },
          ));
        } catch (error) {
          return failure(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "revise_notebook_generation_plan",
      description: "Retry, switch the allowed generation model, or omit a preserved notebook generation plan",
      scope: "book",
      schema: {
        ...bookSchema,
        notebook_id: z.string().uuid(),
        plan_id: z.string().uuid(),
        action: z.enum(["retry", "switch", "omit"]),
        model: z.string().min(1).optional(),
        source_surface: z.enum(["ui", "slash", "chat"]),
        actor: z.string().min(1),
      },
      handler: async (args) => {
        try {
          const notebookResult = engine.notebooks.read(String(args.notebook_id));
          if (!notebookResult.ok) return failure(notebookResult.error.message);
          let notebook = notebookResult.value;
          const existing = notebookGenerationPlans(notebook).find((candidate) =>
            candidate.planId === String(args.plan_id));
          if (!existing) return failure("Generation plan not found");
          if (args.action === "omit") {
            await persistNotebookGenerationPlan(engine, notebook.id, {
              ...existing,
              status: "omitted",
              updatedAt: new Date().toISOString(),
            });
            return json({
              kind: "generation-omitted",
              planId: existing.planId,
              outputArtifactId: existing.outputArtifactId,
            });
          }
          if (args.action === "switch") {
            if (typeof args.model !== "string") {
              return failure("Switching requires an allowed generation model");
            }
            const nextModel = String(args.model);
            const updated = await mutateNotebook(
              engine,
              notebook.id,
              "switch_generation_model",
              (document) => ({
                ...document,
                cells: document.cells.map((cell) =>
                  cell.id === existing.cellId
                    ? {
                        ...cell,
                        model: nextModel,
                        // Model switch can pass a generation tool name; keep tool in sync.
                        ...(nextModel.startsWith("generate_")
                          || nextModel.startsWith("extend_")
                          || nextModel.startsWith("upscale_")
                          ? { tool: nextModel }
                          : {}),
                      }
                    : cell),
              }),
              {
                sourcePlanId: existing.planId,
                cellId: existing.cellId,
                model: args.model,
              },
            );
            if (!updated.ok) return failure(updated.error.message);
            const refreshed = engine.notebooks.read(notebook.id);
            if (!refreshed.ok) return failure(refreshed.error.message);
            notebook = refreshed.value;
          }
          const stages = Array.isArray(existing.plan.stages)
            ? existing.plan.stages
            : [];
          const queued = stages.find((stage) =>
            stage
            && typeof stage === "object"
            && !Array.isArray(stage)
            && (stage as Record<string, unknown>).kind === "queued") as
            | Record<string, unknown>
            | undefined;
          const continuation = queued?.continuation
            && typeof queued.continuation === "object"
            && !Array.isArray(queued.continuation)
            ? queued.continuation as Record<string, unknown>
            : null;
          const destination = continuation?.destination
            && typeof continuation.destination === "object"
            && !Array.isArray(continuation.destination)
            ? continuation.destination as Record<string, unknown>
            : null;
          if (
            !destination
            || typeof destination.timelineStartFrame !== "number"
          ) {
            return failure("The preserved generation destination is invalid");
          }
          const next = await notebookGenerationPlan(
            engine,
            notebook,
            existing.cellId,
            args.source_surface as "ui" | "slash" | "chat",
            String(args.actor),
            {
              ...(typeof destination.trackId === "string"
                ? { trackId: destination.trackId }
                : {}),
              timelineStartFrame: destination.timelineStartFrame,
              ...(typeof destination.durationFrames === "number"
                ? { durationFrames: destination.durationFrames }
                : {}),
            },
          );
          return json({
            ...next,
            parentActionId: existing.planId,
          });
        } catch (error) {
          return failure(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "continue_notebook_generation",
      description: "Create a reviewable insertion plan for a completed generation or report a stale destination",
      scope: "book",
      schema: {
        ...bookSchema,
        notebook_id: z.string().uuid(),
        plan_id: z.string().uuid(),
        actor: z.string().min(1),
      },
      handler: async (args) => {
        try {
          const notebook = engine.notebooks.read(String(args.notebook_id));
          if (!notebook.ok) return failure(notebook.error.message);
          const existing = notebookGenerationPlans(notebook.value).find(
            (candidate) => candidate.planId === String(args.plan_id),
          );
          if (!existing) return failure("Generation plan not found");
          if (!existing.outputArtifactId) {
            return failure("Generation output is not ready");
          }
          const continuation = await continueQueuedInsert(
            engine,
            existing.plan,
            existing.outputArtifactId,
            String(args.actor),
          );
          if (continuation.kind !== "stale-continuation") {
            await persistNotebookGenerationPlan(engine, notebook.value.id, {
              ...existing,
              status: "continued",
              updatedAt: new Date().toISOString(),
            });
          }
          return json(continuation);
        } catch (error) {
          return failure(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "create_notebook",
      description: "Create an empty notebook",
      scope: "book",
      schema: { ...bookSchema, name: z.string().min(1) },
      handler: async (args) => {
        const result = await engine.notebooks.create(String(args.name));
        return result.ok ? json(notebookPayload(engine, result.value)) : failure(result.error.message);
      },
    },
    {
      name: "get_notebook",
      description: "Read a notebook graph",
      scope: "book",
      schema: { ...bookSchema, notebook_id: z.string().uuid() },
      handler: async (args) => {
        const result = engine.notebooks.read(String(args.notebook_id));
        return result.ok ? json(notebookPayload(engine, result.value)) : failure(result.error.message);
      },
    },
    {
      name: "list_notebook_actions",
      description: "List the deterministic notebook action catalog for runnable cells",
      scope: "book",
      schema: {
        ...bookSchema,
        cell_type: cellTypeSchema.optional(),
      },
      handler: async (args) => {
        const [
          { getAllToolDefs },
          { getVideoToolSchema },
          { getImageToolSchema },
        ] = await Promise.all([
          import("./index.js"),
          import("../video-models.js"),
          import("../image-models.js"),
        ]);
        const definitions = new Map(
          getAllToolDefs(engine).map((definition) => [definition.name, definition]),
        );
        const actions = listNotebookActions()
          .filter((action) =>
            args.cell_type
              ? action.cellTypes.includes(args.cell_type as NotebookCellType)
              : true)
          .map((action) => {
            if (action.kind !== "generation" || !action.tool) return action;
            const definition = definitions.get(action.tool);
            if (!definition) return action;
            const settingsSchema = action.cellTypes.includes("generate_video")
              ? getVideoToolSchema(action.tool)
              : action.cellTypes.includes("generate_image")
                ? getImageToolSchema(action.tool)
                : null;
            return {
              ...action,
              inputContract: notebookGenerationInputContract(
                action.tool,
                definition.schema,
              ),
              controls: notebookGenerationControls(
                settingsSchema ?? z.object(definition.schema).toJSONSchema(),
                action.tool === "generate_kie_gemini_omni_video"
                  ? { duration: "8" }
                  : {},
              ),
            };
          });
        return json({ actions });
      },
    },
    {
      name: "get_notebook_cell_details",
      description: "Return selected-cell details including raw Dolt row, edges, and action validation",
      scope: "book",
      schema: {
        ...bookSchema,
        notebook_id: z.string().uuid(),
        cell_id: z.string().uuid(),
      },
      handler: async (args) => {
        const result = engine.notebooks.read(String(args.notebook_id));
        if (!result.ok) return failure(result.error.message);
        try {
          const document = hydrateNotebookProviderFailures(
            engine,
            normalizeLegacyExtractCells(result.value),
          );
          const { generateCell } = pairForCell(document, String(args.cell_id));
          const generationsResult = engine.generations.listForCell(
            String(args.notebook_id),
            generateCell.id,
          );
          return json(selectedCellDetails(
            String(args.notebook_id),
            document,
            String(args.cell_id),
            generationsResult.ok ? generationsResult.value : [],
          ));
        } catch (cause) {
          return failure(cause instanceof Error ? cause.message : String(cause));
        }
      },
    },
    {
      name: "ensure_notebook_workflow_scaffold",
      description: "Ensure the seven-stage VIDEO→CONCAT workflow scaffold exists",
      scope: "book",
      schema: {
        ...bookSchema,
        notebook_id: z.string().uuid(),
        source_artifact_id: z.string().uuid().optional(),
      },
      handler: async (args) => {
        const result = await mutateNotebook(
          engine,
          String(args.notebook_id),
          "ensure_notebook_workflow_scaffold",
          (notebook) => buildSevenStageScaffold(
            engine,
            notebook,
            typeof args.source_artifact_id === "string"
              ? args.source_artifact_id
              : undefined,
          ),
        );
        if (!result.ok) return failure(result.error.message);
        const read = engine.notebooks.read(String(args.notebook_id));
        return read.ok
          ? json(notebookPayload(engine, read.value))
          : failure(read.error.message);
      },
    },
    {
      name: "rename_notebook",
      description: "Rename a notebook",
      scope: "book",
      schema: { ...bookSchema, notebook_id: z.string().uuid(), name: z.string().min(1) },
      handler: async (args) => {
        const result = await mutateNotebook(
          engine,
          String(args.notebook_id),
          "rename_notebook",
          (notebook) => ({ ...notebook, name: String(args.name) }),
        );
        return result.ok ? json({ notebook_id: args.notebook_id, revision: result.value.hash }) : failure(result.error.message);
      },
    },
    {
      name: "delete_notebook",
      description: "Delete a notebook and its cells, edges, and runs",
      scope: "book",
      schema: { ...bookSchema, notebook_id: z.string().uuid() },
      handler: async (args) => {
        const result = await engine.notebooks.delete(String(args.notebook_id));
        return result.ok ? json(result.value) : failure(result.error.message);
      },
    },
    {
      name: "create_notebook_cell",
      description: "Create a UUIDv7 notebook cell",
      scope: "book",
      schema: {
        ...bookSchema,
        notebook_id: z.string().uuid(),
        cell: cellInputSchema,
        expected_revision: z.string().min(1).optional(),
      },
      handler: async (args) => {
        let cell = engine.notebooks.createCell(cellFromInput(args.cell as CellInput));
        let outputCell: NotebookCell | null = null;
        let outputEdge: NotebookDocument["edges"][number] | null = null;
        try {
          const result = await mutateNotebook(
            engine,
            String(args.notebook_id),
            "create_notebook_cell",
            (notebook) => {
              if (
                typeof args.expected_revision === "string"
                && args.expected_revision !== engine.head
              ) {
                throw new Error(
                  `Stale notebook revision: expected ${args.expected_revision}`,
                );
              }
            cell = normalizeCellActionFields(cell, notebook);
            const withCell = seedInitialGenerationPrompt({
              ...notebook,
              cells: [...notebook.cells, cell],
            }, cell.id);
            cell = withCell.cells.find((candidate) => candidate.id === cell.id)!;
            if (cell.type === "analyze") {
              const cells = withCell.cells;
              outputCell = engine.notebooks.createCell({
                type: "analysis",
                ...(cell.label === undefined ? {} : { label: cell.label }),
                slot: nextHorizontalSlotFrom(
                  slotRight(cell.slot),
                  cells.map((candidate) => candidate.slot),
                ),
                inputs: {
                  analysisRole: "result",
                  producerCellId: cell.id,
                  state: "pending",
                },
              });
              outputEdge = engine.notebooks.createEdge({
                source: cell.id,
                target: outputCell.id,
                targetInput: "result",
              });
            }
            if (cell.type === "generate_audio") {
              const ensured = ensureGenerateAudioOutput(
                engine,
                withCell,
                cell.id,
              );
              cell = ensured.document.cells.find((candidate) =>
                candidate.id === cell.id) ?? cell;
              outputCell = ensured.outputCell;
              outputEdge = ensured.outputEdge;
              return ensured.document;
            }
            return {
              ...withCell,
              cells: [
                ...withCell.cells,
                ...(outputCell ? [outputCell] : []),
              ],
              edges: [
                ...withCell.edges,
                ...(outputEdge ? [outputEdge] : []),
              ],
            };
            },
            { cellId: cell.id },
          );
          return result.ok
            ? json({
                ...cellPayload(cell),
                ...(outputCell ? { output_cell: cellPayload(outputCell) } : {}),
                ...(outputEdge ? { output_edge: outputEdge } : {}),
              })
            : failure(result.error.message);
        } catch (cause) {
          return failure(cause instanceof Error ? cause.message : String(cause));
        }
      },
    },
    {
      name: "update_notebook_cell",
      description: "Update one notebook cell",
      scope: "book",
      schema: {
        ...bookSchema,
        notebook_id: z.string().uuid(),
        cell_id: z.string().uuid(),
        cell: cellInputSchema.partial(),
        expected_revision: z.string().min(1).optional(),
      },
      handler: async (args) => {
        if (
          typeof args.expected_revision === "string"
          && args.expected_revision !== engine.head
        ) {
          return failure(`Stale notebook revision: expected ${args.expected_revision}`);
        }
        const patch = args.cell as Partial<CellInput>;
        try {
          const result = await mutateNotebook(
            engine,
            String(args.notebook_id),
            "update_notebook_cell",
            (notebook) => {
              const document = notebook;
              let found = false;
              const cells = notebook.cells.map((cell) => {
                if (cell.id !== args.cell_id) return cell;
                found = true;
                if (patch.type && patch.type !== cell.type) {
                  const isUnconnected = !notebook.edges.some((edge) =>
                    edge.source === cell.id || edge.target === cell.id);
                  const replacement = typeof patch.output_artifact_id === "string"
                    ? engine.artifacts.get(patch.output_artifact_id)
                    : null;
                  const isDownloadImageReplacement = cell.type === "video"
                    && patch.type === "image"
                    && cell.inputs?.sourceOperation === "download_video"
                    && patch.output_artifact_id !== cell.outputArtifactId
                    && replacement?.ok === true
                    && replacement.value.kind === "image"
                    && isUnconnected;
                  if (!isDownloadImageReplacement) {
                    throw new Error("Cell type cannot be changed after creation");
                  }
                }
                const normalized = normalizeCellActionFields({
                  ...cell,
                  ...(patch.type === undefined ? {} : { type: patch.type }),
                  ...(patch.label === undefined ? {} : { label: patch.label }),
                  ...(patch.slot === undefined ? {} : { slot: patch.slot }),
                  ...(patch.output_entity_id === undefined
                    ? {}
                    : { outputEntityId: patch.output_entity_id }),
                  ...(patch.prompt === undefined ? {} : { prompt: patch.prompt }),
                  ...(patch.provider === undefined ? {} : { provider: patch.provider }),
                  ...(patch.model === undefined ? {} : { model: patch.model }),
                  ...(patch.operation === undefined ? {} : { operation: patch.operation }),
                  ...(patch.tool === undefined ? {} : { tool: patch.tool }),
                  ...(patch.inputs === undefined ? {} : { inputs: patch.inputs }),
                  ...(patch.output_artifact_id === undefined ? {} : { outputArtifactId: patch.output_artifact_id }),
                  ...(patch.references === undefined
                    ? {}
                    : { references: patch.references.map(referenceFromInput) }),
                  ...(patch.pinned_results === undefined
                    ? {}
                    : { pinnedResults: patch.pinned_results.map(pinnedResultFromInput) }),
                }, document);
                const next = reconcileInitialGenerationPrompt(cell, normalized);
                const validation = validateCellConfiguration(next, document);
                if (!validation.ok) throw new Error(validation.message);
                return next;
              });
              if (!found) throw new Error(`Cell not found: ${String(args.cell_id)}`);
              const updated = refreshInitialGenerationPrompts({
                ...document,
                cells,
              });
              return markDescendantsStale(updated, String(args.cell_id));
            },
            { cellId: args.cell_id },
          );
          return result.ok
            ? json({ cell_id: args.cell_id, revision: result.value.hash })
            : failure(result.error.message);
        } catch (cause) {
          return failure(cause instanceof Error ? cause.message : String(cause));
        }
      },
    },
    {
      name: "relayout_notebook",
      description:
        "Recompute notebook cell slots with directional placement: video stacks vertical near column 1, image/frame chains horizontal, compact near @a1. Migrates legacy generate_video / generate_image inline artifacts into output cells.",
      scope: "book",
      recordsOwnActivity: true,
      schema: {
        ...bookSchema,
        notebook_id: z.string().uuid(),
        expected_revision: z.string().min(1).optional(),
      },
      handler: async (args) => {
        try {
          const notebookId = String(args.notebook_id);
          if (
            typeof args.expected_revision === "string"
            && args.expected_revision !== engine.head
          ) {
            return failure(
              `Stale notebook revision: expected ${args.expected_revision}`,
            );
          }
          const before = engine.notebooks.read(notebookId);
          if (!before.ok) return failure(before.error.message);
          const jobId = `relayout-notebook-${notebookId}-${Date.now()}`;
          const result = await queue.enqueueAndWait<{
            changed: boolean;
            notebook_id: string;
            cell_count: number;
            edge_count: number;
            revision: string;
            cells?: Array<{
              id: string;
              type: string;
              address: string;
              slot: NotebookGridSlot;
              output_artifact_id: string | null;
            }>;
          }>(jobId, {
            type: "relayout_notebook",
            bookId: String(args.book_id),
            notebookId,
          });
          return json(result);
        } catch (cause) {
          return failure(cause instanceof Error ? cause.message : String(cause));
        }
      },
    },
    {
      name: "move_notebook_cells",
      description: "Persist notebook cell grid slots",
      scope: "book",
      recordsOwnActivity: true,
      schema: {
        ...bookSchema,
        notebook_id: z.string().uuid(),
        slots: z.array(z.object({
          id: z.string().uuid(),
          row: z.number().int().min(0).max(25),
          column: z.number().int().min(0).max(12),
        })).min(1),
        expected_revision: z.string().min(1).optional(),
      },
      handler: async (args) => {
        const requested = args.slots as Array<{
          id: string;
          row: number;
          column: number;
        }>;
        try {
          const result = await mutateNotebook(
            engine,
            String(args.notebook_id),
            "move_notebook_cells",
            (notebook) => {
              if (
                typeof args.expected_revision === "string"
                && args.expected_revision !== engine.head
              ) {
                throw new Error(
                  `Stale notebook revision: expected ${args.expected_revision}`,
                );
              }
              const slots = new Map(requested.map((slot) => [slot.id, slot]));
              if (slots.size !== requested.length) {
                throw new Error("Each moved notebook cell must appear once");
              }
              const cellsById = new Map(notebook.cells.map((cell) => [cell.id, cell]));
              for (const id of slots.keys()) {
                if (!cellsById.has(id)) throw new Error(`Cell not found: ${id}`);
              }
              if (requested.length === 1) {
                const destination = requested[0]!;
                const source = cellsById.get(destination.id)!;
                const occupied = notebook.cells.find((cell) =>
                  cell.id !== source.id
                  && cell.slot.row === destination.row
                  && cell.slot.column === destination.column);
                const moved = {
                  ...notebook,
                  cells: notebook.cells.map((cell) => {
                    if (cell.id === source.id) {
                      return {
                        ...cell,
                        slot: { row: destination.row, column: destination.column },
                      };
                    }
                    return cell.id === occupied?.id
                      ? { ...cell, slot: source.slot }
                      : cell;
                  }),
                };
                return refreshInitialGenerationPrompts(moved);
              }
              const targetKeys = new Set<string>();
              for (const slot of requested) {
                const key = `${slot.row}:${slot.column}`;
                if (targetKeys.has(key)) {
                  throw new Error(`Notebook grid square ${notebookGridTag(slot)} is targeted twice`);
                }
                targetKeys.add(key);
              }
              const movingIds = new Set(slots.keys());
              const collision = notebook.cells.find((cell) =>
                !movingIds.has(cell.id)
                && targetKeys.has(`${cell.slot.row}:${cell.slot.column}`));
              if (collision) {
                throw new Error(
                  `Notebook grid square ${notebookGridTag(collision.slot)} is occupied`,
                );
              }
              const moved = {
                ...notebook,
                cells: notebook.cells.map((cell) => {
                  const slot = slots.get(cell.id);
                  return slot
                    ? { ...cell, slot: { row: slot.row, column: slot.column } }
                    : cell;
                }),
              };
              return refreshInitialGenerationPrompts(moved);
            },
            { cellIds: requested.map((slot) => slot.id) },
          );
          return result.ok
            ? json({ notebook_id: args.notebook_id, revision: result.value.hash })
            : failure(result.error.message);
        } catch (cause) {
          return failure(cause instanceof Error ? cause.message : String(cause));
        }
      },
    },
    {
      name: "delete_notebook_cell",
      description: "Delete one notebook cell and incident edges",
      scope: "book",
      schema: {
        ...bookSchema,
        notebook_id: z.string().uuid(),
        cell_id: z.string().uuid(),
        expected_revision: z.string().min(1).optional(),
      },
      handler: async (args) => {
        if (
          typeof args.expected_revision === "string"
          && args.expected_revision !== engine.head
        ) {
          return failure(`Stale notebook revision: expected ${args.expected_revision}`);
        }
        const notebookId = String(args.notebook_id);
        const cellId = String(args.cell_id);
        const result = await engine.notebooks.removeCell(notebookId, cellId);
        return result.ok ? json({ cell_id: cellId, revision: result.value.hash }) : failure(result.error.message);
      },
    },
    {
      name: "connect_notebook_cells",
      description: "Create a UUIDv7 notebook edge",
      scope: "book",
      schema: {
        ...bookSchema,
        notebook_id: z.string().uuid(),
        source_cell_id: z.string().uuid(),
        target_cell_id: z.string().uuid(),
        target_input: z.string().min(1),
        expected_revision: z.string().min(1).optional(),
      },
      handler: async (args) => {
        const edge = engine.notebooks.createEdge({
          source: String(args.source_cell_id),
          target: String(args.target_cell_id),
          targetInput: String(args.target_input),
        });
        try {
          const result = await mutateNotebook(
            engine,
            String(args.notebook_id),
            "connect_notebook_cells",
            (notebook) => {
              if (
                typeof args.expected_revision === "string"
                && args.expected_revision !== engine.head
              ) {
                throw new Error(
                  `Stale notebook revision: expected ${args.expected_revision}`,
                );
              }
              const error = notebookConnectionError(
                notebook,
                edge.source,
                edge.target,
                edge.targetInput,
              );
              if (error) throw new Error(error);
              return seedInitialGenerationPrompt({
                ...notebook,
                edges: [...notebook.edges, edge],
              }, edge.target);
            },
            { sourceCellId: edge.source, targetCellId: edge.target, edgeId: edge.id },
          );
          return result.ok ? json(edge) : failure(result.error.message);
        } catch (cause) {
          return failure(cause instanceof Error ? cause.message : String(cause));
        }
      },
    },
    {
      name: "disconnect_notebook_cells",
      description: "Delete a notebook edge",
      scope: "book",
      schema: { ...bookSchema, notebook_id: z.string().uuid(), edge_id: z.string().uuid() },
      handler: async (args) => {
        const edgeId = String(args.edge_id);
        const result = await mutateNotebook(
          engine,
          String(args.notebook_id),
          "disconnect_notebook_cells",
          (notebook) => {
            const removed = notebook.edges.find((edge) => edge.id === edgeId);
            const disconnected = {
              ...notebook,
              edges: notebook.edges.filter((edge) => edge.id !== edgeId),
            };
            return removed
              ? seedInitialGenerationPrompt(disconnected, removed.target)
              : disconnected;
          },
          { edgeId },
        );
        return result.ok ? json({ edge_id: edgeId, revision: result.value.hash }) : failure(result.error.message);
      },
    },
    {
      name: "set_notebook_cell_input",
      description: "Atomically replace or clear one named notebook cell input",
      scope: "book",
      schema: {
        ...bookSchema,
        notebook_id: z.string().uuid(),
        target_cell_id: z.string().uuid(),
        target_input: z.string().min(1),
        source_cell_id: z.string().uuid().nullable(),
        expected_revision: z.string().min(1).optional(),
      },
      handler: async (args) => {
        if (
          typeof args.expected_revision === "string"
          && args.expected_revision !== engine.head
        ) {
          return failure(`Stale notebook revision: expected ${args.expected_revision}`);
        }
        const targetCellId = String(args.target_cell_id);
        const targetInput = String(args.target_input);
        const sourceCellId = typeof args.source_cell_id === "string"
          ? args.source_cell_id
          : null;
        let edgeId: string | null = null;
        try {
          const result = await mutateNotebook(
            engine,
            String(args.notebook_id),
            "set_notebook_cell_input",
            (notebook) => {
              const target = notebook.cells.find((cell) =>
                cell.id === targetCellId);
              if (!target) {
                throw new Error(`Target cell not found: ${targetCellId}`);
              }
              const existing = notebook.edges.filter((edge) =>
                edge.target === targetCellId
                && edge.targetInput === targetInput);
              const retained = notebook.edges.filter((edge) =>
                edge.target !== targetCellId
                || edge.targetInput !== targetInput);
              let edges = retained;
              if (sourceCellId) {
                const error = notebookConnectionError(
                  notebook,
                  sourceCellId,
                  targetCellId,
                  targetInput,
                );
                if (error) throw new Error(error);
                const matching = existing.find((edge) =>
                  edge.source === sourceCellId);
                const edge = matching ?? engine.notebooks.createEdge({
                  source: sourceCellId,
                  target: targetCellId,
                  targetInput,
                });
                edgeId = edge.id;
                edges = [...retained, edge];
              }
              const updated = { ...notebook, edges };
              const marked = markCellAndDescendantsStale(updated, targetCellId);
              return seedInitialGenerationPrompt(marked, targetCellId);
            },
            {
              targetCellId,
              targetInput,
              sourceCellId,
              edgeId,
            },
          );
          return result.ok
            ? json({
                target_cell_id: targetCellId,
                target_input: targetInput,
                source_cell_id: sourceCellId,
                edge_id: edgeId,
                revision: result.value.hash,
              })
            : failure(result.error.message);
        } catch (cause) {
          return failure(cause instanceof Error ? cause.message : String(cause));
        }
      },
    },
    {
      name: "preview_notebook_generation",
      description:
        "Preview the exact provider payload a generation cell would submit, without running it",
      scope: "book",
      schema: {
        ...bookSchema,
        notebook_id: z.string().uuid(),
        cell_id: z.string().uuid(),
        draft: z.object({
          type: cellTypeSchema.optional(),
          label: z.string().optional(),
          slot: notebookGridSlotSchema.optional(),
          prompt: z.string(),
          provider: z.string().min(1),
          model: z.string().min(1),
          operation: z.string().min(1),
          tool: z.string().min(1),
          inputs: z.record(z.string(), z.unknown()).optional(),
        }).optional(),
        connections: z.array(z.object({
          source_cell_id: z.string().uuid(),
          target_input: z.string().min(1),
        })).optional(),
      },
      handler: async (args) => {
        const notebook = engine.notebooks.read(String(args.notebook_id));
        if (!notebook.ok) return failure(notebook.error.message);
        try {
          const draft = args.draft as {
            type?: NotebookCellType;
            label?: string;
            slot?: NotebookGridSlot;
            prompt: string;
            provider: string;
            model: string;
            operation: string;
            tool: string;
            inputs?: Record<string, unknown>;
          } | undefined;
          const cellId = String(args.cell_id);
          const cell = notebook.value.cells.find((candidate) =>
            candidate.id === cellId);
          if (!cell && (!draft?.type || !draft.slot)) {
            return failure("Notebook cell not found");
          }
          const baseCell: NotebookCell = cell ?? {
            id: cellId,
            type: draft!.type!,
            slot: draft!.slot!,
          };
          const previewCell: NotebookCell = draft
            ? { ...baseCell, ...draft, id: cellId }
            : baseCell;
          const connections = args.connections as Array<{
            source_cell_id: string;
            target_input: string;
          }> | undefined;
          const previewWithCell: NotebookDocument = {
            ...notebook.value,
            cells: [
              ...notebook.value.cells.filter((candidate) =>
                candidate.id !== cellId),
              previewCell,
            ],
          };
          const previewNotebook: NotebookDocument = connections
            ? {
                ...previewWithCell,
                edges: [
                  ...notebook.value.edges.filter((edge) =>
                    edge.target !== cellId),
                  ...connections.map((connection) =>
                    engine.notebooks.createEdge({
                      source: connection.source_cell_id,
                      target: cellId,
                      targetInput: connection.target_input,
                    })),
                ],
              }
            : previewWithCell;
          const validation = validateCellConfiguration(
            previewCell,
            previewNotebook,
          );
          if (!validation.ok) return failure(validation.message);
          const prepared = await prepareNotebookGeneration(
            engine,
            previewNotebook,
            previewCell,
            String(args.book_id),
            { allowReferenceIssues: true },
          );
          const promptLeaks = [
            ...prepared.mentions.unresolved.map((reference) => ({
              token: reference.mention,
              code: reference.code,
              message: reference.message,
            })),
            ...prepared.mentions.unconnected.map((reference) => ({
              token: reference.mention,
              code: "not_connected",
              message: reference.message,
            })),
          ];
          const translated = promptLeaks.length === 0
            ? translateToolPayload(
                prepared.tool,
                prepared.input,
                prepared.provider,
              )
            : null;
          const previewPayload = translated
            ? applyPreviewPlaceholderUrls(translated.payload)
            : null;
          const costResult = await estimateCostDef(engine).handler({
            calls: [{
              tool_name: prepared.tool,
              input: prepared.input,
            }],
          });
          const costText = costResult.content.find((item) =>
            item.type === "text")?.text;
          const costValue = !costResult.isError && costText
            ? JSON.parse(costText) as { estimate?: unknown }
            : {};
          return json({
            tool: prepared.tool,
            provider: prepared.provider,
            model: prepared.model,
            ...(translated?.provider_path
              ? { provider_path: translated.provider_path }
              : {}),
            payload: promptLeaks.length > 0
              ? null
              : previewPayload?.payload ?? prepared.input,
            estimate: costValue.estimate ?? null,
            mentions: {
              prompt_leaks: promptLeaks,
              url_placeholders: previewPayload?.placeholders ?? [],
            },
          });
        } catch (cause) {
          return failure(cause instanceof Error ? cause.message : String(cause));
        }
      },
    },
    {
      name: "run_notebook_cell",
      description: "Run one selected notebook cell using saved upstream media",
      scope: "book",
      schema: {
        ...bookSchema,
        notebook_id: z.string().uuid(),
        cell_id: z.string().uuid(),
        plan: z.record(z.string(), z.unknown()).optional(),
        actor: z.string().min(1).optional(),
        expected_revision: z.string().min(1).optional(),
      },
      handler: async (args) => {
        if (
          typeof args.expected_revision === "string"
          && args.expected_revision !== engine.head
        ) {
          return failure(`Stale notebook revision: expected ${args.expected_revision}`);
        }
        const notebook = engine.notebooks.read(String(args.notebook_id));
        if (!notebook.ok) return failure(notebook.error.message);
        const cell = notebook.value.cells.find((candidate) =>
          candidate.id === String(args.cell_id));
        if (!cell) return failure("Notebook cell not found");
        if (!notebookCellIsRunnable(cell)) {
          return failure("Media cells are passive outputs and cannot be run");
        }
        const requestedPlan = args.plan as Record<string, unknown> | undefined;
        let generationPlan: Record<string, unknown> | undefined;
        let generationPlanRecord: NotebookGenerationPlanRecord | undefined;
        if (requestedPlan) {
          const record = notebookGenerationPlans(notebook.value).find((candidate) =>
            candidate.planId === requestedPlan.planId
            && candidate.cellId === cell.id);
          if (!record) return failure("Generation plan is not preserved in this notebook");
          if (record.status !== "planned") {
            return failure(`Generation plan is already ${record.status}`);
          }
          const expected = record.plan.cellDefinitionFingerprint
            ?? record.plan.cellFingerprint;
          const actual = notebookCellDefinitionFingerprint(
            notebook.value,
            cell,
          );
          if (expected !== actual) {
            return failure("Generation plan is stale for the selected cell");
          }
          generationPlan = record.plan;
          generationPlanRecord = record;
        }
        if (notebookCellIsPaid(cell) && !generationPlan) {
          return failure("Paid notebook cells require a persisted generation plan");
        }
        const runId = uuidv7();
        const jobId = `run-notebook-${String(args.notebook_id)}-${String(args.cell_id)}-${runId}`;
        try {
          if (generationPlanRecord) {
            generationPlan = await claimNotebookGenerationPlan(
              engine,
              String(args.notebook_id),
              String(args.cell_id),
              generationPlanRecord.planId,
              runId,
            );
          } else {
            await markNotebookCellQueued(
              engine,
              String(args.notebook_id),
              String(args.cell_id),
              runId,
            );
          }
          const outputCellId = generationPlan
            ? generationPlanClaimOutputCellId(generationPlan)
            : null;
          await queue.enqueue(jobId, {
            type: "run_notebook",
            bookId: String(args.book_id),
            notebookId: String(args.notebook_id),
            cellIds: [String(args.cell_id)],
            force: true,
            runId,
            ...(outputCellId ? { outputCellId } : {}),
            ...(generationPlan
              ? {
                  generationPlan,
                  actor: typeof args.actor === "string" ? args.actor : "videobook-user",
                  jobId,
                }
              : {}),
          });
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          const generationPlanId = typeof generationPlan?.planId === "string"
            ? generationPlan.planId
            : undefined;
          await failQueuedNotebookCells(engine, String(args.notebook_id), {
            cellIds: [String(args.cell_id)],
            runId,
            error: message,
            ...(generationPlanId ? { generationPlanId } : {}),
          }).catch(() => undefined);
          return failure(message);
        }
        const outputCellId = generationPlan
          ? generationPlanClaimOutputCellId(generationPlan)
          : null;
        return json({
          job_id: jobId,
          run_id: runId,
          ...(generationPlan ? { plan_id: generationPlan.planId } : {}),
          ...(outputCellId ? { output_cell_id: outputCellId } : {}),
        });
      },
    },
    {
      name: "run_notebook",
      description: "Run missing, stale, or explicitly selected notebook cells topologically",
      scope: "book",
      schema: {
        ...bookSchema,
        notebook_id: z.string().uuid(),
        cell_ids: z.array(z.string().uuid()).min(1).max(100).optional(),
        actor: z.string().min(1).optional(),
      },
      handler: async (args) => {
        const cellIds = Array.isArray(args.cell_ids)
          ? [...new Set(args.cell_ids.map(String))]
          : undefined;
        if (cellIds) {
          const notebook = engine.notebooks.read(String(args.notebook_id));
          if (!notebook.ok) return failure(notebook.error.message);
          for (const cellId of cellIds) {
            const cell = notebook.value.cells.find((candidate) =>
              candidate.id === cellId);
            if (!cell) return failure(`Notebook cell not found: ${cellId}`);
            if (!notebookCellIsRunnable(cell)) {
              return failure(`Notebook cell ${notebookGridTag(cell.slot)} is not runnable`);
            }
            if (notebookCellIsPaid(cell)) {
              return failure(
                `Paid notebook cell ${notebookGridTag(cell.slot)} requires its own persisted generation plan`,
              );
            }
          }
        }
        const runId = uuidv7();
        const jobId = `run-notebook-${String(args.notebook_id)}-${runId}`;
        try {
          if (cellIds) {
            for (const cellId of cellIds) {
              await markNotebookCellQueued(
                engine,
                String(args.notebook_id),
                cellId,
                runId,
              );
            }
          }
          await queue.enqueue(jobId, {
            type: "run_notebook",
            bookId: String(args.book_id),
            notebookId: String(args.notebook_id),
            runId,
            force: cellIds !== undefined,
            ...(cellIds ? { cellIds } : {}),
            ...(typeof args.actor === "string" ? { actor: args.actor } : {}),
          });
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          await failQueuedNotebookCells(engine, String(args.notebook_id), {
            cellIds: cellIds ?? [],
            runId,
            error: message,
          }).catch(() => undefined);
          return failure(message);
        }
        return json({
          job_id: jobId,
          run_id: runId,
          ...(cellIds ? { cell_ids: cellIds } : {}),
        });
      },
    },
    {
      name: "list_jobs",
      description: "List persistent jobs for a book",
      scope: "book",
      schema: {
        ...bookSchema,
        limit: z.number().int().positive().max(500).optional(),
      },
      handler: async (args) => json(engine.jobs.queue.list({
        limit: Number(args.limit) || 200,
      })),
    },
    {
      name: "cancel_job",
      description: "Cancel a queued or running persistent job",
      scope: "book",
      schema: {
        ...bookSchema,
        job_id: z.number().int().positive(),
        reason: z.string().min(1).max(500).optional(),
      },
      handler: async (args) => {
        const jobId = Number(args.job_id);
        const job = engine.jobs.queue.get(jobId);
        if (!job) return failure(`Job ${jobId} was not found`);
        const cancelled = await engine.jobs.queue.abort(
          jobId,
          typeof args.reason === "string" ? args.reason : "Cancelled by user",
        );
        if (!cancelled) {
          return failure(`Job ${jobId} is already ${job.state}`);
        }
        return json(engine.jobs.queue.get(jobId));
      },
    },
    {
      name: "retry_job",
      description: "Re-enqueue a failed or cancelled persistent job with the same durable payload",
      scope: "book",
      schema: {
        ...bookSchema,
        job_id: z.number().int().positive(),
      },
      handler: async (args) => {
        const jobId = Number(args.job_id);
        const job = engine.jobs.queue.get(jobId);
        if (!job) return failure(`Job ${jobId} was not found`);
        if (job.state !== "failed" && job.state !== "aborted") {
          return failure(`Job ${jobId} is ${job.state}, not retryable`);
        }
        const retryId = `retry-${job.type}-${uuidv7()}`;
        await queue.enqueue(retryId, {
          ...job.payload,
          type: job.type,
          bookId: engine.book.get().bookId,
        });
        return json({ status: "enqueued", retry_job_id: retryId, source_job_id: jobId });
      },
    },
    {
      name: "list_book_actions",
      description: "List authored semantic revisions for a book",
      scope: "book",
      schema: { ...bookSchema, limit: z.number().int().positive().max(10_000).optional(), cursor: z.string().optional() },
      handler: async (args) => {
        const limit = typeof args.limit === "number" ? args.limit : 100;
        return json({
          actions: engine.history.revisions(limit),
          nextCursor: null,
        });
      },
    },
    {
      name: "get_history_action",
      description: "Read one authored semantic revision",
      scope: "book",
      schema: { ...bookSchema, action_id: z.string().min(1) },
      handler: async (args) => {
        const revision = engine.history.resolveRevision(String(args.action_id));
        return revision
          ? json(revision)
          : failure(`Revision not found: ${String(args.action_id)}`);
      },
    },
    {
      name: "storage_status",
      description: "Read catalog and object publication status",
      scope: "book",
      schema: bookSchema,
      handler: async () => json(engine.storage.status()),
    },
    {
      name: "storage_sync",
      description: "Publish a book's pending content-addressed objects and catalog",
      scope: "book",
      schema: bookSchema,
      handler: async () => json(await engine.storage.backup()),
    },
    ...entityDefs(engine, "prompt"),
    ...entityDefs(engine, "scene"),
    ...entityDefs(engine, "character"),
  ];
}
