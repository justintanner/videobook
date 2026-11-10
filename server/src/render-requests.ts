import { createHash } from "node:crypto";
import type { Engine, Job, NotebookCell, NotebookDocument, NotebookGridSlot } from "videobook-engine";
import { slotBelowArtifactOrFirstFree } from "./notebook-placement.js";

export const RENDER_OUTPUTS = ["new", "replace"] as const;
export type RenderOutput = typeof RENDER_OUTPUTS[number];

export interface RenderRequestStatus {
  request_id: string;
  status: "queued" | "running" | "completed" | "failed";
  job_id: number | null;
  output_asset_id: string;
  cell_id: string | null;
  address: string | null;
  error: string | null;
}

type RenderRequestRecord = { requestId: string; jobId: number | null; outputArtifactId: string };
type RenderDestination = { existing: NotebookCell | null; slot: NotebookGridSlot };

const REUSABLE_JOB_STATES: ReadonlySet<string> = new Set(["queued", "running", "completing", "done"]);

export function renderOutput(value: unknown): RenderOutput {
  return value === "replace" ? "replace" : "new";
}

export function renderRequestFingerprint(fields: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

export function writeRenderSetting(engine: Engine, key: string, value: unknown): void {
  const stored = engine.settings.set(key, value);
  if (!stored.ok) throw new Error(stored.error.message);
}

export function indexedRenderRequests(engine: Engine, key: string): string[] {
  const value = engine.settings.get<unknown>(key);
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function indexRenderRequest(engine: Engine, key: string, requestId: string): void {
  const ids = indexedRenderRequests(engine, key);
  if (!ids.includes(requestId)) writeRenderSetting(engine, key, [...ids, requestId]);
}

function jobStatus(job: Job | null): RenderRequestStatus["status"] {
  if (!job) return "failed";
  if (job.state === "queued") return "queued";
  if (job.state === "done") return "completed";
  if (job.state === "failed" || job.state === "aborted") return "failed";
  return "running";
}

function resultString(job: Job | null, key: string): string | null {
  const result = job?.result;
  if (!result || typeof result !== "object") return null;
  const value = (result as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

function requestJob(engine: Engine, request: RenderRequestRecord): Job | null {
  return request.jobId ? engine.jobs.queue.get(request.jobId) : null;
}

export function renderRequestStatus(engine: Engine, request: RenderRequestRecord): RenderRequestStatus {
  const job = requestJob(engine, request);
  const status = jobStatus(job);
  return {
    request_id: request.requestId,
    status,
    job_id: request.jobId,
    output_asset_id: request.outputArtifactId,
    cell_id: resultString(job, "cell_id"),
    address: resultString(job, "address"),
    error: status === "failed" ? job?.error?.message ?? "The render did not start." : null,
  };
}

export function renderRequestRunning(engine: Engine, request: RenderRequestRecord): boolean {
  const job = requestJob(engine, request);
  return job !== null && REUSABLE_JOB_STATES.has(job.state);
}

export function renderDestination(
  notebook: NotebookDocument,
  sourceArtifactId: string,
  isOutputCell: (cell: NotebookCell) => boolean,
  fullMessage: string,
): RenderDestination {
  const existing = notebook.cells.find(isOutputCell);
  return existing ? { existing, slot: existing.slot } : { existing: null, slot: slotBelowArtifactOrFirstFree(notebook, sourceArtifactId, fullMessage) };
}
