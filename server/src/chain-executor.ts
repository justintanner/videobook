import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import type { Engine } from "videobook-engine";
import type { ToolDef, ToolResult } from "./tools/tool-def.js";
import { waitForJob } from "./queue.js";
import {
  preflightChainPlan,
  revalidatePinnedTargets,
  substituteChainRefs,
  supportedChainTool,
  type ChainPreflightContext,
  type ChainPreflightPlan,
  type ChainPreflightStep,
  type PinnedChainTarget,
} from "./chain-plan.js";

const SETTINGS_KEY = "application.chain-runs.v1";
const STEP_TIMEOUT_MS = 180_000;
const POLL_MS = 50;

type ChainStepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "interrupted"
  | "cancelled";

type ChainRunStatus =
  | "accepted"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

type ChainStepRecord = {
  id: string;
  tool: string;
  params: Record<string, unknown>;
  status: ChainStepStatus;
  outputs: Record<string, unknown> | null;
  error: string | null;
  childJobIds: string[];
  pins: PinnedChainTarget[];
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
  pending: () => boolean,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (pending()) {
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
    if (typeof next[pin.field] === "string") {
      next[pin.field] = pin.artifactId;
    }
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

async function executeStep(
  engine: Engine,
  bookId: string,
  notebookId: string | null,
  step: ChainPreflightStep,
  priorOutputs: Map<string, Record<string, unknown>>,
  lookup: ToolLookup,
  signal: AbortSignal,
): Promise<{ outputs: Record<string, unknown>; childJobIds: string[] }> {
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
  const result = await def.handler(validated.data);
  if (result.isError) {
    const text = result.content.find((entry) => entry.type === "text")?.text;
    throw new Error(text ?? `${step.tool} failed`);
  }
  let outputs = parseJsonResult(result);
  const childJobIds = childJobIdFromOutputs(outputs);
  if (step.spec.completion === "extract_audio") {
    outputs = await completeExtractAudio(engine, outputs, signal);
  } else if (step.spec.completion === "replace_video_audio") {
    const assetId = typeof outputs.asset_id === "string"
      ? outputs.asset_id
      : typeof validated.data.asset_id === "string"
        ? validated.data.asset_id
        : null;
    if (!assetId) throw new Error("replace_video_audio did not return asset_id");
    outputs = await completeReplaceVideoAudio(
      engine,
      assetId,
      beforeProcess,
      outputs,
      signal,
    );
  } else if (step.spec.completion === "extract_frame") {
    outputs = await completeExtractFrame(engine, outputs, signal);
  }
  return { outputs, childJobIds };
}

function recordFromPlan(
  plan: ChainPreflightPlan,
  chainId: string,
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
    steps: plan.steps.map((step) => ({
      id: step.id,
      tool: step.tool,
      params: step.params,
      status: "pending",
      outputs: null,
      error: null,
      childJobIds: [],
      pins: step.pins,
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
        run.updatedAt = nowIso();
        saveRun(engine, run);
        return;
      }
      record.status = "running";
      run.updatedAt = nowIso();
      saveRun(engine, run);
      try {
        const executed = await executeStep(
          engine,
          plan.bookId,
          plan.notebookId,
          step,
          prior,
          lookup,
          signal,
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
  const run = recordFromPlan(plan, uuidv7());
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
  if (inflight.has(run.chainId) || isTerminal(run.status)) return;
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

export function cancelChainRun(
  engine: Engine,
  chainId: string,
): ChainRunRecord | null {
  const run = getChainRun(engine, chainId);
  if (!run) return null;
  if (isTerminal(run.status)) return run;
  const controller = inflight.get(chainId);
  controller?.abort(new Error("Cancelled"));
  const current = run.steps.find((step) => step.status === "running");
  if (current) {
    current.status = "cancelled";
    current.error = "Cancelled";
    void abortOwnedJobs(engine, current.childJobIds).catch(() => undefined);
  }
  for (const step of run.steps) {
    if (step.status === "pending") step.status = "skipped";
  }
  run.status = "cancelled";
  run.error = "Cancelled";
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
    if (run && isTerminal(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`Chain ${chainId} timed out after ${timeoutMs}ms`);
}

export function resumeOpenChains(
  engine: Engine,
  lookup: ToolLookup,
): void {
  const store = readStore(engine);
  for (const run of Object.values(store.runs)) {
    if (isTerminal(run.status)) continue;
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
    const plan: ChainPreflightPlan = {
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
        autoApply: false,
        effect: "mutation",
      })),
    };
    resumeRun(engine, run, plan, lookup);
  }
}

export async function preflightAndAccept(
  input: unknown,
  context: ChainPreflightContext,
  lookup: ToolLookup,
): Promise<ChainRunRecord> {
  const preflight = await preflightChainPlan(input, context);
  if (!preflight.ok) {
    throw new Error(preflight.error);
  }
  return acceptChainRun(context.engine, preflight.plan, lookup);
}
