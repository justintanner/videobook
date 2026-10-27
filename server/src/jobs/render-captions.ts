import { copyFile, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import { renderMedia, selectComposition } from "@remotion/renderer";
import type { Engine, NotebookCell, NotebookDocument } from "videobook-engine";
import { notebookGridTag } from "videobook-engine/notebook-grid";
import { publishCaptionCorrections } from "../captions/publish.js";
import type { CaptionRenderRequest } from "../captions/render.js";
import { CAPTION_RENDER_JOB, CAPTION_SOURCE_OPERATION, captionRenderDestination, readCaptionRenderRequest } from "../captions/render.js";
import type { CaptionMediaSource } from "../captions/source.js";
import { captionMediaSource } from "../captions/source.js";
import { probeVideo } from "../ffmpeg.js";
import { logger } from "../logger.js";
import { registerMediaProbe } from "../notebook-media-ops.js";
import { mutateNotebook } from "../notebook-mutations.js";
import { queue, registerJobHandler } from "../queue.js";
import { withRemotionCancellation } from "../remotion-cancellation.js";
import { renderBrowserExecutable } from "../remotion/browser.js";
import type { CaptionCompositionProps } from "../remotion/captions/CaptionComposition.js";
import { captionDurationInFrames } from "../remotion/captions/composition-meta.js";
import { getSharedBundleLocation } from "../remotion/shared-bundle.js";
import { extractVideoPoster } from "../video-poster.js";
import type { JobHandlerContext } from "../queue.js";
import { withLocalLease, withLockedLocalLease } from "./_lease.js";
import { replaceArtifactFileFromPath } from "./_persist-output.js";

interface RenderCaptionsPayload {
  bookId: string;
  assetId: string;
  requestId: string;
}

const SNAPSHOT_NAME = ".captions-source";
const RENDER_NAME = ".captions-render.mp4";
const IN_PLACE_LOCK_MS = 30 * 60_000;

function requireRequest(engine: Engine, payload: RenderCaptionsPayload): CaptionRenderRequest {
  const request = readCaptionRenderRequest(engine, payload.requestId);
  if (!request || request.outputArtifactId !== payload.assetId) throw new Error("This subtitle render request is no longer available. Start a new render.");
  return request;
}

async function reviewedSource(engine: Engine, request: CaptionRenderRequest): Promise<CaptionMediaSource> {
  const source = await captionMediaSource(engine, request.sourceArtifactId);
  if (source.mediaHash !== request.sourceHash) throw new Error("The video changed after the subtitles were reviewed. Review them again, then render.");
  return source;
}

async function pinnedSnapshot(engine: Engine, request: CaptionRenderRequest, source: CaptionMediaSource): Promise<{ name: string; path: string }> {
  const name = `${SNAPSHOT_NAME}${extname(source.file.name) || ".mp4"}`;
  const copied = await engine.files.copy(source.artifactId, source.file.name, request.outputArtifactId, name);
  if (!copied.ok) throw new Error(copied.error.message);
  const manifest = await engine.files.manifest(request.outputArtifactId, { includeDotfiles: true });
  if (!manifest.ok) throw new Error(manifest.error.message);
  if (manifest.value.files.find((file) => file.name === name)?.objectHash !== request.sourceHash) {
    throw new Error("The video changed after the subtitles were reviewed. Review them again, then render.");
  }
  return { name, path: join(manifest.value.path, name) };
}

async function renderComposition(input: {
  request: CaptionRenderRequest;
  source: CaptionMediaSource;
  snapshotPath: string;
  outputPath: string;
  signal: AbortSignal;
}): Promise<void> {
  const bundleDir = await getSharedBundleLocation();
  input.signal.throwIfAborted();
  const videoName = `captions-source-${input.request.requestId}${extname(input.snapshotPath) || ".mp4"}`;
  const videoPath = join(bundleDir, videoName);
  await copyFile(input.snapshotPath, videoPath);
  try {
    const fps = input.request.document.source.fps;
    const inputProps: CaptionCompositionProps = {
      videoSrc: videoName,
      sourceWidth: input.source.width,
      sourceHeight: input.source.height,
      durationInFrames: captionDurationInFrames(input.source.durationSeconds, fps),
      fps,
      document: input.request.document,
      regions: input.request.regions,
      fontUrls: null,
    };
    const browserExecutable = await renderBrowserExecutable();
    const composition = await selectComposition({
      serveUrl: bundleDir,
      id: "captions",
      inputProps,
      timeoutInMilliseconds: 60_000,
      ...(browserExecutable ? { browserExecutable } : {}),
    });
    input.signal.throwIfAborted();
    await withRemotionCancellation(input.signal, (cancelSignal) => renderMedia({
      composition,
      serveUrl: bundleDir,
      codec: "h264",
      outputLocation: input.outputPath,
      inputProps,
      videoBitrate: "8M",
      concurrency: 1,
      hardwareAcceleration: "if-possible",
      cancelSignal,
      ...(browserExecutable ? { browserExecutable } : {}),
    }));
  } finally {
    await rm(videoPath, { force: true });
  }
}

function versionedCell(cell: NotebookCell, artifactId: string): NotebookCell {
  const previous = Array.isArray(cell.inputs?.outputVersionArtifactIds)
    ? cell.inputs.outputVersionArtifactIds.filter((value): value is string => typeof value === "string")
    : [];
  const versions = [...new Set([...previous, ...(cell.outputArtifactId ? [cell.outputArtifactId] : []), artifactId])];
  return { ...cell, outputArtifactId: artifactId, inputs: { ...cell.inputs, outputVersionArtifactIds: versions, state: "completed" } };
}

function placeOutput(engine: Engine, notebook: NotebookDocument, request: CaptionRenderRequest, label: string): { notebook: NotebookDocument; cell: NotebookCell } {
  const placed = notebook.cells.find((cell) => cell.outputArtifactId === request.outputArtifactId);
  if (placed) return { notebook, cell: placed };
  const destination = captionRenderDestination(notebook, request.sourceArtifactId, request.language);
  if (destination.existing) {
    const cell = versionedCell(destination.existing, request.outputArtifactId);
    return { notebook: { ...notebook, cells: notebook.cells.map((candidate) => (candidate.id === cell.id ? cell : candidate)) }, cell };
  }
  const cell = engine.notebooks.createCell({
    type: "video",
    label,
    slot: destination.slot,
    outputArtifactId: request.outputArtifactId,
    inputs: {
      sourceOperation: CAPTION_SOURCE_OPERATION,
      sourceArtifactId: request.sourceArtifactId,
      language: request.language,
      state: "completed",
    },
  });
  return { notebook: { ...notebook, cells: [...notebook.cells, cell] }, cell };
}

async function placeCell(engine: Engine, request: CaptionRenderRequest): Promise<{ cellId: string | null; address: string | null }> {
  if (!request.notebookId) return { cellId: null, address: null };
  const artifact = engine.artifacts.get(request.outputArtifactId);
  const label = artifact.ok ? artifact.value.label ?? "Subtitles" : "Subtitles";
  const placement = { cellId: null as string | null, address: null as string | null };
  const written = await mutateNotebook(engine, request.notebookId, CAPTION_RENDER_JOB, (notebook) => {
    const result = placeOutput(engine, notebook, request, label);
    placement.cellId = result.cell.id;
    placement.address = notebookGridTag(result.cell.slot);
    return result.notebook;
  }, { sourceArtifactId: request.sourceArtifactId, outputArtifactId: request.outputArtifactId }, { artifactId: request.outputArtifactId });
  if (!written.ok) throw new Error(written.error.message);
  return placement;
}

async function writeOutput(engine: Engine, request: CaptionRenderRequest, outputPath: string, signal: AbortSignal): Promise<number> {
  const probe = await probeVideo(outputPath, { signal });
  const written = await engine.files.writeFromPath(request.outputArtifactId, "original.mp4", outputPath);
  if (!written.ok) throw new Error(written.error.message);
  await registerMediaProbe(engine, request.outputArtifactId, "original.mp4", probe);
  const poster = await engine.files.write(request.outputArtifactId, "original.jpg", await extractVideoPoster(outputPath, probe.videoDuration, signal));
  if (!poster.ok) throw new Error(poster.error.message);
  const snapshot = await engine.files.write(request.outputArtifactId, "captions.json", JSON.stringify(request.document, null, 2));
  if (!snapshot.ok) throw new Error(snapshot.error.message);
  await writeProvenance(engine, request);
  return probe.videoDuration;
}

async function writeProvenance(engine: Engine, request: CaptionRenderRequest): Promise<void> {
  const provenance = await engine.metadata.artifacts.write(request.outputArtifactId, "captions", {
    sourceArtifactId: request.sourceArtifactId,
    sourceHash: request.sourceHash,
    requestId: request.requestId,
    language: request.language,
    revision: request.revision,
    aspect: request.document.aspect,
    preset: request.document.style.preset,
    output: request.output,
  });
  if (!provenance.ok) throw new Error(provenance.error.message);
}

async function publishCorrections(engine: Engine, bookId: string, request: CaptionRenderRequest): Promise<void> {
  try {
    await publishCaptionCorrections(engine, bookId, request.document);
  } catch (error) {
    logger.warn("caption-transcript-publish-failed", { artifactId: request.sourceArtifactId, error });
  }
}

async function renderCaptions(engine: Engine, payload: RenderCaptionsPayload, ctx: JobHandlerContext) {
  const request = requireRequest(engine, payload);
  const source = await reviewedSource(engine, request);
  const snapshot = await pinnedSnapshot(engine, request, source);
  const manifest = await engine.files.manifest(request.outputArtifactId, { includeDotfiles: true });
  if (!manifest.ok) throw new Error(manifest.error.message);
  const outputPath = join(manifest.value.path, RENDER_NAME);
  try {
    await renderComposition({ request, source, snapshotPath: snapshot.path, outputPath, signal: ctx.signal });
    ctx.signal.throwIfAborted();
    await reviewedSource(engine, request);
    const duration = await writeOutput(engine, request, outputPath, ctx.signal);
    await publishCorrections(engine, payload.bookId, request);
    const placement = await placeCell(engine, request);
    return { output_asset_id: request.outputArtifactId, duration, cell_id: placement.cellId, address: placement.address };
  } finally {
    await rm(outputPath, { force: true });
    await engine.files.delete(request.outputArtifactId, snapshot.name);
  }
}

function sourcePlacement(engine: Engine, request: CaptionRenderRequest): { cellId: string | null; address: string | null } {
  const notebook = request.notebookId ? engine.notebooks.read(request.notebookId) : null;
  const cell = notebook?.ok ? notebook.value.cells.find((entry) => entry.outputArtifactId === request.sourceArtifactId) : undefined;
  return cell ? { cellId: cell.id, address: notebookGridTag(cell.slot) } : { cellId: null, address: null };
}

async function burnIntoSource(engine: Engine, bookId: string, request: CaptionRenderRequest, source: CaptionMediaSource, signal: AbortSignal): Promise<string> {
  await reviewedSource(engine, request);
  const outputPath = join(source.directory, RENDER_NAME);
  try {
    await renderComposition({ request, source, snapshotPath: source.path, outputPath, signal });
    signal.throwIfAborted();
    await reviewedSource(engine, request);
    await publishCorrections(engine, bookId, request);
    await replaceArtifactFileFromPath(engine, source.artifactId, source.file.name, outputPath);
    await writeProvenance(engine, request);
    return join(source.directory, source.file.name);
  } finally {
    await rm(outputPath, { force: true });
  }
}

async function renderCaptionsInPlace(engine: Engine, bookId: string, request: CaptionRenderRequest, ctx: JobHandlerContext) {
  const source = await reviewedSource(engine, request);
  const videoPath = await withLockedLocalLease(
    engine,
    source.artifactId,
    source.directory,
    ctx,
    "render",
    { durationMs: IN_PLACE_LOCK_MS, data: { state: "rendering" } },
    () => burnIntoSource(engine, bookId, request, source, ctx.signal),
    { durationMs: IN_PLACE_LOCK_MS, waitForActiveMs: 30_000 },
  );
  await queue.enqueue(`process-video-${source.artifactId}-${Date.now()}`, {
    type: "process_video",
    videoPath,
    assetId: source.artifactId,
    assetDir: source.directory,
    bookId,
    provenance: { origin: "captions", request_id: request.requestId, captioned_at: new Date().toISOString() },
    force: true,
    skipDownstreamJobs: true,
    preserveAudioArtifacts: true,
  });
  const placement = sourcePlacement(engine, request);
  return { output_asset_id: source.artifactId, cell_id: placement.cellId, address: placement.address };
}

export function registerRenderCaptionsJob(engine: Engine): void {
  registerJobHandler(CAPTION_RENDER_JOB, async (input, ctx) => {
    const payload = input as unknown as RenderCaptionsPayload;
    const request = readCaptionRenderRequest(engine, payload.requestId);
    if (request?.output === "replace" && request.outputArtifactId === payload.assetId) {
      return renderCaptionsInPlace(engine, payload.bookId, request, ctx);
    }
    return withLocalLease(engine, payload.assetId, ctx, "render", () => renderCaptions(engine, payload, ctx));
  });
}
