import { graphicsAspectChanged, ORIGINAL_GRAPHICS_FRAME } from "../graphics/frame.js";
import { readGraphicsDraft } from "../graphics/drafts.js";
import type { GraphicsDocument } from "../graphics/model.js";
import { parseGraphicsDocument } from "../graphics/model.js";
import { drawnImageLayers, requireGraphicsImages } from "../graphics/render.js";
import { reviewedGraphics, type GraphicsLook } from "../graphics/service.js";
import { graphicsStillGroups } from "../graphics/stills.js";
import { randomUUID } from "node:crypto";
import type { Engine, NotebookCell, NotebookDocument } from "videobook-engine";
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
  output: RenderOutput;
  sourceArtifactId: string;
  outputArtifactId: string;
  notebookId: string | null;
  language: string;
  revision: string;
  sourceHash: string;
  document: CaptionDocument;
  regions: CaptionRegionFrame[];
  graphics?: { revision: string; document: GraphicsDocument } | null;
  jobId: number | null;
  createdAt: string;
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
  if (!document.success) return null;
  const graphics = value.graphics ? parseGraphicsDocument(value.graphics.document) : null;
  if (graphics && (!graphics.ok || typeof value.graphics?.revision !== "string")) return null;
  return {
    ...value,
    output: renderOutput(value.output),
    document: document.data,
    graphics: graphics?.ok && value.graphics ? { ...value.graphics, document: graphics.document } : null,
  };
}

function requestIndexKey(artifactId: string): string {
  return `captions.requests.${artifactId}`;
}

export function forgetCaptionRenders(engine: Engine, artifactId: string): void {
  for (const requestId of indexedRenderRequests(engine, requestIndexKey(artifactId))) {
    const request = readCaptionRenderRequest(engine, requestId);
    if (request) {
      engine.settings.delete(latestKey(request.sourceArtifactId, request.language));
      if (engine.settings.get<string>(`captions.graphics-render.${request.sourceArtifactId}`) === requestId) engine.settings.delete(`captions.graphics-render.${request.sourceArtifactId}`);
    }
    engine.settings.delete(requestKey(requestId));
  }
  engine.settings.delete(requestIndexKey(artifactId));
}

function fingerprint(sourceArtifactId: string, notebookId: string | null, sourceHash: string, language: string, revision: string, output: RenderOutput, graphics: CaptionRenderRequest["graphics"]): string {
  return renderRequestFingerprint([sourceArtifactId, notebookId, sourceHash, language, revision, ...(output === "replace" ? [output] : []), ...(graphics ? [graphics.revision, JSON.stringify(graphics.document)] : [])]);
}

export function latestCaptionRender(engine: Engine, artifactId: string, language: string): RenderRequestStatus | null {
  const requestId = engine.settings.get<string>(latestKey(artifactId, language));
  const request = typeof requestId === "string" ? readCaptionRenderRequest(engine, requestId) : null;
  return request ? renderRequestStatus(engine, request) : null;
}

function isCaptionOutputCell(cell: NotebookCell, sourceArtifactId: string, language: string): boolean {
  return cell.type === "video"
    && cell.inputs?.sourceOperation === CAPTION_SOURCE_OPERATION
    && cell.inputs?.sourceArtifactId === sourceArtifactId
    && (cell.inputs?.language ?? ORIGINAL_CAPTION_LANGUAGE) === language;
}

