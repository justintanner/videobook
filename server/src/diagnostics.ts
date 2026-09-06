import { ENGINE_ERROR_CODES, type Engine } from "videobook-engine";

const EVENTS = [
  "mcp", "server-listening", "shutdown-complete", "shutdown-failed", "startup-failed",
  "book-open", "book-open-slow", "book-catalog-gc", "provider-poll-failed",
  "ace-server-exited", "scheduled-post-failed", "scheduled-post-rearm-failed",
  "generation-record-failed", "generation-update-failed", "generation-list-failed",
  "waveform-empty", "waveform-failed", "heartbeat-failed", "subtitle-cache-failed",
  "subtitle-translation-failed", "overlay-skipped", "kie-upload-fallback",
  "kie-upload-unconfigured", "fal-upload-fallback", "fal-upload-unconfigured",
  "alibaba-upload-fallback", "alibaba-upload-unconfigured", "suggest-cuts-dropped",
  "suggest-sfx-dropped", "transcribe-soft-fail", "post-record-failed", "post-cell-failed",
  "process-video-enqueue-failed", "waveform-write-failed", "timeline-reencode",
  "pad-video-started", "video-analysis-failed", "description-truncated",
  "description-cache-failed", "watermark-placement-fallback", "waveform-enqueue-failed",
  "watermark-probe-fallback", "generation-error-clear-failed", "timeline-orientation-failed",
  "generation-cost-estimate", "job-error", "semantic-index-deferred",
] as const;
export type DiagnosticEvent = typeof EVENTS[number];
const events = new Set<string>(EVENTS);
const errorCodes = new Set<string>([
  ...ENGINE_ERROR_CODES, "UNKNOWN", "ENOENT", "EACCES", "EPERM", "ENOSPC",
  "EIO", "EMFILE", "ENFILE", "ENOMEM", "ECONNREFUSED", "ECONNRESET",
  "ETIMEDOUT", "EPIPE", "ENOTFOUND", "ABORT_ERR",
]);
const names = { tool: new Set<string>(), jobType: new Set<string>() };

export function registerDiagnosticName(kind: keyof typeof names, name: string): void {
  if (typeof name === "string" && name.trim() === name && /^[a-z][a-z0-9_]{0,95}$/.test(name)) names[kind].add(name);
}

export interface DiagnosticFields {
  error?: unknown;
  errorCode?: string;
  bookId?: string;
  assetId?: string;
  artifactId?: string;
  notebookId?: string;
  cellId?: string;
  outputCellId?: string;
  generationId?: string;
  scheduleId?: string;
  operationId?: string;
  runId?: string;
  jobId?: string | number;
  tool?: string;
  jobType?: string;
  durationMs?: number;
  bytesBefore?: number;
  bytesAfter?: number;
  count?: number;
  limit?: number;
  warningCount?: number;
  targetFps?: number;
  exitCode?: number | null;
  signal?: string | null;
  port?: number;
  status?: "ok" | "error";
  modality?: "visual" | "audio" | "metadata";
  available?: boolean;
  detached?: boolean;
  rolledBack?: boolean;
  reason?: string;
  provider?: string;
  stage?: string;
}

function ownValue(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  try { return Object.getOwnPropertyDescriptor(value, key)?.value; }
  catch { return undefined; }
}

export function diagnosticErrorCode(error: unknown): string {
  for (const value of [ownValue(error, "code"), ownValue(ownValue(error, "error"), "code")]) {
    if (typeof value === "string" && errorCodes.has(value)) return value;
  }
  return "UNKNOWN";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_FIELDS = ["bookId", "assetId", "artifactId", "notebookId", "cellId", "outputCellId",
  "generationId", "scheduleId", "operationId", "runId"] as const;
const NUMBER_FIELDS = ["durationMs", "bytesBefore", "bytesAfter", "count", "limit", "warningCount", "targetFps"] as const;
const ENUM_FIELDS = {
  status: ["ok", "error"],
  modality: ["visual", "audio", "metadata"],
  reason: ["unbounded", "zero", "missing-adapter", "missing-rates", "missing-selector", "estimator-threw", "estimate-error"],
  provider: ["kie", "fal", "alibaba", "elevenlabs", "googleflow", "openai", "kimicoding", "xai", "acestep"],
  stage: ["submit-kie", "submit-queued-kie", "submit-veo", "index-progressive"],
  signal: ["SIGTERM", "SIGKILL", "SIGINT", "SIGABRT", "SIGSEGV", "SIGBUS", "SIGILL", "SIGFPE", "SIGHUP"],
} as const;

export function diagnosticRecord(event: DiagnosticEvent, fields: DiagnosticFields = {}): Record<string, unknown> {
  const result: Record<string, unknown> = { event: events.has(event) ? event : "unknown-event" };
  for (const key of UUID_FIELDS) {
    const value = ownValue(fields, key);
    if (typeof value === "string" && value.length === 36 && UUID.test(value)) result[key] = value;
  }
  for (const key of NUMBER_FIELDS) {
    const value = ownValue(fields, key);
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) result[key] = value;
  }
  for (const key of ["available", "detached", "rolledBack"] as const) {
    const value = ownValue(fields, key);
    if (typeof value === "boolean") result[key] = value;
  }
  for (const key of Object.keys(ENUM_FIELDS) as Array<keyof typeof ENUM_FIELDS>) {
    const value = ownValue(fields, key);
    if (typeof value === "string" && (ENUM_FIELDS[key] as readonly string[]).includes(value)) result[key] = value;
  }
  for (const key of ["tool", "jobType"] as const) {
    const value = ownValue(fields, key);
    if (typeof value === "string" && names[key].has(value)) result[key] = value;
  }
  const jobId = ownValue(fields, "jobId");
  if ((typeof jobId === "number" && Number.isSafeInteger(jobId) && jobId >= 0)
    || (typeof jobId === "string" && jobId.length === 36 && UUID.test(jobId))) result.jobId = jobId;
  for (const [key, min, max] of [["exitCode", -255, 255], ["port", 1, 65535]] as const) {
    const value = ownValue(fields, key);
    if (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max) result[key] = value;
  }
  const error = ownValue(fields, "error");
  const code = ownValue(fields, "errorCode");
  if (error !== undefined || code !== undefined) {
    result.errorCode = typeof code === "string" && errorCodes.has(code) ? code : diagnosticErrorCode(error);
  }
  return result;
}

export async function appendDiagnostic(engine: Engine, event: DiagnosticEvent, fields: DiagnosticFields): Promise<void> {
  const record = diagnosticRecord(event, fields);
  await engine.logs.append(String(record.event), record);
}
