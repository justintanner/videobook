import { randomUUID } from "node:crypto";
import { join } from "node:path";
import sharp from "sharp";
import type { Engine, NotebookCell, NotebookDocument } from "videobook-engine";
import { findPrimaryMediaFile } from "videobook-engine";
import { withNotebookMutation } from "../notebook-mutations.js";
import { queue } from "../queue.js";
import type { RenderOutput, RenderRequestStatus } from "../render-requests.js";
import {
  indexedRenderRequests,
  indexRenderRequest,
  renderDestination,
  renderOutput,
  renderRequestFingerprint,
  renderRequestRunning,
  renderRequestStatus,
  writeRenderSetting,
} from "../render-requests.js";
import { GraphicsServiceError } from "./errors.js";
import type { GraphicsDocument, GraphicsImageLayer, GraphicsLayerKind } from "./model.js";
import { parseGraphicsDocument } from "./model.js";
import type { GraphicsLook } from "./service.js";
import { reviewedGraphics } from "./service.js";
import { graphicsStillGroups } from "./stills.js";

export const GRAPHICS_RENDER_JOB = "render_graphics";
export const GRAPHICS_SOURCE_OPERATION = "video_graphics";
const FULL_NOTEBOOK = "The notebook needs one empty cell for the copy with graphics.";
const BUSY_STATES: ReadonlySet<string> = new Set([
  "uploading", "loading", "generating", "processing", "trimming", "cropping", "splicing",
  "reversing", "changing-speed", "replacing-audio", "rendering", "downloading", "deleting",
]);

export interface GraphicsRenderRequest {
  requestId: string;
  fingerprint: string;
  output: RenderOutput;
  sourceArtifactId: string;
  outputArtifactId: string;
  notebookId: string | null;
  revision: string;
  sourceHash: string;
  document: GraphicsDocument;
  jobId: number | null;
  createdAt: string;
}

interface GraphicsRenderInput {
  requestId: string;
  expectedRevision: string;
  sourceHash: string;
  notebookId: string | null;
  output: RenderOutput;
  look: GraphicsLook;
}

type BurnedLayer = { id: string; kind: GraphicsLayerKind; name: string };

export type GraphicsProvenance = {
  requestId: string;
  sourceArtifactId: string;
  sourceHash: string;
  output: RenderOutput;
  renderedAt: string;
  layers: BurnedLayer[];
};

type GraphicsBurned = {
  request_id: string;
  output: RenderOutput;
  source_asset_id: string;
  source_hash: string;
  rendered_at: string;
  layers: BurnedLayer[];
};

function requestKey(requestId: string): string {
  return `graphics.request.${requestId}`;
}

function requestIndexKey(artifactId: string): string {
  return `graphics.requests.${artifactId}`;
}

function latestKey(artifactId: string): string {
  return `graphics.render.${artifactId}`;
}

export function readGraphicsRenderRequest(engine: Engine, requestId: string): GraphicsRenderRequest | null {
  const value = engine.settings.get<GraphicsRenderRequest>(requestKey(requestId));
  if (!value || typeof value.outputArtifactId !== "string") return null;
  const document = parseGraphicsDocument(value.document);
  return document.ok ? { ...value, output: renderOutput(value.output), document: document.document } : null;
}

export function latestGraphicsRender(engine: Engine, artifactId: string): RenderRequestStatus | null {
  const requestId = engine.settings.get<string>(latestKey(artifactId));
  const request = typeof requestId === "string" ? readGraphicsRenderRequest(engine, requestId) : null;
  return request ? renderRequestStatus(engine, request) : null;
}

export function forgetGraphicsRenders(engine: Engine, artifactId: string): void {
  for (const requestId of indexedRenderRequests(engine, requestIndexKey(artifactId))) {
    const request = readGraphicsRenderRequest(engine, requestId);
    if (request) engine.settings.delete(latestKey(request.sourceArtifactId));
    engine.settings.delete(requestKey(requestId));
  }
  engine.settings.delete(requestIndexKey(artifactId));
}

function isGraphicsOutputCell(cell: NotebookCell, sourceArtifactId: string): boolean {
  return cell.type === "video"
    && cell.inputs?.sourceOperation === GRAPHICS_SOURCE_OPERATION
    && cell.inputs?.sourceArtifactId === sourceArtifactId;
}

