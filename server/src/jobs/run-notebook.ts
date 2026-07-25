import { createHash } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import type {
  Engine,
  NotebookCell,
  NotebookDocument,
  NotebookRun,
} from "videobook-engine";
import { mutateNotebook } from "../notebook-mutations.js";
import { registerJobHandler } from "../queue.js";
import type { ToolDef, ToolResult } from "../tools/tool-def.js";
import { getActionSpec } from "../generation-registry.js";

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
  video: "generate_kie_wan_2_7_text_to_video",
};

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
    model: cell.model ?? defaultNotebookGenerationModel[cell.type as "image" | "video"] ?? "",
    inputs: cell.inputs ?? {},
    upstream: upstreamValues(document, cell).map(({ targetInput, cell: source, output }) => ({
      targetInput,
      sourceId: source.id,
      sourceType: source.type,
      prompt: source.prompt ?? "",
      output: output ?? null,
    })),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function promptFor(document: NotebookDocument, cell: NotebookCell): string {
  const upstream = upstreamValues(document, cell)
    .filter(({ cell: source }) => source.type === "prompt")
    .map(({ cell: source }) => source.prompt ?? "")
    .filter(Boolean);
  return [cell.prompt ?? "", ...upstream].filter(Boolean).join("\n\n").trim();
}

function modelArgs(
  definition: ToolDef,
  document: NotebookDocument,
  cell: NotebookCell,
  bookId: string,
): Record<string, unknown> {
  const args: Record<string, unknown> = {
    ...(cell.inputs ?? {}),
    book_id: bookId,
    prompt: promptFor(document, cell),
  };
  const imageReferences = upstreamValues(document, cell)
    .filter(({ cell: source, output }) => source.type === "image" && typeof output === "string")
    .map(({ output }) => `@${output}`);
  if ("image_slugs" in definition.schema && imageReferences.length > 0) {
    args.image_slugs = imageReferences;
  }
  if ("image_slug" in definition.schema && imageReferences[0]) {
    args.image_slug = imageReferences[0];
  }
  return args;
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
  const tool = cell.model
    || defaultNotebookGenerationModel[cell.type as "image" | "video"];
  if (!tool) throw new Error(`No generation model for ${cell.type} cell ${cell.id}`);
  const { getAllToolDefs } = await import("../tools/index.js");
  const definition = getAllToolDefs(engine).find((candidate) => candidate.name === tool);
  if (!definition) throw new Error(`Unknown notebook generation model: ${tool}`);
  const parsed = z.object(definition.schema).safeParse(
    modelArgs(definition, document, cell, bookId),
  );
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  const spec = getActionSpec(tool);
  return {
    tool,
    provider: spec?.provider ?? "unknown",
    model: spec?.apicity_identifier ?? tool,
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

async function runCell(
  engine: Engine,
  bookId: string,
  notebookId: string,
  document: NotebookDocument,
  cell: NotebookCell,
): Promise<{ document: NotebookDocument; outputArtifactId: string }> {
  const nextFingerprint = fingerprint(document, cell);
  try {
    const output = await generationTool(engine, document, cell, bookId);
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
      (current) => withExecution(current, cell.id, state, output.artifactId),
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
      tool: cell.model
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

export function registerRunNotebookJob(engine: Engine): void {
  registerJobHandler("run_notebook", async (payload) => {
    const input = payload as unknown as RunNotebookPayload;
    const initial = engine.notebooks.read(input.notebookId);
    if (!initial.ok) throw new Error(initial.error.message);
    const selected = input.cellIds ? new Set(input.cellIds) : null;
    let document = initial.value;
    const ordered = topologicalOrder(document);
    const outputs: Record<string, string> = {};
    const errors: string[] = [];
    for (const cell of ordered) {
      if (cell.type !== "image" && cell.type !== "video") {
        const output = cell.outputArtifactId ?? cell.entityId;
        if (output) outputs[cell.id] = output;
        continue;
      }
      if (selected && !selected.has(cell.id)) continue;
      const execution = executionState(document)[cell.id];
      const stale = !execution
        || execution.fingerprint !== fingerprint(document, cell)
        || Boolean(execution.error)
        || !cell.outputArtifactId
        || !engine.artifacts.get(cell.outputArtifactId).ok;
      if (!input.force && !stale) {
        if (cell.outputArtifactId) outputs[cell.id] = cell.outputArtifactId;
        continue;
      }
      try {
        const result = await runCell(engine, input.bookId, input.notebookId, document, cell);
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
