import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import type { Engine } from "videobook-engine";
import { notebookOccupiedSlots, NOTEBOOK_GRID_CAPACITY } from "videobook-engine/notebook-grid";
import type { ToolDef, ToolResult } from "./tools/tool-def.js";
import { queue, waitForJob } from "./queue.js";
import { placeChainGeneration } from "./chain-generation.js";
import { buildChainStepReview, type ChainStepReview } from "./chain-step-review.js";
import type { AwaitNotebookOutputPayload } from "./jobs/run-notebook.js";
import { failNotebookProviderOutput } from "./jobs/run-notebook.js";
import {
  preflightChainPlan,
  revalidatePinnedTargets,
  substituteChainRefs,
  supportedChainTool,
  type ChainPreflightContext,
  type ChainPreflightPlan,
  type ChainPlacementKind,
  type ChainPreflightStep,
  type PinnedChainTarget,
} from "./chain-plan.js";

const SETTINGS_KEY = "application.chain-runs.v1";
const STEP_TIMEOUT_MS = 180_000;
// Provider generation is minutes, not seconds; matches awaitNotebookOutput's own budget.
const GENERATION_STEP_TIMEOUT_MS = 45 * 60_000;
const POLL_MS = 50;

type ChainStepStatus =
  | "pending"
  | "awaiting-approval"
  | "approved"
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "rejected"
  | "interrupted"
  | "cancelled";

type ChainRunStatus =
  | "accepted"
  | "running"
  | "awaiting-approval"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type ChainApprovalActor = "chat" | "voice" | "api";

type ChainStepApproval = {
  approvedAt: string;
  actor: ChainApprovalActor;
  estimateUsd: number | null;
  estimateUnavailable: boolean;
};

type ChainStepRecord = {
  id: string;
  tool: string;
  params: Record<string, unknown>;
  status: ChainStepStatus;
  outputs: Record<string, unknown> | null;
  error: string | null;
  childJobIds: string[];
  pins: PinnedChainTarget[];
  autoApply: boolean;
  effect: "read" | "mutation" | "generation";
  requiresApproval: boolean;
  approval: ChainStepApproval | null;
  review: ChainStepReview | null;
  startedAt?: string | null;
};

export type ChainRunRecord = {
  kind: "chain-run";
  chainId: string;
  bookId: string;
  notebookId: string | null;
  requestId: string | null;
  fingerprint: string;
  status: ChainRunStatus;
  steps: ChainStepRecord[];
  createdAt: string;
  updatedAt: string;
  error: string | null;
  autoApply: boolean;
  effect: "read" | "mutation" | "generation";
  awaitingStepId: string | null;
};

type ChainStore = {
  runs: Record<string, ChainRunRecord>;
  requestIndex: Record<string, string>;
};

type ToolLookup = (name: string) => ToolDef | undefined;

const inflight = new Map<string, AbortController>();

function emptyStore(): ChainStore {
  return { runs: {}, requestIndex: {} };
}

function readStore(engine: Engine): ChainStore {
  const parsed = engine.settings.get<Partial<ChainStore>>(SETTINGS_KEY);
  if (!parsed || typeof parsed !== "object") return emptyStore();
  return {
    runs: parsed.runs && typeof parsed.runs === "object" ? parsed.runs : {},
    requestIndex: parsed.requestIndex && typeof parsed.requestIndex === "object"
      ? parsed.requestIndex
      : {},
  };
}

function writeStore(engine: Engine, store: ChainStore): void {
  const written = engine.settings.set(SETTINGS_KEY, store);
  if (!written.ok) throw new Error(written.error.message);
}

