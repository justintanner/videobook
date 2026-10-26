import { createHash } from "node:crypto";
import type { Engine, Job } from "videobook-engine";
import type { ZodType } from "zod";
import { queue } from "./queue.js";

export type AnalysisComponentStatus = "missing" | "queued" | "running" | "ready" | "failed" | "unavailable";

export interface AnalysisComponentSpec {
  component: string;
  version: number;
  jobType: string;
}

export interface AnalysisProvenance {
  analyzer: string;
  version: number;
  provider: string | null;
  model: string | null;
  createdAt: string;
}

export interface StoredAnalysisComponent<T> {
  component: string;
  key: string;
  artifactId: string;
  sourceHash: string;
  provenance: AnalysisProvenance;
  value: T;
}

export interface AnalysisComponentState<T> {
  component: string;
  key: string;
  status: AnalysisComponentStatus;
  jobId: number | null;
  error: string | null;
  provenance: AnalysisProvenance | null;
  value: T | null;
}

const ACTIVE_JOB_STATES = new Set(["queued", "running", "completing"]);
const RETAINED_SOURCES_PER_COMPONENT = 3;
const RETAINED_KEYS_PER_COMPONENT = 12;
const JOB_SCAN_LIMIT = 500;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
}

export function analysisComponentKey(
  spec: AnalysisComponentSpec,
  input: { sourceHash: string; dependencies?: readonly string[]; options?: Record<string, unknown> },
): string {
  const material = [spec.component, spec.version, input.sourceHash, input.dependencies ?? [], input.options ?? {}];
  return createHash("sha256").update(JSON.stringify(canonical(material))).digest("hex");
}

function settingsKey(component: string, key: string): string {
  return `analysis.${component}.${key}`;
}

function indexKey(artifactId: string): string {
  return `analysis.index.${artifactId}`;
}

interface AnalysisIndexEntry {
  key: string;
  at: number;
  sourceHash?: string;
}

type AnalysisIndex = Record<string, AnalysisIndexEntry[]>;

function readIndex(engine: Engine, artifactId: string): AnalysisIndex {
  const value = engine.settings.get<AnalysisIndex>(indexKey(artifactId));
  return value && typeof value === "object" ? value : {};
}

function isStoredEnvelope(value: unknown): value is StoredAnalysisComponent<unknown> {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.component === "string" && typeof record.key === "string"
    && typeof record.artifactId === "string" && typeof record.sourceHash === "string"
    && typeof record.provenance === "object" && record.provenance !== null && "value" in record;
}

export function readAnalysisComponent<T>(
  engine: Engine,
  spec: AnalysisComponentSpec,
  key: string,
  schema: ZodType<T>,
): StoredAnalysisComponent<T> | null {
  const raw = engine.settings.get<unknown>(settingsKey(spec.component, key));
  if (!isStoredEnvelope(raw) || raw.key !== key || raw.component !== spec.component) return null;
  const parsed = schema.safeParse(raw.value);
  return parsed.success ? { ...raw, value: parsed.data } : null;
}

function recentSources(entries: readonly AnalysisIndexEntry[]): Set<string> {
  const sources: string[] = [];
  for (const entry of [...entries].reverse()) {
    const source = entry.sourceHash ?? entry.key;
    if (!sources.includes(source)) sources.push(source);
  }
  return new Set(sources.slice(0, RETAINED_SOURCES_PER_COMPONENT));
}

function retainedAnalysisEntries(entries: readonly AnalysisIndexEntry[]): AnalysisIndexEntry[] {
  const sources = recentSources(entries);
  return entries.filter((entry) => sources.has(entry.sourceHash ?? entry.key)).slice(-RETAINED_KEYS_PER_COMPONENT);
}

function retain(engine: Engine, artifactId: string, component: string, key: string, sourceHash: string): void {
  const index = readIndex(engine, artifactId);
  const entries = [...(index[component] ?? []).filter((entry) => entry.key !== key), { key, at: Date.now(), sourceHash }];
  const kept = retainedAnalysisEntries(entries);
  const keptKeys = new Set(kept.map((entry) => entry.key));
  for (const dropped of entries) if (!keptKeys.has(dropped.key)) engine.settings.delete(settingsKey(component, dropped.key));
  const stored = engine.settings.set(indexKey(artifactId), { ...index, [component]: kept });
  if (!stored.ok) throw new Error(stored.error.message);
}

export function writeAnalysisComponent<T>(engine: Engine, stored: StoredAnalysisComponent<T>): void {
  const written = engine.settings.set(settingsKey(stored.component, stored.key), stored);
  if (!written.ok) throw new Error(written.error.message);
  retain(engine, stored.artifactId, stored.component, stored.key, stored.sourceHash);
}

