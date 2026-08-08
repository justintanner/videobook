import type {
  CellHistoryEntry,
  Engine,
  ExecutionHistoryEntry,
  NotebookCell,
  NotebookDocument,
} from "videobook-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";
import { findGenerateVideoOutput } from "../notebook-cell-outputs.js";
import { buildAssetList } from "./sync.js";

type GenerationAttempt = {
  attemptId: string;
  status: string | null;
  runId: string | null;
  commitHash: string | null;
  operation: string | null;
  commitDate: string | null;
  prompt: string | null;
  resolvedPrompt: string | null;
  model: string | null;
  tool: string | null;
  provider: string | null;
  artifactId: string | null;
  providerArtifactId: string | null;
  error: string | null;
  mediaUrl: string | null;
  thumbnailUrl: string | null;
  payload: unknown;
  commandPlan: unknown;
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function versionArtifactIds(cell: NotebookCell | undefined): string[] {
  if (!cell) return [];
  const raw = cell.inputs?.outputVersionArtifactIds;
  if (!Array.isArray(raw)) return [];
  return raw.filter((id): id is string => typeof id === "string" && id.length > 0);
}

function pairForCell(
  document: NotebookDocument,
  cellId: string,
): { generateCell: NotebookCell; outputCell: NotebookCell | null } {
  const cell = document.cells.find((candidate) => candidate.id === cellId);
  if (!cell) throw new Error(`Cell not found: ${cellId}`);
  if (cell.type === "generate_video") {
    const output = findGenerateVideoOutput(document, cell.id);
    return { generateCell: cell, outputCell: output?.outputCell ?? null };
  }
  if (cell.type === "video") {
    const producerEdge = document.edges.find((edge) =>
      edge.target === cell.id && edge.targetInput === "output");
    const producer = producerEdge
      ? document.cells.find((candidate) => candidate.id === producerEdge.source)
      : undefined;
    if (producer?.type === "generate_video") {
      return { generateCell: producer, outputCell: cell };
    }
  }
  return { generateCell: cell, outputCell: null };
}

function attemptKey(parts: {
  runId: string | null;
  providerArtifactId: string | null;
  artifactId: string | null;
  commitHash: string | null;
}): string {
  return (
    parts.runId
    ?? parts.providerArtifactId
    ?? parts.artifactId
    ?? parts.commitHash
    ?? "unknown"
  );
}

function historyPrompt(entry: CellHistoryEntry): {
  prompt: string | null;
  resolvedPrompt: string | null;
  model: string | null;
  tool: string | null;
  provider: string | null;
  providerArtifactId: string | null;
  artifactId: string | null;
} {
  const inputs = entry.cell.inputs ?? {};
  return {
    prompt: asString(entry.cell.prompt),
    resolvedPrompt: asString(inputs.resolvedPrompt) ?? asString(entry.cell.prompt),
    model: asString(entry.cell.model),
    tool: asString(entry.cell.tool) ?? asString(entry.cell.model),
    provider: asString(entry.cell.provider),
    providerArtifactId: asString(inputs.providerArtifactId),
    artifactId: asString(entry.cell.outputArtifactId) ?? asString(entry.artifactId),
  };
}

function groupAttempts(
  cellHistories: CellHistoryEntry[],
  executionHistories: ExecutionHistoryEntry[],
  limit: number,
): Array<{
  key: string;
  status: string | null;
  runId: string | null;
  commitHash: string | null;
  operation: string | null;
  commitDate: string | null;
  prompt: string | null;
  resolvedPrompt: string | null;
  model: string | null;
  tool: string | null;
  provider: string | null;
  artifactId: string | null;
  providerArtifactId: string | null;
  error: string | null;
}> {
  const byKey = new Map<string, {
    key: string;
    status: string | null;
    runId: string | null;
    commitHash: string | null;
    operation: string | null;
    commitDate: string | null;
    prompt: string | null;
    resolvedPrompt: string | null;
    model: string | null;
    tool: string | null;
    provider: string | null;
    artifactId: string | null;
    providerArtifactId: string | null;
    error: string | null;
    sortDate: string;
  }>();

  for (const entry of executionHistories) {
    const runId = asString(entry.execution.runId);
    const providerArtifactId = asString(entry.execution.providerArtifactId);
    const artifactId = asString(entry.execution.outputArtifactId)
      ?? asString(entry.artifactId);
    const key = attemptKey({
      runId,
      providerArtifactId,
      artifactId,
      commitHash: entry.commitHash,
    });
    const existing = byKey.get(key);
    if (existing && existing.sortDate >= entry.commitDate) continue;
    byKey.set(key, {
      key,
      status: asString(entry.execution.status),
      runId,
      commitHash: entry.commitHash,
      operation: asString(entry.operation),
      commitDate: entry.commitDate,
      prompt: null,
      resolvedPrompt: null,
      model: null,
      tool: asString(entry.execution.tool),
      provider: null,
      artifactId,
      providerArtifactId,
      error: asString(entry.execution.error),
      sortDate: entry.commitDate,
    });
  }

  for (const entry of cellHistories) {
    const meta = historyPrompt(entry);
    const key = attemptKey({
      runId: asString(entry.details?.runId),
      providerArtifactId: meta.providerArtifactId,
      artifactId: meta.artifactId,
      commitHash: entry.commitHash,
    });
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        key,
        status: asString(entry.details?.status) ?? null,
        runId: asString(entry.details?.runId),
        commitHash: entry.commitHash,
        operation: asString(entry.operation),
        commitDate: entry.commitDate,
        prompt: meta.prompt,
        resolvedPrompt: meta.resolvedPrompt,
        model: meta.model,
        tool: meta.tool,
        provider: meta.provider,
        artifactId: meta.artifactId,
        providerArtifactId: meta.providerArtifactId,
        error: asString(entry.details?.error),
        sortDate: entry.commitDate,
      });
      continue;
    }
    if (!existing.prompt) existing.prompt = meta.prompt;
    if (!existing.resolvedPrompt) existing.resolvedPrompt = meta.resolvedPrompt;
    if (!existing.model) existing.model = meta.model;
    if (!existing.tool) existing.tool = meta.tool;
    if (!existing.provider) existing.provider = meta.provider;
    if (!existing.artifactId) existing.artifactId = meta.artifactId;
    if (!existing.providerArtifactId) {
      existing.providerArtifactId = meta.providerArtifactId;
    }
    if (!existing.operation) existing.operation = asString(entry.operation);
    if (!existing.commitHash || entry.commitDate >= existing.sortDate) {
      existing.commitHash = entry.commitHash;
      existing.commitDate = entry.commitDate;
      existing.sortDate = entry.commitDate;
    }
  }

  return [...byKey.values()]
    .sort((left, right) => right.sortDate.localeCompare(left.sortDate))
    .slice(0, limit)
    .map(({ sortDate: _sortDate, ...rest }) => rest);
}

