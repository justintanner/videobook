import type { Engine } from "videobook-engine";
import { z } from "zod";
import type { AnalysisComponentSpec, AnalysisProvenance } from "./analysis-components.js";
import { hasAnalysisRecords, isActiveJob, latestComponentJob, readAnalysisComponent, writeAnalysisComponent } from "./analysis-components.js";
import { queue } from "./queue.js";

export interface SidecarAnalysisSpec extends AnalysisComponentSpec {
  sidecar: string;
}

export type SidecarRequestStatus = "cached" | "queued" | "running";

export interface SidecarRequest {
  status: SidecarRequestStatus;
  jobId: number | null;
  jobKey: string;
}

export interface SidecarInput {
  artifactId: string;
  key: string;
  sourceHash: string;
  adoptLegacy?: () => Promise<boolean>;
}

type SidecarProvenance = Omit<AnalysisProvenance, "createdAt" | "version">;

const recordSchema = z.object({ sidecarHash: z.string().min(1), outputs: z.array(z.string()).optional() });

export const STALE_ANALYSIS_INPUTS = "The media or transcript changed while it was being analysed, so this result was discarded. Run the analysis again.";

export async function fileObjectHash(engine: Engine, artifactId: string, name: string): Promise<string | null> {
  const manifest = await engine.files.manifest(artifactId, { includeDotfiles: true });
  if (!manifest.ok) return null;
  return manifest.value.files.find((file) => file.name === name)?.objectHash ?? null;
}

export async function readArtifactJson(engine: Engine, artifactId: string, name: string): Promise<unknown> {
  const read = await engine.files.read(artifactId, name);
  if (!read.ok) return null;
  try {
    return JSON.parse(read.value.toString()) as unknown;
  } catch {
    return null;
  }
}

export function sidecarJobKey(spec: SidecarAnalysisSpec, key: string): string {
  return `${spec.component}:${key}`;
}

function writeSidecarRecord(engine: Engine, spec: SidecarAnalysisSpec, input: SidecarInput, sidecarHash: string, provenance: SidecarProvenance): void {
  writeAnalysisComponent(engine, {
    component: spec.component,
    key: input.key,
    artifactId: input.artifactId,
    sourceHash: input.sourceHash,
    provenance: { ...provenance, version: spec.version, createdAt: new Date().toISOString() },
    value: { sidecarHash },
  });
}

async function adoptLegacySidecar(engine: Engine, spec: SidecarAnalysisSpec, input: SidecarInput, sidecarHash: string): Promise<boolean> {
  if (!input.adoptLegacy || hasAnalysisRecords(engine, input.artifactId, spec.component)) return false;
  if (!await input.adoptLegacy()) return false;
  writeSidecarRecord(engine, spec, input, sidecarHash, { analyzer: `${spec.component}-legacy`, provider: null, model: null });
  return true;
}

export async function cachedSidecarAnalysis(engine: Engine, spec: SidecarAnalysisSpec, input: SidecarInput): Promise<boolean> {
  const sidecarHash = await fileObjectHash(engine, input.artifactId, spec.sidecar);
  if (!sidecarHash) return false;
  const record = readAnalysisComponent(engine, spec, input.key, recordSchema);
  if (record) return record.value.sidecarHash === sidecarHash;
  return adoptLegacySidecar(engine, spec, input, sidecarHash);
}

export async function sidecarAnalysisNeedsRun(engine: Engine, spec: SidecarAnalysisSpec, input: SidecarInput & { force: boolean }): Promise<boolean> {
  return input.force || !await cachedSidecarAnalysis(engine, spec, input);
}

export async function requestSidecarAnalysis(
  engine: Engine,
  spec: SidecarAnalysisSpec,
  input: SidecarInput & { force: boolean; payload: Record<string, unknown> & { bookId: string } },
): Promise<SidecarRequest> {
  const jobKey = sidecarJobKey(spec, input.key);
  if (!input.force && await cachedSidecarAnalysis(engine, spec, input)) return { status: "cached", jobId: null, jobKey };
  const active = latestComponentJob(engine, spec, input.key);
  if (active && isActiveJob(active)) return { status: active.state === "queued" ? "queued" : "running", jobId: active.id, jobKey };
  const job = await queue.enqueue(jobKey, { ...input.payload, type: spec.jobType, componentKey: input.key, force: input.force });
  return { status: "queued", jobId: job.id, jobKey };
}

export function sidecarOutputs(engine: Engine, spec: SidecarAnalysisSpec, key: string): string[] {
  return readAnalysisComponent(engine, spec, key, recordSchema)?.value.outputs ?? [];
}

export function rememberSidecarOutput(engine: Engine, spec: SidecarAnalysisSpec, key: string, artifactId: string): void {
  const record = readAnalysisComponent(engine, spec, key, recordSchema);
  if (!record) return;
  const outputs = [...new Set([...(record.value.outputs ?? []), artifactId])];
  writeAnalysisComponent(engine, { ...record, value: { ...record.value, outputs } });
}

export async function recordSidecarAnalysis(engine: Engine, spec: SidecarAnalysisSpec, input: SidecarInput & { provenance: SidecarProvenance }): Promise<void> {
  const sidecarHash = await fileObjectHash(engine, input.artifactId, spec.sidecar);
  if (!sidecarHash) throw new Error(`${spec.sidecar} was not written.`);
  writeSidecarRecord(engine, spec, input, sidecarHash, input.provenance);
}
