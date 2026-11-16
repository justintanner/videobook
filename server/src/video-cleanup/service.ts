import type { Engine, NotebookDocument } from "videobook-engine";
import { z } from "zod";
import { analysisComponentKey, analysisComponentState, enqueueAnalysisComponent } from "../analysis-components.js";
import { cleanupSource } from "./source.js";
import { withNotebookMutation } from "../notebook-mutations.js";
import { queue } from "../queue.js";
import { indexedRenderRequests, indexRenderRequest, renderDestination, renderRequestFingerprint, renderRequestRunning, renderRequestStatus, writeRenderSetting } from "../render-requests.js";
import { cleanupMethodSchema, cleanupRegionsSchema, cleanupSampleTimes, validateCleanupRegions, type CleanupMethod, type CleanupRegion } from "./model.js";
import { cleanupModelStatus } from "./models.js";
import { canonicalCleanupRegions, cleanupCandidate, cleanupContentKey } from "./prepared.js";
import { placeRenderedCell, sourceCellPlacement } from "../jobs/_render-output.js";

export const CLEANUP_DETECTION = { component: "video-cleanup-detection", version: 1, jobType: "detect_video_graphics" };
export const cleanupDetectionSchema = z.object({ regions: cleanupRegionsSchema, interval: z.number().positive(), samples: z.number().int().nonnegative() });

const requestSchema = z.object({
  requestId: z.string(), fingerprint: z.string(), sourceArtifactId: z.string(), sourceHash: z.string(), outputArtifactId: z.string(),
  notebookId: z.string().nullable(), method: cleanupMethodSchema, regions: cleanupRegionsSchema, jobId: z.number().nullable(),
  contentKey: z.string().optional(), progressRequestId: z.string().optional(), completedHash: z.string().optional(),
});
export type CleanupRequest = z.infer<typeof requestSchema>;
const progressSchema = z.object({ completedFrames: z.number().int().nonnegative(), totalFrames: z.number().int().positive(), elapsedSeconds: z.number().nonnegative() });

export function cleanupRenderStatus(engine: Engine, request: CleanupRequest) {
  const parsed = progressSchema.safeParse(engine.settings.get<unknown>(`video-cleanup.progress.${request.progressRequestId ?? request.requestId}`));
  const status = renderRequestStatus(engine, request);
  if (request.completedHash) { status.status = "completed"; status.error = null; }
  const placement = sourceCellPlacement(engine, request.notebookId, request.outputArtifactId);
  return { ...status, ...(status.status === "completed" ? { cell_id: placement.cellId, address: placement.address } : {}), progress: parsed.success ? parsed.data : null };
}

export function cleanupDetectionKey(mediaHash: string, interval: number): string {
  return analysisComponentKey(CLEANUP_DETECTION, { sourceHash: mediaHash, options: { interval, model: "PP-OCRv5_mobile_det:e6f4fa85" } });
}

export function readCleanupRequest(engine: Engine, requestId: string): CleanupRequest | null {
  const result = requestSchema.safeParse(engine.settings.get<unknown>(`video-cleanup.request.${requestId}`));
  return result.success ? result.data : null;
}

export function forgetCleanupState(engine: Engine, artifactId: string): void {
  for (const id of indexedRenderRequests(engine, `video-cleanup.requests.${artifactId}`)) {
    engine.settings.delete(`video-cleanup.request.${id}`);
    engine.settings.delete(`video-cleanup.progress.${id}`);
  }
  engine.settings.delete(`video-cleanup.requests.${artifactId}`);
}

export function cleanupDestination(notebook: NotebookDocument, sourceArtifactId: string) {
  return renderDestination(notebook, sourceArtifactId,
    (cell) => cell.type === "video" && cell.inputs?.sourceOperation === "remove_video_graphics" && cell.inputs.sourceArtifactId === sourceArtifactId,
    "The notebook needs an empty cell for the cleaned copy.");
}

export async function readCleanup(engine: Engine, assetId: string, interval?: number) {
  const source = await cleanupSource(engine, assetId);
  const sample = cleanupSampleTimes(source.durationSeconds, interval);
  const models = await cleanupModelStatus();
  const key = cleanupDetectionKey(source.mediaHash, sample.interval);
  return {
    source: { width: source.width, height: source.height, duration_seconds: source.durationSeconds, fps: source.fps, source_hash: source.mediaHash },
    models,
    detection: analysisComponentState(engine, CLEANUP_DETECTION, key, cleanupDetectionSchema),
    interval: sample.interval,
  };
}

export async function requestCleanupDetection(engine: Engine, bookId: string, assetId: string, interval?: number, force = false) {
  const current = await readCleanup(engine, assetId, interval);
  if (!current.models.detector) throw new Error("Download the local models before detecting text.");
  await enqueueAnalysisComponent(engine, CLEANUP_DETECTION, current.detection.key,
    { bookId, sourceArtifactId: assetId, mediaHash: current.source.source_hash, interval: current.interval },
    { force, hasResult: current.detection.value !== null });
  return readCleanup(engine, assetId, interval);
}