export function listCellGenerationsDef(fs: Engine): ToolDef {
  return {
    name: "list_cell_generations",
    description:
      "List attributable generation attempts for a notebook cell from Dolt history (commits, prompts, models, artifacts, payloads).",
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
        const read = fs.notebooks.read(notebook_id);
        if (!read.ok) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: read.error.message }],
          };
        }
        const document = read.value;
        const { generateCell, outputCell } = pairForCell(document, cell_id);
        const historyLimit = Math.max(limit * 4, 40);
        const cellIds = [
          generateCell.id,
          ...(outputCell ? [outputCell.id] : []),
        ];
        const cellHistories = cellIds.flatMap((id) =>
          fs.notebooks.cellHistory(notebook_id, id, { limit: historyLimit }));
        const executionHistories = cellIds.flatMap((id) =>
          fs.notebooks.executionHistory(notebook_id, id, {
            limit: historyLimit,
          }));
        const grouped = groupAttempts(cellHistories, executionHistories, limit);
        const assets = await buildAssetList(fs, book_id);
        const assetById = new Map(
          assets.map((asset) => [asset.artifact_id, asset]),
        );

        const attempts: GenerationAttempt[] = [];
        for (const group of grouped) {
          const artifactId = group.artifactId ?? group.providerArtifactId;
          const asset = artifactId ? assetById.get(artifactId) : undefined;
          let payload: unknown = null;
          let commandPlan: unknown = null;
          if (artifactId) {
            const payloadRes = await fs.metadata.artifacts.read<unknown>(
              artifactId,
              "generation-payload",
            );
            if (payloadRes.ok) {
              payload = include_payloads ? payloadRes.value : { present: true };
            }
            const planRes = await fs.metadata.artifacts.read<unknown>(
              artifactId,
              "command-plan",
            );
            if (planRes.ok) commandPlan = planRes.value;
          }
          let error = group.error;
          if (!error && artifactId) {
            const failRes = await fs.jobs.failures.read(artifactId);
            if (failRes.ok && failRes.value) error = failRes.value.message;
          }
          attempts.push({
            attemptId: group.key,
            status: group.status,
            runId: group.runId,
            commitHash: group.commitHash,
            operation: group.operation,
            commitDate: group.commitDate,
            prompt: group.prompt,
            resolvedPrompt: group.resolvedPrompt,
            model: group.model,
            tool: group.tool,
            provider: group.provider,
            artifactId: group.artifactId,
            providerArtifactId: group.providerArtifactId,
            error,
            mediaUrl: asset?.media_url ?? null,
            thumbnailUrl: asset?.thumbnail_url ?? null,
            payload,
            commandPlan,
          });
        }

        const currentExecution = document.execution?.[generateCell.id]
          ?? (outputCell ? document.execution?.[outputCell.id] : null)
          ?? null;
        const generationPlans = (document.generationPlans ?? []).filter(
          (plan) => plan.cellId === generateCell.id
            || (outputCell ? plan.cellId === outputCell.id : false),
        );
        const artifactIds = [
          ...versionArtifactIds(generateCell),
          ...versionArtifactIds(outputCell ?? undefined),
          ...(generateCell.outputArtifactId
            ? [generateCell.outputArtifactId]
            : []),
          ...(outputCell?.outputArtifactId ? [outputCell.outputArtifactId] : []),
          ...(currentExecution?.outputArtifactId
            ? [currentExecution.outputArtifactId]
            : []),
        ];
        const uniqueArtifactIds = [...new Set(artifactIds)];

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              notebookId: notebook_id,
              cellId: cell_id,
              generateCellId: generateCell.id,
              outputCellId: outputCell?.id ?? null,
              attempts,
              currentExecution,
              generationPlans,
              generations: {
                count: Math.max(attempts.length, uniqueArtifactIds.length),
                latestStatus: currentExecution?.status
                  ?? attempts[0]?.status
                  ?? null,
                artifactIds: uniqueArtifactIds,
              },
            }),
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