export function graphicsRenderDestination(notebook: NotebookDocument, sourceArtifactId: string) {
  return renderDestination(notebook, sourceArtifactId, (cell) => isGraphicsOutputCell(cell, sourceArtifactId), FULL_NOTEBOOK);
}

export function drawnImageLayers(document: GraphicsDocument, durationSeconds: number): GraphicsImageLayer[] {
  const drawn = new Set(graphicsStillGroups(document, durationSeconds).flatMap((group) => group.layerIds));
  return document.layers.filter((layer): layer is GraphicsImageLayer => layer.kind === "image" && drawn.has(layer.id));
}

export async function graphicsImagePath(engine: Engine, artifactId: string): Promise<string | null> {
  const artifact = engine.artifacts.get(artifactId);
  if (!artifact.ok || artifact.value.kind !== "image") return null;
  const manifest = await engine.files.manifest(artifactId);
  if (!manifest.ok) return null;
  const file = findPrimaryMediaFile(manifest.value.files, "image");
  return file ? join(manifest.value.path, file.name) : null;
}

export async function graphicsImageSize(path: string): Promise<{ width: number; height: number } | null> {
  const metadata = await sharp(path).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (!(width > 0 && height > 0)) return null;
  const turned = (metadata.orientation ?? 1) >= 5;
  return { width: turned ? height : width, height: turned ? width : height };
}

