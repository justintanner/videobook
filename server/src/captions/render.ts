import { createHash, randomUUID } from "node:crypto";
import type { Engine, Job, NotebookCell, NotebookDocument } from "videobook-engine";
import { withNotebookMutation } from "../notebook-mutations.js";
import { slotBelowArtifactOrFirstFree } from "../notebook-placement.js";
import { queue } from "../queue.js";
import { captionAnalysisStateFor } from "./analysis.js";
import type { CaptionRegionFrame } from "./layout.js";
import type { CaptionDocument } from "./model.js";
import { captionDocumentSchema, ORIGINAL_CAPTION_LANGUAGE } from "./model.js";
import { CaptionServiceError, savedCaptionDraft } from "./service.js";
import { captionMediaSource } from "./source.js";

export const CAPTION_RENDER_JOB = "render_captions";
export const CAPTION_SOURCE_OPERATION = "caption_video";
const FULL_NOTEBOOK = "The notebook needs one empty cell for the subtitled copy.";

export interface CaptionRenderRequest {
  requestId: string;
  fingerprint: string;
  sourceArtifactId: string;
  outputArtifactId: string;
  notebookId: string | null;
  language: string;
  revision: string;
  sourceHash: string;
  document: CaptionDocument;
  regions: CaptionRegionFrame[];
  jobId: number | null;
  createdAt: string;
}

export interface CaptionRenderStatus {
  request_id: string;
  status: "queued" | "running" | "completed" | "failed";
  job_id: number | null;
  output_asset_id: string;
  cell_id: string | null;
  address: string | null;
  error: string | null;
}

function requestKey(requestId: string): string {
  return `captions.request.${requestId}`;
}

function latestKey(artifactId: string, language: string): string {
  return `captions.render.${artifactId}.${language}`;
}

export function readCaptionRenderRequest(engine: Engine, requestId: string): CaptionRenderRequest | null {
  const value = engine.settings.get<CaptionRenderRequest>(requestKey(requestId));
  if (!value || typeof value.outputArtifactId !== "string") return null;
  const document = captionDocumentSchema.safeParse(value.document);
  return document.success ? { ...value, document: document.data } : null;
}

function requestIndexKey(artifactId: string): string {
  return `captions.requests.${artifactId}`;
}