export function hasAnalysisRecords(engine: Engine, artifactId: string, component: string): boolean {
  return (readIndex(engine, artifactId)[component] ?? []).length > 0;
}

export function forgetAnalysisComponents(engine: Engine, artifactId: string): void {
  const index = readIndex(engine, artifactId);
  for (const [component, entries] of Object.entries(index)) {
    for (const entry of entries) engine.settings.delete(settingsKey(component, entry.key));
  }
  engine.settings.delete(indexKey(artifactId));
}

export function latestJobWhere(engine: Engine, jobType: string, matches: (job: Job) => boolean): Job | null {
  return engine.jobs.queue.list({ type: jobType, limit: JOB_SCAN_LIMIT })
    .filter(matches)
    .sort((left, right) => right.id - left.id)[0] ?? null;
}

export function isActiveJob(job: Job | null): boolean {
  return Boolean(job && ACTIVE_JOB_STATES.has(job.state));
}

export function latestComponentJob(engine: Engine, spec: AnalysisComponentSpec, key: string): Job | null {
  return latestJobWhere(engine, spec.jobType, (job) => job.payload.componentKey === key);
}

function jobStatus(job: Job): AnalysisComponentStatus {
  return job.state === "queued" ? "queued" : "running";
}

function failedAfter(job: Job | null, stored: StoredAnalysisComponent<unknown> | null): string | null {
  if (!job || (job.state !== "failed" && job.state !== "aborted")) return null;
  if (stored && Date.parse(stored.provenance.createdAt) > job.enqueuedAt) return null;
  return job.error?.message ?? (job.state === "aborted" ? "Analysis was cancelled." : "Analysis failed.");
}

export function analysisComponentState<T>(
  engine: Engine,
  spec: AnalysisComponentSpec,
  key: string,
  schema: ZodType<T>,
  unavailable: string | null = null,
): AnalysisComponentState<T> {
  const stored = readAnalysisComponent(engine, spec, key, schema);
  const job = latestComponentJob(engine, spec, key);
  const base = { component: spec.component, key, provenance: stored?.provenance ?? null, value: stored?.value ?? null };
  if (job && isActiveJob(job)) return { ...base, status: jobStatus(job), jobId: job.id, error: null };
  const error = failedAfter(job, stored);
  if (stored) return { ...base, status: "ready", jobId: null, error };
  if (error) return { ...base, status: "failed", jobId: job?.id ?? null, error };
  if (unavailable) return { ...base, status: "unavailable", jobId: null, error: unavailable };
  return { ...base, status: "missing", jobId: null, error: null };
}

export async function enqueueAnalysisComponent(
  engine: Engine,
  spec: AnalysisComponentSpec,
  key: string,
  payload: Record<string, unknown> & { bookId: string },
  options: { force?: boolean; hasResult: boolean },
): Promise<{ jobId: number | null; enqueued: boolean }> {
  const active = latestComponentJob(engine, spec, key);
  if (active && isActiveJob(active)) return { jobId: active.id, enqueued: false };
  if (options.hasResult && !options.force) return { jobId: null, enqueued: false };
  const job = await queue.enqueue(`${spec.component}:${key}`, {
    ...payload,
    type: spec.jobType,
    component: spec.component,
    componentKey: key,
    force: options.force === true,
  });
  return { jobId: job.id, enqueued: true };
}

export async function runAnalysisComponentJob<T>(input: {
  engine: Engine;
  spec: AnalysisComponentSpec;
  key: string;
  artifactId: string;
  force: boolean;
  schema: ZodType<T>;
  currentKey: () => Promise<string | null>;
  compute: () => Promise<{ value: T; sourceHash: string; provenance: Omit<AnalysisProvenance, "createdAt" | "version"> }>;
}): Promise<StoredAnalysisComponent<T>> {
  const { engine, spec, key } = input;
  const cached = input.force ? null : readAnalysisComponent(engine, spec, key, input.schema);
  if (cached) return cached;
  const result = await input.compute();
  if (await input.currentKey() !== key) throw new Error("The source changed while it was being analysed, so this result was discarded. Prepare it again.");
  const stored: StoredAnalysisComponent<T> = {
    component: spec.component,
    key,
    artifactId: input.artifactId,
    sourceHash: result.sourceHash,
    provenance: { ...result.provenance, version: spec.version, createdAt: new Date().toISOString() },
    value: input.schema.parse(result.value),
  };
  writeAnalysisComponent(engine, stored);
  return stored;
}