export function burnedLayers(document: GraphicsDocument, durationSeconds: number): BurnedLayer[] {
  const drawn = new Set(graphicsStillGroups(document, durationSeconds).flatMap((group) => group.layerIds));
  return document.layers.filter((layer) => drawn.has(layer.id)).map((layer) => ({ id: layer.id, kind: layer.kind, name: layer.name }));
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isBurnedLayer(value: unknown): value is BurnedLayer {
  if (!value || typeof value !== "object") return false;
  const layer = value as Record<string, unknown>;
  return typeof layer.id === "string" && typeof layer.kind === "string" && typeof layer.name === "string";
}

function provenanceLayers(value: unknown): BurnedLayer[] {
  return Array.isArray(value) ? value.filter(isBurnedLayer) : [];
}

export async function graphicsBurned(engine: Engine, artifactId: string): Promise<GraphicsBurned | null> {
  const read = await engine.metadata.artifacts.read<Record<string, unknown>>(artifactId, "graphics");
  const value = read.ok ? read.value : null;
  if (!value) return null;
  const requestId = text(value.requestId);
  const sourceArtifactId = text(value.sourceArtifactId);
  if (!requestId || !sourceArtifactId) return null;
  return {
    request_id: requestId,
    output: renderOutput(value.output),
    source_asset_id: sourceArtifactId,
    source_hash: text(value.sourceHash) ?? "",
    rendered_at: text(value.renderedAt) ?? "",
    layers: provenanceLayers(value.layers),
  };
}

async function requireSettledVideo(engine: Engine, artifactId: string): Promise<void> {
  const status = await engine.status.get(artifactId);
  if (!status.ok) throw new GraphicsServiceError("invalid", status.error.message);
  if (BUSY_STATES.has(status.value)) {
    throw new GraphicsServiceError("not_ready", "The video is still processing. Render its graphics once it is ready.");
  }
}

export async function requireGraphicsImages(engine: Engine, layers: readonly GraphicsImageLayer[]): Promise<void> {
  const paths = await Promise.all(layers.map((layer) => graphicsImagePath(engine, layer.artifactId)));
  const missing = layers.find((_layer, index) => paths[index] === null);
  if (missing) {
    throw new GraphicsServiceError(
      "invalid",
      `Layer ${missing.id} shows ${missing.artifactId}, which is no longer an image in this book. Choose another image or remove the layer.`,
      { layer_id: missing.id },
    );
  }
}

function checkDestination(engine: Engine, notebookId: string | null, sourceArtifactId: string): void {
  if (!notebookId) return;
  const notebook = engine.notebooks.read(notebookId);
  if (!notebook.ok) throw new GraphicsServiceError("invalid", notebook.error.message);
  try {
    graphicsRenderDestination(notebook.value, sourceArtifactId);
  } catch (error) {
    throw new GraphicsServiceError("invalid", error instanceof Error ? error.message : String(error));
  }
}

async function outputArtifact(engine: Engine, label: string | null): Promise<string> {
  const created = await engine.artifacts.create({ kind: "video", label: `${label ?? "Video"} — Graphics` });
  if (!created.ok) throw new Error(created.error.message);
  return created.value.artifactId;
}

function fingerprint(artifactId: string, input: GraphicsRenderInput): string {
  return renderRequestFingerprint([artifactId, input.notebookId, input.sourceHash, input.expectedRevision, input.output, ...(input.look.watermark ? ["watermark"] : [])]);
}

function reusable(engine: Engine, existing: GraphicsRenderRequest, expected: string): RenderRequestStatus | null {
  if (existing.fingerprint !== expected) {
    throw new GraphicsServiceError("invalid", "This request ID belongs to a different render. Start a new request.");
  }
  if (!engine.artifacts.get(existing.outputArtifactId).ok) {
    throw new GraphicsServiceError("invalid", "The copy with graphics was deleted. Start a new request.");
  }
  return renderRequestRunning(engine, existing) ? renderRequestStatus(engine, existing) : null;
}

async function reviewedRender(engine: Engine, artifactId: string, input: GraphicsRenderInput) {
  await requireSettledVideo(engine, artifactId);
  const reviewed = await reviewedGraphics(engine, artifactId, input.look, input.expectedRevision);
  if (reviewed.source.mediaHash !== input.sourceHash) {
    throw new GraphicsServiceError("stale_source", "The video changed after these graphics were reviewed. Review them again, then render.");
  }
  if (graphicsStillGroups(reviewed.document, reviewed.source.durationSeconds).length === 0) {
    throw new GraphicsServiceError("invalid", "These graphics have nothing to draw. Add text, an image, a QR code or a shade, then render.");
  }
  await requireGraphicsImages(engine, drawnImageLayers(reviewed.document, reviewed.source.durationSeconds));
  if (input.output === "replace" && reviewed.source.kind !== "video") {
    throw new GraphicsServiceError("invalid", "Only a video cell can take its graphics in place. Render a new copy of an exported timeline.");
  }
  if (input.output === "new") checkDestination(engine, input.notebookId, artifactId);
  return reviewed;
}

async function enqueueRender(engine: Engine, bookId: string, request: GraphicsRenderRequest): Promise<RenderRequestStatus> {
  writeRenderSetting(engine, requestKey(request.requestId), request);
  indexRenderRequest(engine, requestIndexKey(request.sourceArtifactId), request.requestId);
  indexRenderRequest(engine, requestIndexKey(request.outputArtifactId), request.requestId);
  writeRenderSetting(engine, latestKey(request.sourceArtifactId), request.requestId);
  const job = await queue.enqueue(`graphics-render-${request.requestId}-${randomUUID()}`, {
    type: GRAPHICS_RENDER_JOB,
    bookId,
    assetId: request.outputArtifactId,
    requestId: request.requestId,
  });
  const queued = { ...request, jobId: job.id };
  writeRenderSetting(engine, requestKey(queued.requestId), queued);
  return renderRequestStatus(engine, queued);
}

export async function requestGraphicsRender(engine: Engine, bookId: string, artifactId: string, input: GraphicsRenderInput): Promise<RenderRequestStatus> {
  return withNotebookMutation(`graphics-render:${bookId}:${input.requestId}`, async () => {
    const expected = fingerprint(artifactId, input);
    const existing = readGraphicsRenderRequest(engine, input.requestId);
    const reused = existing ? reusable(engine, existing, expected) : null;
    if (reused) return reused;
    const reviewed = await reviewedRender(engine, artifactId, input);
    return enqueueRender(engine, bookId, {
      requestId: input.requestId,
      fingerprint: expected,
      output: input.output,
      sourceArtifactId: artifactId,
      outputArtifactId: input.output === "replace" ? artifactId : existing?.outputArtifactId ?? await outputArtifact(engine, reviewed.source.label),
      notebookId: input.notebookId,
      revision: reviewed.revision,
      sourceHash: reviewed.source.mediaHash,
      document: reviewed.document,
      jobId: null,
      createdAt: new Date().toISOString(),
    });
  });
}
