import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine } from "videobook-engine";
import type { CaptionMediaSource } from "../captions/source.js";
import { captionMediaSource } from "../captions/source.js";
import { probeVideo } from "../ffmpeg.js";
import { burnGraphics } from "../graphics/burn.js";
import { deleteGraphicsDraft } from "../graphics/drafts.js";
import type { GraphicsProvenance, GraphicsRenderRequest } from "../graphics/render.js";
import {
  burnedLayers,
  drawnImageLayers,
  GRAPHICS_RENDER_JOB,
  GRAPHICS_SOURCE_OPERATION,
  graphicsImagePath,
  graphicsImageSize,
  graphicsRenderDestination,
  readGraphicsRenderRequest,
} from "../graphics/render.js";
import type { GraphicsStillImage } from "../graphics/render-stills.js";
import { renderGraphicsStills } from "../graphics/render-stills.js";
import { queue, registerJobHandler } from "../queue.js";
import type { JobHandlerContext } from "../queue.js";
import { withLocalLease, withLockedLocalLease } from "./_lease.js";
import { replaceArtifactFileFromPath } from "./_persist-output.js";
import type { RenderedCellPlacement } from "./_render-output.js";
import { placeRenderedCell, processRenderedVideo, sourceCellPlacement, writeRenderedVideo } from "./_render-output.js";

interface RenderGraphicsPayload {
  bookId: string;
  assetId: string;
  requestId: string;
}

type RenderedGraphics = { outputPath: string; durationSeconds: number };

const IN_PLACE_LOCK_MS = 30 * 60_000;
const SCRATCH_PREFIX = "videobook-graphics-render-";
const OUTPUT_NAME = "graphics.mp4";

function requireRequest(engine: Engine, payload: RenderGraphicsPayload): GraphicsRenderRequest {
  const request = readGraphicsRenderRequest(engine, payload.requestId);
  if (!request || request.outputArtifactId !== payload.assetId) throw new Error("This graphics render request is no longer available. Start a new render.");
  return request;
}

async function reviewedSource(engine: Engine, request: GraphicsRenderRequest): Promise<CaptionMediaSource> {
  const source = await captionMediaSource(engine, request.sourceArtifactId);
  if (source.mediaHash !== request.sourceHash) throw new Error("The video changed after the graphics were reviewed. Review them again, then render.");
  return source;
}

async function stillImage(engine: Engine, layerId: string, artifactId: string): Promise<GraphicsStillImage> {
  const path = await graphicsImagePath(engine, artifactId);
  if (!path) throw new Error(`Layer ${layerId} shows an image that is no longer in this book. Choose another image or remove the layer, then render again.`);
  const size = await graphicsImageSize(path);
  if (!size) throw new Error(`Layer ${layerId} shows an image whose size cannot be read.`);
  return { path, ...size };
}

async function stillImages(engine: Engine, request: GraphicsRenderRequest, durationSeconds: number): Promise<Record<string, GraphicsStillImage>> {
  const layers = drawnImageLayers(request.document, durationSeconds);
  const entries = await Promise.all(layers.map(async (layer) => [layer.artifactId, await stillImage(engine, layer.id, layer.artifactId)] as const));
  return Object.fromEntries(entries);
}