export function captionRenderDestination(notebook: NotebookDocument, sourceArtifactId: string, language: string) {
  return renderDestination(notebook, sourceArtifactId, (cell) => isCaptionOutputCell(cell, sourceArtifactId, language), FULL_NOTEBOOK);
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

function reusable(engine: Engine, existing: CaptionRenderRequest, expected: string): RenderRequestStatus | null {
  if (existing.fingerprint !== expected) {
    throw new CaptionServiceError("invalid", "This request ID belongs to a different render. Start a new request.");
  }
  if (!engine.artifacts.get(existing.outputArtifactId).ok) {
    throw new CaptionServiceError("invalid", "The subtitled copy was deleted. Start a new request.");
  }
  return renderRequestRunning(engine, existing) ? renderRequestStatus(engine, existing) : null;
}

export interface CaptionRenderInput {
  withGraphics?: boolean;
  graphicsRevision?: string;
  graphicsLook?: GraphicsLook;
  requestId: string;
  expectedRevision: string;
  sourceHash: string;
  notebookId: string | null;
  output: RenderOutput;
}

export async function requestCaptionRender(engine: Engine, bookId: string, artifactId: string, language: string, input: CaptionRenderInput): Promise<RenderRequestStatus> {
  return withNotebookMutation(`captions-render:${bookId}:${input.requestId}`, async () => {
    const existing = readCaptionRenderRequest(engine, input.requestId);
    const completedReplace = existing?.output === "replace" && renderRequestStatus(engine, existing).status === "completed";
    const graphics = completedReplace && input.withGraphics && existing.graphics && (!input.graphicsRevision || input.graphicsRevision === existing.graphics.revision)
      ? existing.graphics
      : await graphicsSnapshot(engine, artifactId, input);
    const expected = fingerprint(artifactId, input.notebookId, input.sourceHash, language, input.expectedRevision, input.output, graphics);
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
    if (input.output === "replace" && source.kind !== "video") {
      throw new CaptionServiceError("invalid", "Only a video cell can take its subtitles in place. Render a new copy of an exported timeline.");
    }
    if (input.output === "replace" && input.graphicsLook && graphicsAspectChanged(source, { ...ORIGINAL_GRAPHICS_FRAME, aspect: draft.document.aspect })) {
      throw new CaptionServiceError("invalid", "A changed aspect must render into a new video cell.");
    }
    if (input.output === "new") checkDestination(engine, input.notebookId, artifactId, language);
    const request: CaptionRenderRequest = {
      requestId: input.requestId,
      fingerprint: expected,
      output: input.output,
      sourceArtifactId: artifactId,
      outputArtifactId: input.output === "replace"
        ? artifactId
        : existing?.outputArtifactId ?? await outputArtifact(engine, source.label, language),
      notebookId: input.notebookId,
      language,
      revision: draft.revision,
      sourceHash: source.mediaHash,
      document: draft.document,
      regions: regionsSnapshot(engine, source),
      graphics,
      jobId: null,
      createdAt: new Date().toISOString(),
    };
    writeRenderSetting(engine, requestKey(request.requestId), request);
    indexRenderRequest(engine, requestIndexKey(artifactId), input.requestId);
    indexRenderRequest(engine, requestIndexKey(request.outputArtifactId), input.requestId);
    writeRenderSetting(engine, latestKey(artifactId, language), input.requestId);
    if (graphics) writeRenderSetting(engine, `captions.graphics-render.${artifactId}`, input.requestId);
    const job = await queue.enqueue(`caption-render-${input.requestId}-${randomUUID()}`, {
      type: CAPTION_RENDER_JOB,
      bookId,
      assetId: request.outputArtifactId,
      requestId: input.requestId,
    });
    const queued = { ...request, jobId: job.id };
    writeRenderSetting(engine, requestKey(queued.requestId), queued);
    return renderRequestStatus(engine, queued);
  });
}

export function latestStackedCaptionRender(engine: Engine, artifactId: string): RenderRequestStatus | null {
  const id = engine.settings.get<string>(`captions.graphics-render.${artifactId}`);
  const request = typeof id === "string" ? readCaptionRenderRequest(engine, id) : null;
  return request ? renderRequestStatus(engine, request) : null;
}

async function graphicsSnapshot(engine: Engine, artifactId: string, input: CaptionRenderInput): Promise<CaptionRenderRequest["graphics"]> {
  if (!input.withGraphics) return null;
  const draft = readGraphicsDraft(engine, artifactId);
  if (!draft && !input.graphicsLook) throw new CaptionServiceError("not_ready", "Save a graphics draft before rendering subtitles with graphics.");
  if (draft && input.graphicsRevision && draft.revision !== input.graphicsRevision) {
    throw new CaptionServiceError("invalid", "The graphics changed after review. Reload the editor, then render.");
  }
  const reviewed = await reviewedGraphics(engine, artifactId, input.graphicsLook ?? { platform: "tiktok", watermark: false }, input.graphicsRevision ?? draft?.revision ?? "");
  if (reviewed.source.mediaHash !== input.sourceHash) throw new CaptionServiceError("stale_source", "The video changed after review. Reload the editor, then render.");
  if (!graphicsStillGroups(reviewed.document, reviewed.source.durationSeconds).length) {
    throw new CaptionServiceError("invalid", "These graphics have nothing to draw.");
  }
  await requireGraphicsImages(engine, drawnImageLayers(reviewed.document, reviewed.source.durationSeconds));
  return { revision: reviewed.revision, document: reviewed.document };
}
