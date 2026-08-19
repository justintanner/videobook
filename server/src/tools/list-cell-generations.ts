import type {
  Engine,
  Generation,
  GenerationStatus,
  NotebookCell,
  NotebookCellExecution,
  NotebookDocument,
  NotebookGenerationPlan,
} from "videobook-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";
import {
  findGenerateAudioOutput,
  findGenerateImageOutput,
  findGenerateVideoOutput,
} from "../notebook-cell-outputs.js";
import { buildAssetList } from "./reconcile-project-work.js";

type CellGenerationTransition = {
  status: GenerationStatus;
  commitHash: string;
  commitDate: string;
};

type CellGenerationAttempt = {
  attemptId: string;
  status: GenerationStatus;
  runId: string | null;
  tool: string;
  provider: string | null;
  model: string | null;
  prompt: string | null;
  resolvedPrompt: string | null;
  artifactId: string | null;
  providerArtifactId: string | null;
  error: string | null;
  mediaUrl: string | null;
  thumbnailUrl: string | null;
  payloadAvailable: boolean;
  payload?: unknown;
  commandPlan: unknown;
  transitions: CellGenerationTransition[];
  createdAt: number;
  updatedAt: number;
};

type CellGenerationsSummary = {
  count: number;
  latestStatus: GenerationStatus | null;
  artifactIds: string[];
};

export type ListCellGenerationsResponse = {
  notebookId: string;
  cellId: string;
  generateCellId: string;
  outputCellId: string | null;
  attempts: CellGenerationAttempt[];
  currentExecution: NotebookCellExecution | null;
  generationPlans: NotebookGenerationPlan[];
  generations: CellGenerationsSummary;
};

function generationArtifactIds(
  generations: readonly Generation[],
): string[] {
  return [...new Set(
    generations.flatMap((row) => [
      ...(row.outputArtifactId ? [row.outputArtifactId] : []),
      ...(row.providerArtifactId ? [row.providerArtifactId] : []),
    ]),
  )];
}

export function pairForCell(
  document: NotebookDocument,
  cellId: string,
): { generateCell: NotebookCell; outputCell: NotebookCell | null } {
  const cell = document.cells.find((candidate) => candidate.id === cellId);
  if (!cell) throw new Error(`Cell not found: ${cellId}`);
  if (cell.type === "generate_video") {
    const output = findGenerateVideoOutput(document, cell.id);
    return { generateCell: cell, outputCell: output?.outputCell ?? null };
  }
  if (cell.type === "generate_image") {
    const output = findGenerateImageOutput(document, cell.id);
    return { generateCell: cell, outputCell: output?.outputCell ?? null };
  }
  if (cell.type === "generate_audio") {
    const output = findGenerateAudioOutput(document, cell.id);
    return { generateCell: cell, outputCell: output?.outputCell ?? null };
  }
  if (cell.type === "video") {
    const producerEdge = document.edges.find((edge) =>
      edge.target === cell.id
      && (edge.targetInput === "output" || edge.targetInput === "media"));
    const producer = producerEdge
      ? document.cells.find((candidate) => candidate.id === producerEdge.source)
      : undefined;
    if (producer?.type === "generate_video") {
      return { generateCell: producer, outputCell: cell };
    }
  }
  if (cell.type === "image") {
    const producerEdge = document.edges.find((edge) =>
      edge.target === cell.id
      && (edge.targetInput === "media" || edge.targetInput === "output"));
    const producer = producerEdge
      ? document.cells.find((candidate) => candidate.id === producerEdge.source)
      : undefined;
    if (producer?.type === "generate_image") {
      return { generateCell: producer, outputCell: cell };
    }
  }
  if (cell.type === "audio") {
    const producerEdge = document.edges.find((edge) =>
      edge.target === cell.id
      && (edge.targetInput === "media" || edge.targetInput === "output"));
    const producer = producerEdge
      ? document.cells.find((candidate) => candidate.id === producerEdge.source)
      : undefined;
    if (producer?.type === "generate_audio") {
      return { generateCell: producer, outputCell: cell };
    }
  }
  return { generateCell: cell, outputCell: null };
}

const TRANSITION_SCAN_LIMIT = 500;

function generationTransitions(
  engine: Engine,
  generations: readonly Generation[],
): Map<string, CellGenerationTransition[]> {
  const wanted = new Set(generations.map((row) => row.generationId));
  const transitions = new Map<string, CellGenerationTransition[]>();
  if (wanted.size === 0) return transitions;
  for (const revision of engine.history.revisions(TRANSITION_SCAN_LIMIT)) {
    const details = revision.details ?? {};
    const generationId = typeof details.generationId === "string"
      ? details.generationId
      : null;
    if (!generationId || !wanted.has(generationId)) continue;
    const status = typeof details.status === "string" ? details.status : null;
    if (!status) continue;
    const entries = transitions.get(generationId) ?? [];
    entries.push({
      status: status as GenerationStatus,
      commitHash: revision.hash,
      commitDate: revision.date,
    });
    transitions.set(generationId, entries);
  }
  for (const entries of transitions.values()) entries.reverse();
  return transitions;
}