function indexedRequests(engine: Engine, artifactId: string): string[] {
  const value = engine.settings.get<unknown>(requestIndexKey(artifactId));
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function indexRequest(engine: Engine, artifactId: string, requestId: string): void {
  const ids = indexedRequests(engine, artifactId);
  if (ids.includes(requestId)) return;
  const stored = engine.settings.set(requestIndexKey(artifactId), [...ids, requestId]);
  if (!stored.ok) throw new Error(stored.error.message);
}

export function forgetCaptionRenders(engine: Engine, artifactId: string): void {
  for (const requestId of indexedRequests(engine, artifactId)) {
    const request = readCaptionRenderRequest(engine, requestId);
    if (request) engine.settings.delete(latestKey(request.sourceArtifactId, request.language));
    engine.settings.delete(requestKey(requestId));
  }
  engine.settings.delete(requestIndexKey(artifactId));
}

function writeRequest(engine: Engine, request: CaptionRenderRequest): void {
  const stored = engine.settings.set(requestKey(request.requestId), request);
  if (!stored.ok) throw new Error(stored.error.message);
}

function fingerprint(sourceArtifactId: string, notebookId: string | null, sourceHash: string, language: string, revision: string): string {
  return createHash("sha256").update(JSON.stringify([sourceArtifactId, notebookId, sourceHash, language, revision])).digest("hex");
}

function jobStatus(job: Job | null): CaptionRenderStatus["status"] {
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

function captionRenderStatus(engine: Engine, request: CaptionRenderRequest): CaptionRenderStatus {
  const job = request.jobId ? engine.jobs.queue.get(request.jobId) : null;
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

export function latestCaptionRender(engine: Engine, artifactId: string, language: string): CaptionRenderStatus | null {
  const requestId = engine.settings.get<string>(latestKey(artifactId, language));
  const request = typeof requestId === "string" ? readCaptionRenderRequest(engine, requestId) : null;
  return request ? captionRenderStatus(engine, request) : null;
}

function isCaptionOutputCell(cell: NotebookCell, sourceArtifactId: string, language: string): boolean {
  return cell.type === "video"
    && cell.inputs?.sourceOperation === CAPTION_SOURCE_OPERATION
    && cell.inputs?.sourceArtifactId === sourceArtifactId
    && (cell.inputs?.language ?? ORIGINAL_CAPTION_LANGUAGE) === language;
}

export function captionRenderDestination(notebook: NotebookDocument, sourceArtifactId: string, language: string) {
  const existing = notebook.cells.find((cell) => isCaptionOutputCell(cell, sourceArtifactId, language));
  return existing ? { existing, slot: existing.slot } : { existing: null, slot: slotBelowArtifactOrFirstFree(notebook, sourceArtifactId, FULL_NOTEBOOK) };
}

function checkDestination(engine: Engine, notebookId: string | null, sourceArtifactId: string, language: string): void {
  if (!notebookId) return;
  const notebook = engine.notebooks.read(notebookId);
  if (!notebook.ok) throw new CaptionServiceError("invalid", notebook.error.message);
  try {
    captionRenderDestination(notebook.value, sourceArtifactId, language);
  } catch (error) {
    throw new CaptionServiceError("invalid", error instanceof Error ? error.message : String(error));
  }
}

function regionsSnapshot(engine: Engine, source: Awaited<ReturnType<typeof captionMediaSource>>): CaptionRegionFrame[] {
  return captionAnalysisStateFor(engine, source).regions?.value?.frames ?? [];
}

async function outputArtifact(engine: Engine, label: string | null, language: string): Promise<string> {
  const suffix = language === ORIGINAL_CAPTION_LANGUAGE ? "Subtitles" : `Subtitles (${language})`;
  const created = await engine.artifacts.create({ kind: "video", label: `${label ?? "Video"} — ${suffix}` });
  if (!created.ok) throw new Error(created.error.message);
  return created.value.artifactId;
}

function reusable(engine: Engine, existing: CaptionRenderRequest, expected: string): CaptionRenderStatus | null {
  if (existing.fingerprint !== expected) {
    throw new CaptionServiceError("invalid", "This request ID belongs to a different render. Start a new request.");
  }
  if (!engine.artifacts.get(existing.outputArtifactId).ok) {
    throw new CaptionServiceError("invalid", "The subtitled copy was deleted. Start a new request.");
  }
  const job = existing.jobId ? engine.jobs.queue.get(existing.jobId) : null;
  return job && ["queued", "running", "completing", "done"].includes(job.state) ? captionRenderStatus(engine, existing) : null;
}

export interface CaptionRenderInput {
  requestId: string;
  expectedRevision: string;
  sourceHash: string;
  notebookId: string | null;
}

export async function requestCaptionRender(engine: Engine, bookId: string, artifactId: string, language: string, input: CaptionRenderInput): Promise<CaptionRenderStatus> {
  return withNotebookMutation(`captions-render:${bookId}:${input.requestId}`, async () => {
    const expected = fingerprint(artifactId, input.notebookId, input.sourceHash, language, input.expectedRevision);
    const existing = readCaptionRenderRequest(engine, input.requestId);
    const reused = existing ? reusable(engine, existing, expected) : null;
    if (reused) return reused;
    const draft = await savedCaptionDraft(engine, bookId, artifactId, language, input.expectedRevision);
    const source = await captionMediaSource(engine, artifactId);
    if (source.mediaHash !== input.sourceHash || draft.document.source.mediaHash !== source.mediaHash) {
      throw new CaptionServiceError("stale_source", "The video changed after review. Review the subtitles again, then render.");
    }
    if (!draft.document.words.some((word) => !word.hidden && word.text.trim())) {
      throw new CaptionServiceError("invalid", "These subtitles have no words to render.");
    }
    checkDestination(engine, input.notebookId, artifactId, language);
    const request: CaptionRenderRequest = {
      requestId: input.requestId,
      fingerprint: expected,
      sourceArtifactId: artifactId,
      outputArtifactId: existing?.outputArtifactId ?? await outputArtifact(engine, source.label, language),
      notebookId: input.notebookId,
      language,
      revision: draft.revision,
      sourceHash: source.mediaHash,
      document: draft.document,
      regions: regionsSnapshot(engine, source),
      jobId: null,
      createdAt: new Date().toISOString(),
    };
    writeRequest(engine, request);
    indexRequest(engine, artifactId, input.requestId);
    indexRequest(engine, request.outputArtifactId, input.requestId);
    const latest = engine.settings.set(latestKey(artifactId, language), input.requestId);
    if (!latest.ok) throw new Error(latest.error.message);
    const job = await queue.enqueue(`caption-render-${input.requestId}-${randomUUID()}`, {
      type: CAPTION_RENDER_JOB,
      bookId,
      assetId: request.outputArtifactId,
      requestId: input.requestId,
    });
    const queued = { ...request, jobId: job.id };
    writeRequest(engine, queued);
    return captionRenderStatus(engine, queued);
  });
}