function requestKey(bookId: string, requestId: string): string {
  return `${bookId}:${requestId}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isClosedDatabaseError(error: unknown): boolean {
  return error instanceof Error && /database is closed/i.test(error.message);
}

function saveRun(engine: Engine, run: ChainRunRecord): ChainRunRecord {
  try {
    const store = readStore(engine);
    store.runs[run.chainId] = run;
    if (run.requestId) {
      store.requestIndex[requestKey(run.bookId, run.requestId)] = run.chainId;
    }
    writeStore(engine, store);
  } catch (error) {
    if (isClosedDatabaseError(error)) return run;
    throw error;
  }
  return run;
}

export function getChainRun(engine: Engine, chainId: string): ChainRunRecord | null {
  return readStore(engine).runs[chainId] ?? null;
}

function findChainRunByRequestId(
  engine: Engine,
  bookId: string,
  requestId: string,
): ChainRunRecord | null {
  const store = readStore(engine);
  const chainId = store.requestIndex[requestKey(bookId, requestId)];
  return chainId ? store.runs[chainId] ?? null : null;
}

function isTerminal(status: ChainRunStatus): boolean {
  return status === "completed"
    || status === "failed"
    || status === "cancelled"
    || status === "interrupted";
}

/** Terminal, or parked waiting on a person. Either way nothing is running. */
function isSettled(status: ChainRunStatus): boolean {
  return isTerminal(status) || status === "awaiting-approval";
}

function parseJsonResult(result: ToolResult): Record<string, unknown> {
  const text = result.content.find((entry) => entry.type === "text")?.text ?? "";
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { value: parsed };
  } catch {
    return { text };
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Cancelled"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error("Cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitWhile(
  signal: AbortSignal,
  timeoutMs: number,
  pending: () => boolean | Promise<boolean>,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (await pending()) {
    if (signal.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("Cancelled");
    }
    if (Date.now() >= deadline) {
      throw new Error(`${label} timed out after ${timeoutMs}ms`);
    }
    await delay(POLL_MS, signal);
  }
}

async function waitForNamedJob(
  jobId: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  const wait = waitForJob(jobId, timeoutMs);
  const abort = new Promise<never>((_, reject) => {
    const fail = () => {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Cancelled"));
    };
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
  await Promise.race([wait, abort]);
}

async function waitForInternalJobs(
  engine: Engine,
  jobIds: number[],
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  await waitWhile(signal, timeoutMs, () => {
    return jobIds.some((id) => {
      const job = engine.jobs.queue.get(id);
      return job !== null && (
        job.state === "queued"
        || job.state === "running"
        || job.state === "completing"
      );
    });
  }, "Child job");
  for (const id of jobIds) {
    const job = engine.jobs.queue.get(id);
    if (job?.state === "failed" || job?.state === "aborted") {
      throw new Error(job.error?.message ?? `Job ${id} ${job.state}`);
    }
  }
}

async function fileExists(
  engine: Engine,
  artifactId: string,
  filename: string,
): Promise<boolean> {
  const manifest = await engine.files.manifest(artifactId);
  return manifest.ok && manifest.value.files.some((file) => file.name === filename);
}

function applyPins(
  params: Record<string, unknown>,
  pins: readonly PinnedChainTarget[],
): Record<string, unknown> {
  const next = { ...params };
  for (const pin of pins) {
    const index = pin.index ?? null;
    if (index === null) {
      if (typeof next[pin.field] === "string") next[pin.field] = pin.artifactId;
      continue;
    }
    const current = next[pin.field];
    if (!Array.isArray(current) || typeof current[index] !== "string") continue;
    const replaced = [...current];
    replaced[index] = pin.artifactId;
    next[pin.field] = replaced;
  }
  return next;
}

async function waitForFile(
  engine: Engine,
  artifactId: string,
  filename: string,
  signal: AbortSignal,
  label: string,
): Promise<void> {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  while (!(await fileExists(engine, artifactId, filename))) {
    if (signal.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("Cancelled");
    }
    if (Date.now() >= deadline) {
      throw new Error(`${label} finished without ${filename}`);
    }
    await delay(POLL_MS, signal);
  }
}

async function completeExtractAudio(
  engine: Engine,
  outputs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const jobId = typeof outputs.job_id === "string" ? outputs.job_id : null;
  const audioAssetId = typeof outputs.audio_asset_id === "string"
    ? outputs.audio_asset_id
    : null;
  if (jobId) await waitForNamedJob(jobId, signal, STEP_TIMEOUT_MS);
  if (!audioAssetId) {
    throw new Error("extract_audio did not return audio_asset_id");
  }
  await waitForFile(engine, audioAssetId, "original.mp3", signal, "extract_audio");
  return { ...outputs, status: "completed" };
}

async function completeReplaceVideoAudio(
  engine: Engine,
  assetId: string,
  beforeIds: Set<number>,
  outputs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const after = engine.jobs.queue.list({
    type: "process_video",
    artifactId: assetId,
  });
  const newIds = after
    .filter((job) => !beforeIds.has(job.id))
    .map((job) => job.id);
  if (newIds.length > 0) {
    await waitForInternalJobs(engine, newIds, signal, STEP_TIMEOUT_MS);
  }
  await waitWhile(signal, STEP_TIMEOUT_MS, () => {
    return engine.jobs.queue.list({
      type: "process_video",
      artifactId: assetId,
      states: ["queued", "running", "completing"],
    }).length > 0;
  }, "replace_video_audio preview");
  await waitForFile(engine, assetId, "proxy.mp4", signal, "replace_video_audio");
  return { ...outputs, status: "completed" };
}

async function completeExtractFrame(
  engine: Engine,
  outputs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const jobId = typeof outputs.job_id === "string" ? outputs.job_id : null;
  const imageAssetId = typeof outputs.image_asset_id === "string"
    ? outputs.image_asset_id
    : null;
  if (jobId) await waitForNamedJob(jobId, signal, STEP_TIMEOUT_MS);
  if (!imageAssetId) {
    throw new Error("extract_frame did not return image_asset_id");
  }
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  while (true) {
    const manifest = await engine.files.manifest(imageAssetId);
    const ready = manifest.ok && manifest.value.files.some((file) =>
      file.name.startsWith("original."));
    if (ready) break;
    if (signal.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("Cancelled");
    }
    if (Date.now() >= deadline) {
      throw new Error("extract_frame finished without an image file");
    }
    await delay(POLL_MS, signal);
  }
  return { ...outputs, status: "completed" };
}

type GenerationCompletionContext = {
  bookId: string;
  notebookId: string | null;
  chainId: string;
  stepId: string;
  tool: string;
  placement: ChainPlacementKind;
  artifactOutput: string;
  params: Record<string, unknown>;
  pins: readonly PinnedChainTarget[];
};

/**
 * A generation handler returns as soon as the provider job is submitted, and the
 * artifact it names is not on the grid and not yet usable. Place it the way a
 * notebook run would, then wait for the same settlement job the notebook uses.
 */
async function completeGeneration(
  engine: Engine,
  context: GenerationCompletionContext,
  outputs: Record<string, unknown>,
  signal: AbortSignal,
  onPlaced: (outputs: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  const artifactId = outputs[context.artifactOutput];
  if (typeof artifactId !== "string") {
    throw new Error(`${context.tool} did not return ${context.artifactOutput}`);
  }
  const submission = outputs.job_id;
  const runId = `${context.chainId}:${context.stepId}`;
  if (!context.notebookId) {
    if (typeof submission === "string") await waitForNamedJob(submission, signal, STEP_TIMEOUT_MS);
    await waitWhile(signal, GENERATION_STEP_TIMEOUT_MS, async () => {
      const status = await engine.status.get(artifactId);
      if (!status.ok) throw new Error(status.error.message);
      if (status.value === "error") throw new Error(`${context.tool} failed`);
      return status.value !== "ready";
    }, context.tool);
    return { ...outputs, asset_id: artifactId, status: "completed" };
  }
  const placement = await placeChainGeneration({
    engine,
    notebookId: context.notebookId,
    tool: context.tool,
    placement: context.placement,
    params: context.params,
    artifactId,
    runId,
    pins: context.pins,
  });
  const awaitJobId = `chain-await-${context.chainId}-${context.stepId}-${artifactId}`;
  const awaiting: AwaitNotebookOutputPayload = {
    type: "await_notebook_output",
    bookId: context.bookId,
    notebookId: context.notebookId,
    cellId: placement.producerCellId,
    outputCellId: placement.outputCellId,
    providerArtifactId: artifactId,
    runId,
    cellIds: [placement.producerCellId],
  };
  onPlaced({ ...outputs, cell_id: placement.outputCellId, address: placement.address });
  try {
    if (typeof submission === "string") await waitForNamedJob(submission, signal, STEP_TIMEOUT_MS);
  } catch (error) {
    await failNotebookProviderOutput(engine, awaiting);
    throw error;
  }
  await queue.enqueue(awaitJobId, { ...awaiting });
  await waitForNamedJob(awaitJobId, signal, GENERATION_STEP_TIMEOUT_MS);
  return {
    ...outputs,
    asset_id: artifactId,
    cell_id: placement.outputCellId,
    address: placement.address,
    status: "completed",
  };
}

function childJobIdFromOutputs(outputs: Record<string, unknown>): string[] {
  return typeof outputs.job_id === "string" ? [outputs.job_id] : [];
}

async function abortOwnedJobs(engine: Engine, jobIds: string[]): Promise<void> {
  if (jobIds.length === 0) return;
  const active = engine.jobs.queue.list({
    states: ["queued", "running", "completing"],
  });
  await Promise.all(active.flatMap((job) => {
    if (!jobIds.includes(job.operationId)) return [];
    return [engine.jobs.queue.abort(job.id, "Chain cancelled")];
  }));
}

type PreparedStep = {
  def: ToolDef;
  params: Record<string, unknown>;
  beforeProcess: Set<number>;
};

/**
 * Everything a step needs before it can be dispatched, and nothing that spends
 * money. Pins are revalidated here, so a step approved after a long pause still
 * fails loudly if its target moved in the meantime.
 */
async function prepareStep(
  engine: Engine,
  bookId: string,
  notebookId: string | null,
  step: ChainPreflightStep,
  priorOutputs: Map<string, Record<string, unknown>>,
  lookup: ToolLookup,
): Promise<PreparedStep> {
  if (step.spec.placement && notebookId) {
    const notebook = engine.notebooks.read(notebookId);
    if (!notebook.ok) throw new Error(notebook.error.message);
    if (NOTEBOOK_GRID_CAPACITY - notebookOccupiedSlots(notebook.value.cells).length < 2) {
      throw new Error("The notebook needs two empty cells before generating another clip");
    }
  }
  const stale = await revalidatePinnedTargets(engine, notebookId, step.pins);
  if (stale) throw new Error(stale);
  const substituted = substituteChainRefs(step.params, priorOutputs);
  const pinned = applyPins(substituted, step.pins);
  const params: Record<string, unknown> = {
    ...pinned,
    book_id: bookId,
  };
  if (notebookId && params.notebook_id === undefined) {
    params.notebook_id = notebookId;
  }
  const def = lookup(step.tool);
  if (!def) throw new Error(`Tool handler not found: ${step.tool}`);
  const validated = z.object(def.schema).safeParse(params);
  if (!validated.success) {
    throw new Error(`Invalid parameters for ${step.tool}: ${z.prettifyError(validated.error)}`);
  }
  const targetAssetId = typeof (validated.data as { asset_id?: unknown }).asset_id
    === "string"
    ? (validated.data as { asset_id: string }).asset_id
    : undefined;
  const beforeProcess = new Set(
    step.spec.completion === "replace_video_audio" && targetAssetId
      ? engine.jobs.queue.list({
        type: "process_video",
        artifactId: targetAssetId,
      }).map((job) => job.id)
      : [],
  );
  return { def, params: validated.data, beforeProcess };
}

async function dispatchStep(
  engine: Engine,
  context: { bookId: string; notebookId: string | null; chainId: string },
  step: ChainPreflightStep,
  prepared: PreparedStep,
  signal: AbortSignal,
  onDispatched: (outputs: Record<string, unknown>, jobIds: string[]) => void,
): Promise<{ outputs: Record<string, unknown>; childJobIds: string[] }> {
  if (signal.aborted) throw new Error("Cancelled");
  const result = await prepared.def.handler(prepared.params);
  if (result.isError) {
    const text = result.content.find((entry) => entry.type === "text")?.text;
    throw new Error(text ?? `${step.tool} failed`);
  }
  let outputs = parseJsonResult(result);
  const childJobIds = childJobIdFromOutputs(outputs);
  onDispatched(outputs, childJobIds);
  if (signal.aborted) throw new Error("Cancelled");
  if (step.spec.completion === "extract_audio") {
    outputs = await completeExtractAudio(engine, outputs, signal);
  } else if (step.spec.completion === "replace_video_audio") {
    const assetId = typeof outputs.asset_id === "string"
      ? outputs.asset_id
      : typeof prepared.params.asset_id === "string"
        ? prepared.params.asset_id
        : null;
    if (!assetId) throw new Error("replace_video_audio did not return asset_id");
    outputs = await completeReplaceVideoAudio(
      engine,
      assetId,
      prepared.beforeProcess,
      outputs,
      signal,
    );
  } else if (step.spec.completion === "extract_frame") {
    outputs = await completeExtractFrame(engine, outputs, signal);
  } else if (step.spec.completion === "generation") {
    const placement = step.spec.placement;
    const artifactOutput = step.spec.artifactOutput;
    if (!placement || !artifactOutput) {
      throw new Error(`${step.tool} is missing chain generation metadata`);
    }
    outputs = await completeGeneration(engine, {
      bookId: context.bookId,
      notebookId: context.notebookId,
      chainId: context.chainId,
      stepId: step.id,
      tool: step.tool,
      placement,
      artifactOutput,
      params: prepared.params,
      pins: step.pins,
    }, outputs, signal, placed => onDispatched(placed, childJobIds));
  }
  return { outputs, childJobIds };
}

function recordFromPlan(
  plan: ChainPreflightPlan,
  chainId: string,
  approvedPlan?: { actor: ChainApprovalActor },
): ChainRunRecord {
  const timestamp = nowIso();
  return {
    kind: "chain-run",
    chainId,
    bookId: plan.bookId,
    notebookId: plan.notebookId,
    requestId: plan.requestId,
    fingerprint: plan.fingerprint,
    status: "accepted",
    createdAt: timestamp,
    updatedAt: timestamp,
    error: null,
    autoApply: plan.autoApply,
    effect: plan.effect,
    awaitingStepId: null,
    steps: plan.steps.map((step) => ({
      id: step.id,
      tool: step.tool,
      params: step.params,
      status: "pending",
      outputs: null,
      error: null,
      childJobIds: [],
      pins: step.pins,
      autoApply: step.autoApply,
      effect: step.effect,
      requiresApproval: step.requiresApproval,
      approval: approvedPlan && step.requiresApproval ? {
        approvedAt: timestamp,
        actor: approvedPlan.actor,
        estimateUsd: null,
        estimateUnavailable: true,
      } : null,
      review: null,
    })),
  };
}

async function runChain(
  engine: Engine,
  plan: ChainPreflightPlan,
  run: ChainRunRecord,
  lookup: ToolLookup,
): Promise<void> {
  const controller = inflight.get(run.chainId);
  const signal = controller?.signal ?? new AbortController().signal;
  const prior = new Map<string, Record<string, unknown>>();
  run.status = "running";
  run.updatedAt = nowIso();
  saveRun(engine, run);
  try {
    for (const [index, step] of plan.steps.entries()) {
      const record = run.steps[index]!;
      if (record.status === "completed" && record.outputs) {
        prior.set(record.id, record.outputs);
        continue;
      }
      if (signal.aborted) {
        record.status = "cancelled";
        for (const later of run.steps.slice(index + 1)) {
          if (later.status === "pending") later.status = "skipped";
        }
        run.status = "cancelled";
        run.error = "Cancelled";
        run.awaitingStepId = null;
        run.updatedAt = nowIso();
        saveRun(engine, run);
        return;
      }
      try {
        const prepared = await prepareStep(
          engine,
          plan.bookId,
          plan.notebookId,
          step,
          prior,
          lookup,
        );
        if (signal.aborted) throw new Error("Cancelled");
        if (record.requiresApproval && !record.approval) {
          record.review = await buildChainStepReview({
            engine,
            bookId: plan.bookId,
            stepId: step.id,
            tool: step.tool,
            index,
            total: plan.steps.length,
            pins: step.pins,
            dispatchParams: prepared.params,
          });
          record.status = "awaiting-approval";
          run.status = "awaiting-approval";
          run.awaitingStepId = record.id;
          run.updatedAt = nowIso();
          saveRun(engine, run);
          return;
        }
        record.status = "running";
        record.startedAt = nowIso();
        run.status = "running";
        run.awaitingStepId = null;
        run.updatedAt = nowIso();
        saveRun(engine, run);
        const executed = await dispatchStep(
          engine,
          { bookId: plan.bookId, notebookId: plan.notebookId, chainId: run.chainId },
          step,
          prepared,
          signal,
          (outputs, jobIds) => {
            record.outputs = outputs;
            record.childJobIds = jobIds;
            if (signal.aborted) run.status = "cancelled";
            saveRun(engine, run);
          },
        );
        record.status = "completed";
        record.outputs = executed.outputs;
        record.childJobIds = executed.childJobIds;
        record.error = null;
        prior.set(record.id, executed.outputs);
        run.updatedAt = nowIso();
        saveRun(engine, run);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        const cancelled = signal.aborted || /cancel/i.test(message);
        record.status = cancelled ? "cancelled" : "failed";
        record.error = message;
        for (const later of run.steps.slice(index + 1)) {
          if (later.status === "pending") later.status = "skipped";
        }
        run.status = cancelled ? "cancelled" : "failed";
        run.error = message;
        run.awaitingStepId = null;
        run.updatedAt = nowIso();
        saveRun(engine, run);
        if (record.childJobIds.length > 0) {
          await abortOwnedJobs(engine, record.childJobIds).catch(() => undefined);
        }
        return;
      }
    }
    run.status = "completed";
    run.error = null;
    run.awaitingStepId = null;
    run.updatedAt = nowIso();
    saveRun(engine, run);
  } finally {
    inflight.delete(run.chainId);
  }
}

function acceptChainRun(
  engine: Engine,
  plan: ChainPreflightPlan,
  lookup: ToolLookup,
  approvedPlan?: { actor: ChainApprovalActor },
): ChainRunRecord {
  if (plan.requestId) {
    const existing = findChainRunByRequestId(engine, plan.bookId, plan.requestId);
    if (existing) {
      if (existing.fingerprint !== plan.fingerprint) {
        throw new Error(
          "A different chain plan was already submitted with this request_id",
        );
      }
      if (!isTerminal(existing.status) && !inflight.has(existing.chainId)) {
        resumeRun(engine, existing, plan, lookup);
      }
      return existing;
    }
  }
  const run = recordFromPlan(plan, uuidv7(), approvedPlan);
  saveRun(engine, run);
  resumeRun(engine, run, plan, lookup);
  return run;
}

function resumeRun(
  engine: Engine,
  run: ChainRunRecord,
  plan: ChainPreflightPlan,
  lookup: ToolLookup,
): void {
  // A run parked on a review is resumed only by approveChainStep, which clears
  // the marker first.
  if (inflight.has(run.chainId) || isSettled(run.status) || run.awaitingStepId) return;
  const running = run.steps.find((step) => step.status === "running");
  if (running) {
    running.status = "interrupted";
    running.error = "Chain execution was interrupted";
    for (const later of run.steps) {
      if (later.status === "pending") later.status = "skipped";
    }
    run.status = "interrupted";
    run.error = "Chain execution was interrupted";
    run.updatedAt = nowIso();
    saveRun(engine, run);
    return;
  }
  const controller = new AbortController();
  inflight.set(run.chainId, controller);
  void runChain(engine, plan, run, lookup).catch((error) => {
    if (isClosedDatabaseError(error)) return;
    const current = getChainRun(engine, run.chainId);
    if (!current || isTerminal(current.status)) return;
    current.status = "failed";
    current.error = error instanceof Error ? error.message : String(error);
    current.updatedAt = nowIso();
    saveRun(engine, current);
  });
}

/**
 * Record a decision to spend on one paused step and let the chain carry on.
 * Approval is persisted before the run is resumed so a crash in between cannot
 * lose the decision, and a second approve is a no-op rather than a second
 * dispatch.
 */
export function approveChainStep(
  engine: Engine,
  chainId: string,
  stepId: string,
  actor: ChainApprovalActor,
  lookup: ToolLookup,
): ChainRunRecord | null {
  const run = getChainRun(engine, chainId);
  if (!run) return null;
  const step = run.steps.find((candidate) => candidate.id === stepId);
  if (!step) throw new Error(`Step ${stepId} is not part of this chain`);
  if (step.approval) return run;
  if (step.status !== "awaiting-approval") {
    throw new Error(`Step ${stepId} is not waiting for approval`);
  }
  step.approval = {
    approvedAt: nowIso(),
    actor,
    estimateUsd: step.review?.estimateUsd ?? null,
    estimateUnavailable: step.review?.estimateUnavailable ?? true,
  };
  step.status = "approved";
  run.status = "running";
  run.awaitingStepId = null;
  run.updatedAt = nowIso();
  saveRun(engine, run);
  resumeRun(engine, run, planFromRecord(run), lookup);
  return run;
}

export function retryChainRun(
  engine: Engine,
  chainId: string,
  lookup: ToolLookup,
): ChainRunRecord {
  const run = getChainRun(engine, chainId);
  if (!run) throw new Error("Chain run not found");
  if (inflight.has(chainId)) return run;
  if (run.status !== "failed" && run.status !== "interrupted") {
    throw new Error("Only a failed or interrupted chain can be retried");
  }
  for (const step of run.steps) {
    if (step.status !== "failed" && step.status !== "interrupted" && step.status !== "skipped") continue;
    step.status = step.approval ? "approved" : "pending";
    step.outputs = null;
    step.error = null;
    step.childJobIds = [];
    step.review = null;
    step.startedAt = null;
  }
  run.status = "accepted";
  run.error = null;
  run.awaitingStepId = null;
  run.updatedAt = nowIso();
  saveRun(engine, run);
  resumeRun(engine, run, planFromRecord(run), lookup);
  return run;
}

export function cancelChainRun(
  engine: Engine,
  chainId: string,
): ChainRunRecord | null {
  const run = getChainRun(engine, chainId);
  if (!run) return null;
  if (isTerminal(run.status)) return run;
  const controller = inflight.get(chainId);
  controller?.abort(new Error("Cancelled"));
  const running = run.steps.find((step) => step.status === "running");
  if (running) {
    running.status = "cancelled";
    running.error = "Cancelled";
    void abortOwnedJobs(engine, running.childJobIds).catch(() => undefined);
  }
  const paused = run.steps.find((step) => step.status === "awaiting-approval");
  if (paused) {
    paused.status = "rejected";
    paused.error = "Rejected";
  }
  for (const step of run.steps) {
    if (step.status === "pending" || step.status === "approved") {
      step.status = "skipped";
    }
  }
  run.status = "cancelled";
  run.error = paused ? "Rejected" : "Cancelled";
  run.awaitingStepId = null;
  run.updatedAt = nowIso();
  return saveRun(engine, run);
}

export async function waitForChainRun(
  engine: Engine,
  chainId: string,
  timeoutMs = 300_000,
): Promise<ChainRunRecord> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = getChainRun(engine, chainId);
    if (run && isSettled(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`Chain ${chainId} timed out after ${timeoutMs}ms`);
}

/**
 * Rebuild an executable plan from what was persisted. Pre-upgrade records carry
 * no policy fields, so they default to "needs approval" rather than risking a
 * silent paid dispatch.
 */
function planFromRecord(run: ChainRunRecord): ChainPreflightPlan {
  return {
    version: 1,
    bookId: run.bookId,
    notebookId: run.notebookId,
    requestId: run.requestId,
    fingerprint: run.fingerprint,
    autoApply: run.autoApply,
    effect: run.effect,
    steps: run.steps.map((step) => ({
      id: step.id,
      tool: step.tool,
      params: step.params,
      spec: supportedChainTool(step.tool) ?? {
        outputs: {},
        completion: "sync",
        gridFields: [],
        inputTypes: {},
      },
      pins: step.pins,
      autoApply: step.autoApply ?? false,
      effect: step.effect ?? "mutation",
      requiresApproval: step.requiresApproval ?? true,
    })),
  };
}

export function resumeOpenChains(
  engine: Engine,
  lookup: ToolLookup,
): void {
  const store = readStore(engine);
  for (const run of Object.values(store.runs)) {
    if (isTerminal(run.status)) continue;
    // A chain parked on a review stays parked. Resuming it would dispatch a step
    // nobody approved.
    if (run.status === "awaiting-approval") continue;
    const running = run.steps.find((step) => step.status === "running");
    if (running) {
      running.status = "interrupted";
      running.error = "Chain execution was interrupted";
      for (const later of run.steps) {
        if (later.status === "pending") later.status = "skipped";
      }
      run.status = "interrupted";
      run.error = "Chain execution was interrupted";
      run.updatedAt = nowIso();
      saveRun(engine, run);
      continue;
    }
    resumeRun(engine, run, planFromRecord(run), lookup);
  }
}

export async function preflightAndAccept(
  input: unknown,
  context: ChainPreflightContext,
  lookup: ToolLookup,
  approvedPlan?: { actor: ChainApprovalActor },
): Promise<ChainRunRecord> {
  const preflight = await preflightChainPlan(input, context);
  if (!preflight.ok) {
    throw new Error(preflight.error);
  }
  return acceptChainRun(context.engine, preflight.plan, lookup, approvedPlan);
}