export function listCellGenerationsDef(engine: Engine): ToolDef {
  return {
    name: "list_cell_generations",
    description:
      "List recorded generation attempts for a notebook cell: one attempt per dispatch, each with its per-attempt transition timeline.",
    schema: {
      book_id: z.string().describe("Book id"),
      notebook_id: z.string().describe("Notebook id"),
      cell_id: z.string().describe("Cell id (generate or output cell)"),
      include_payloads: z.boolean().optional()
        .describe("Include full generation-payload bodies (default false)"),
      limit: z.number().int().positive().max(100).optional()
        .describe("Max attempts to return (default 20)"),
    },
    handler: async (args) => {
      try {
        const {
          book_id,
          notebook_id,
          cell_id,
          include_payloads = false,
          limit = 20,
        } = args as {
          book_id: string;
          notebook_id: string;
          cell_id: string;
          include_payloads?: boolean;
          limit?: number;
        };
        const read = engine.notebooks.read(notebook_id);
        if (!read.ok) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: read.error.message }],
          };
        }
        const document = read.value;
        const { generateCell, outputCell } = pairForCell(document, cell_id);
        const generationsResult = engine.generations.listForCell(
          notebook_id,
          generateCell.id,
          { limit },
        );
        if (!generationsResult.ok) {
          return {
            isError: true,
            content: [{
              type: "text" as const,
              text: generationsResult.error.message,
            }],
          };
        }
        const rows = generationsResult.value;
        const transitions = generationTransitions(engine, rows);
        const assets = await buildAssetList(engine, book_id);
        const assetById = new Map(
          assets.map((asset) => [asset.artifact_id, asset]),
        );

        const attempts: CellGenerationAttempt[] = [];
        for (const row of rows) {
          const joinArtifactId = row.outputArtifactId
            ?? row.providerArtifactId
            ?? null;
          const asset = joinArtifactId
            ? assetById.get(joinArtifactId)
            : undefined;
          let payloadAvailable = false;
          let payload: unknown = null;
          let commandPlan: unknown = null;
          if (joinArtifactId) {
            const payloadRes = await engine.metadata.artifacts.read<unknown>(
              joinArtifactId,
              "generation-payload",
            );
            if (payloadRes.ok) {
              payloadAvailable = true;
              payload = payloadRes.value;
            }
            const planRes = await engine.metadata.artifacts.read<unknown>(
              joinArtifactId,
              "command-plan",
            );
            if (planRes.ok) commandPlan = planRes.value;
          }
          let error = row.error ?? null;
          if (!error && joinArtifactId) {
            const failRes = await engine.jobs.failures.read(joinArtifactId);
            if (failRes.ok && failRes.value) error = failRes.value.message;
          }
          attempts.push({
            attemptId: row.generationId,
            status: row.status,
            runId: row.runId ?? null,
            tool: row.tool,
            provider: row.provider ?? null,
            model: row.model ?? null,
            prompt: row.prompt ?? null,
            resolvedPrompt: row.resolvedPrompt ?? null,
            artifactId: row.outputArtifactId ?? null,
            providerArtifactId: row.providerArtifactId ?? null,
            error,
            mediaUrl: asset?.media_url ?? null,
            thumbnailUrl: asset?.thumbnail_url ?? null,
            payloadAvailable,
            ...(include_payloads ? { payload } : {}),
            commandPlan,
            transitions: transitions.get(row.generationId) ?? [],
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          });
        }

        const currentExecution = document.execution?.[generateCell.id]
          ?? (outputCell ? document.execution?.[outputCell.id] : null)
          ?? null;
        const generationPlans = (document.generationPlans ?? []).filter(
          (plan) => plan.cellId === generateCell.id
            || (outputCell ? plan.cellId === outputCell.id : false),
        );

        const response: ListCellGenerationsResponse = {
          notebookId: notebook_id,
          cellId: cell_id,
          generateCellId: generateCell.id,
          outputCellId: outputCell?.id ?? null,
          attempts,
          currentExecution,
          generationPlans,
          generations: {
            count: rows.length,
            latestStatus: rows[0]?.status ?? null,
            artifactIds: generationArtifactIds(rows),
          },
        };
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(response),
          }],
        };
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        return {
          isError: true,
          content: [{ type: "text" as const, text: message }],
        };
      }
    },
  };
}