export async function requestCleanupRender(engine: Engine, bookId: string, assetId: string, input: {
  requestId: string; sourceHash: string; notebookId: string | null; method: CleanupMethod; regions: CleanupRegion[];
}, executionJobId?: number) {
  const contentKey = cleanupContentKey(input.sourceHash, input.method, input.regions);
  return withNotebookMutation(`video-cleanup-request:${bookId}:${input.requestId}`, () => withNotebookMutation(`video-cleanup:${bookId}:${contentKey}`, async () => {
    const source = await cleanupSource(engine, assetId);
    if (source.mediaHash !== input.sourceHash) throw new Error("The video changed after review. Reopen the remover and review the regions again.");
    const regions = canonicalCleanupRegions(validateCleanupRegions(input.regions, source.durationSeconds));
    if (input.notebookId) {
      const notebook = engine.notebooks.read(input.notebookId);
      if (!notebook.ok) throw new Error(notebook.error.message);
      cleanupDestination(notebook.value, assetId);
    }
    const fingerprint = renderRequestFingerprint([assetId, input.sourceHash, input.notebookId, input.method, regions]);
    const existing = readCleanupRequest(engine, input.requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error("This request ID belongs to a different removal. Start a new request.");
      if (!engine.artifacts.get(existing.outputArtifactId).ok) throw new Error("The cleaned copy was deleted. Start a new request.");
      if (!existing.completedHash && renderRequestRunning(engine, existing) && engine.jobs.queue.get(existing.jobId!)?.state !== "done") return cleanupRenderStatus(engine, existing);
      if (existing.completedHash || engine.jobs.queue.get(existing.jobId!)?.state === "done") {
        const candidate = await cleanupCandidate(engine, existing.outputArtifactId, input.sourceHash);
        if (!candidate?.reusable) throw new Error("The cleaned copy changed after rendering. Start a new request.");
        return cleanupRenderStatus(engine, existing);
      }
    }
    const cachedId = engine.settings.get<string>(`video-cleanup.content.${contentKey}`);
    const cached = cachedId ? readCleanupRequest(engine, cachedId) : null;
    if (cached && cached.requestId !== input.requestId && (cached.completedHash || renderRequestRunning(engine, cached))) {
      const completed = Boolean(cached.completedHash) || engine.jobs.queue.get(cached.jobId!)?.state === "done";
      const candidate = completed ? await cleanupCandidate(engine, cached.outputArtifactId, input.sourceHash) : null;
      if (!completed || candidate?.reusable) {
        const alias = { ...cached, ...input, fingerprint, sourceArtifactId: assetId, contentKey, progressRequestId: cached.progressRequestId ?? cached.requestId };
        writeRenderSetting(engine, `video-cleanup.request.${input.requestId}`, alias);
        indexRenderRequest(engine, `video-cleanup.requests.${assetId}`, input.requestId);
        indexRenderRequest(engine, `video-cleanup.requests.${alias.outputArtifactId}`, input.requestId);
        if (completed) await placeRenderedCell(engine, {
          notebookId: input.notebookId, operation: "remove_video_graphics", sourceArtifactId: assetId,
          outputArtifactId: alias.outputArtifactId, fallbackLabel: "Cleaned video", destination: notebook => cleanupDestination(notebook, assetId),
          inputs: { sourceOperation: "remove_video_graphics", sourceArtifactId: assetId },
        });
        return cleanupRenderStatus(engine, alias);
      }
    }
    if (input.method === "lama" && !(await cleanupModelStatus()).lama) throw new Error("Download the local models before using AI removal.");
    const created = existing ? null : await engine.artifacts.create({ kind: "video", label: `${source.label ?? "Video"} — Cleaned` });
    if (created && !created.ok) throw new Error(created.error.message);
    const outputArtifactId = existing?.outputArtifactId ?? (created?.ok ? created.value.artifactId : "");
    const request: CleanupRequest = { ...input, regions, fingerprint, contentKey, sourceArtifactId: assetId, outputArtifactId, jobId: null };
    writeRenderSetting(engine, `video-cleanup.request.${input.requestId}`, request);
    engine.settings.delete(`video-cleanup.progress.${input.requestId}`);
    indexRenderRequest(engine, `video-cleanup.requests.${assetId}`, input.requestId);
    indexRenderRequest(engine, `video-cleanup.requests.${outputArtifactId}`, input.requestId);
    const cleared = await engine.jobs.failures.clear(outputArtifactId);
    if (!cleared.ok) throw new Error(cleared.error.message);
    const jobId = executionJobId ?? (await queue.enqueue(`video-cleanup:${input.requestId}`, { type: "remove_video_graphics", bookId, assetId: outputArtifactId, requestId: input.requestId })).id;
    const queued = { ...request, jobId };
    writeRenderSetting(engine, `video-cleanup.request.${input.requestId}`, queued);
    writeRenderSetting(engine, `video-cleanup.content.${contentKey}`, input.requestId);
    return cleanupRenderStatus(engine, queued);
  }));
}