async function withRenderedGraphics<T>(
  engine: Engine,
  request: GraphicsRenderRequest,
  source: CaptionMediaSource,
  signal: AbortSignal,
  persist: (rendered: RenderedGraphics) => Promise<T>,
): Promise<T> {
  const scratch = await mkdtemp(join(tmpdir(), SCRATCH_PREFIX));
  try {
    const probe = await probeVideo(source.path, { signal });
    const durationSeconds = probe.videoDuration;
    const images = await stillImages(engine, request, durationSeconds);
    const { groups } = await renderGraphicsStills({
      document: request.document,
      frame: { width: source.width, height: source.height },
      durationSeconds,
      images,
      outputDir: scratch,
      signal,
    });
    const outputPath = join(scratch, OUTPUT_NAME);
    await burnGraphics({ videoPath: source.path, outputPath, stills: groups, probe, signal });
    signal.throwIfAborted();
    await reviewedSource(engine, request);
    return await persist({ outputPath, durationSeconds });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function writeProvenance(engine: Engine, artifactId: string, request: GraphicsRenderRequest, durationSeconds: number, renderedAt: string): Promise<void> {
  const provenance: GraphicsProvenance = {
    requestId: request.requestId,
    sourceArtifactId: request.sourceArtifactId,
    sourceHash: request.sourceHash,
    output: request.output,
    renderedAt,
    layers: burnedLayers(request.document, durationSeconds),
  };
  const written = await engine.metadata.artifacts.write(artifactId, "graphics", provenance);
  if (!written.ok) throw new Error(written.error.message);
  const snapshot = await engine.files.write(artifactId, "graphics.json", JSON.stringify(request.document, null, 2));
  if (!snapshot.ok) throw new Error(snapshot.error.message);
}

function placeCell(engine: Engine, request: GraphicsRenderRequest): Promise<RenderedCellPlacement> {
  return placeRenderedCell(engine, {
    notebookId: request.notebookId,
    operation: GRAPHICS_RENDER_JOB,
    sourceArtifactId: request.sourceArtifactId,
    outputArtifactId: request.outputArtifactId,
    fallbackLabel: "Graphics",
    destination: (notebook) => graphicsRenderDestination(notebook, request.sourceArtifactId),
    inputs: { sourceOperation: GRAPHICS_SOURCE_OPERATION, sourceArtifactId: request.sourceArtifactId },
  });
}

async function renderGraphicsCopy(engine: Engine, payload: RenderGraphicsPayload, renderedAt: string, ctx: JobHandlerContext) {
  const request = requireRequest(engine, payload);
  const source = await reviewedSource(engine, request);
  const duration = await withRenderedGraphics(engine, request, source, ctx.signal, async ({ outputPath, durationSeconds }) => {
    const probe = await writeRenderedVideo(engine, request.outputArtifactId, outputPath, ctx.signal);
    await writeProvenance(engine, request.outputArtifactId, request, durationSeconds, renderedAt);
    return probe.videoDuration;
  });
  const placement = await placeCell(engine, request);
  return { output_asset_id: request.outputArtifactId, duration, cell_id: placement.cellId, address: placement.address };
}

async function renderGraphicsNew(engine: Engine, payload: RenderGraphicsPayload, ctx: JobHandlerContext) {
  const renderedAt = new Date().toISOString();
  const rendered = await withLocalLease(engine, payload.assetId, ctx, "render", () => renderGraphicsCopy(engine, payload, renderedAt, ctx));
  await processRenderedVideo(engine, payload.bookId, rendered.output_asset_id, { origin: "graphics", request_id: payload.requestId, rendered_at: renderedAt });
  return rendered;
}

async function burnIntoSource(engine: Engine, request: GraphicsRenderRequest, source: CaptionMediaSource, signal: AbortSignal, renderedAt: string): Promise<string> {
  await reviewedSource(engine, request);
  return withRenderedGraphics(engine, request, source, signal, async ({ outputPath, durationSeconds }) => {
    await replaceArtifactFileFromPath(engine, source.artifactId, source.file.name, outputPath);
    await engine.files.delete(source.artifactId, ".original.analysis.json");
    await writeProvenance(engine, source.artifactId, request, durationSeconds, renderedAt);
    return join(source.directory, source.file.name);
  });
}

async function renderGraphicsInPlace(engine: Engine, bookId: string, request: GraphicsRenderRequest, ctx: JobHandlerContext) {
  const source = await reviewedSource(engine, request);
  const renderedAt = new Date().toISOString();
  const videoPath = await withLockedLocalLease(
    engine,
    source.artifactId,
    source.directory,
    ctx,
    "render",
    { durationMs: IN_PLACE_LOCK_MS, data: { state: "rendering" } },
    () => burnIntoSource(engine, request, source, ctx.signal, renderedAt),
    { durationMs: IN_PLACE_LOCK_MS, waitForActiveMs: 30_000 },
  );
  await queue.enqueue(`process-video-${source.artifactId}-${Date.now()}`, {
    type: "process_video",
    videoPath,
    assetId: source.artifactId,
    assetDir: source.directory,
    bookId,
    provenance: { origin: "graphics", request_id: request.requestId, rendered_at: renderedAt },
    force: true,
    skipDownstreamJobs: true,
    preserveAudioArtifacts: true,
  });
  deleteGraphicsDraft(engine, source.artifactId);
  const placement = sourceCellPlacement(engine, request.notebookId, source.artifactId);
  return { output_asset_id: source.artifactId, cell_id: placement.cellId, address: placement.address };
}

export function registerRenderGraphicsJob(engine: Engine): void {
  registerJobHandler(GRAPHICS_RENDER_JOB, async (input, ctx) => {
    const payload = input as unknown as RenderGraphicsPayload;
    const request = readGraphicsRenderRequest(engine, payload.requestId);
    if (request?.output === "replace" && request.outputArtifactId === payload.assetId) {
      return renderGraphicsInPlace(engine, payload.bookId, request, ctx);
    }
    return renderGraphicsNew(engine, payload, ctx);
  });
}
