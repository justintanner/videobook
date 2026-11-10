import { createHash } from "node:crypto";
import type { Engine, NotebookDocument } from "videobook-engine";
import { findPrimaryMediaFile, resolveNotebookCellArtifactId } from "videobook-engine";
import { notebookGridAddress } from "videobook-engine/notebook-grid";
import { assetMediaUrls } from "../asset-media-projection.js";
import type { CaptionMediaSource } from "../captions/source.js";
import { captionMediaSource } from "../captions/source.js";
import type { LightningWatermarkProfile } from "../lightning-defaults.js";
import { withNotebookMutation } from "../notebook-mutations.js";
import { effectiveWatermarkProfile, normalizeHandle, readWatermarkConfig } from "../watermark-config.js";
import type { WatermarkPlatform } from "../watermark-platform.js";
import { watermarkProfileUrl } from "../watermark-platform.js";
import type { GraphicsCredit } from "./credit.js";
import { sourceCredit } from "./credit.js";
import type { GraphicsDraft } from "./drafts.js";
import { readGraphicsDraft, writeGraphicsDraft } from "./drafts.js";
import type { GraphicsEdit, GraphicsEditError } from "./edits.js";
import { applyGraphicsEdits } from "./edits.js";
import type { GraphicsDocument, GraphicsFrame } from "./model.js";
import { parseGraphicsDocument } from "./model.js";
import type { GraphicsSlotValues } from "./slots.js";
import { fillGraphicsSlots } from "./slots.js";
import type { GraphicsStarterId } from "./starters.js";
import { DEFAULT_GRAPHICS_STARTER_ID, GRAPHICS_STARTERS } from "./starters.js";
import { watermarkSlotValues } from "./watermark-profile.js";

type GraphicsServiceErrorCode = "conflict" | "invalid" | "not_ready" | "stale_source";

type GraphicsErrorDetails = {
  revision?: string;
  edit?: Omit<GraphicsEditError, "message">;
  issues?: string[];
  layer_id?: string;
};

export class GraphicsServiceError extends Error {
  readonly code: GraphicsServiceErrorCode;
  readonly details: GraphicsErrorDetails;

  constructor(code: GraphicsServiceErrorCode, message: string, details: GraphicsErrorDetails = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

type GraphicsImage = { label: string | null; url: string | null; width: number | null; height: number | null };
type GraphicsStarterDocument = { id: GraphicsStarterId; name: string; document: GraphicsDocument };
type Revisioned = { revision: string; document: GraphicsDocument };

export type GraphicsReadModel = {
  asset_id: string;
  address: string | null;
  label: string | null;
  source: { width: number; height: number; duration_seconds: number; fps: number; source_hash: string };
  saved: boolean;
  revision: string;
  updated_at: string | null;
  document: GraphicsDocument;
  fill: { handle: string | null; profile_url: string | null; credit: string | null };
  starters: GraphicsStarterDocument[];
  images: Record<string, GraphicsImage>;
};

type GraphicsContext = {
  source: CaptionMediaSource;
  saved: GraphicsDraft | null;
  fallback: Revisioned;
  credit: GraphicsCredit | null;
  values: GraphicsSlotValues;
  starters: GraphicsStarterDocument[];
};

type ReviewedGraphics = { source: CaptionMediaSource; revision: string; document: GraphicsDocument };

type GraphicsUpdateInput = {
  expectedRevision: string;
  platform: WatermarkPlatform;
  edits?: readonly GraphicsEdit[];
  document?: unknown;
};

const VIDEO_KINDS: ReadonlySet<string> = new Set(["video", "final"]);

function requireVideo(engine: Engine, artifactId: string): void {
  const artifact = engine.artifacts.get(artifactId);
  if (!artifact.ok) throw new GraphicsServiceError("invalid", artifact.error.message);
  if (!VIDEO_KINDS.has(artifact.value.kind)) {
    throw new GraphicsServiceError("invalid", "On-screen graphics go on a video. Choose a video cell.");
  }
}

function starterDocuments(frame: GraphicsFrame, profile: LightningWatermarkProfile, values: GraphicsSlotValues): GraphicsStarterDocument[] {
  return GRAPHICS_STARTERS.map((starter) => ({
    id: starter.id,
    name: starter.name,
    document: fillGraphicsSlots(starter.build(frame, profile), values, { overwrite: false }),
  }));
}

function defaultDocument(starters: readonly GraphicsStarterDocument[]): Revisioned {
  const starter = starters.find((candidate) => candidate.id === DEFAULT_GRAPHICS_STARTER_ID) ?? starters[0];
  const digest = createHash("sha256").update(JSON.stringify(starter.document)).digest("hex").slice(0, 32);
  return { revision: `default:${digest}`, document: starter.document };
}

async function bookWatermarkProfile(engine: Engine, platform: WatermarkPlatform): Promise<LightningWatermarkProfile> {
  const config = await readWatermarkConfig(engine, platform);
  const profile = effectiveWatermarkProfile(config, platform);
  const handle = normalizeHandle(config.savedHandle ?? config.authenticatedHandle ?? config.recent[0] ?? profile.handle) ?? "";
  const storedUrl = typeof config.profile?.profileUrl === "string" ? config.profile.profileUrl.trim() : "";
  return { ...profile, handle, profileUrl: storedUrl || (handle ? watermarkProfileUrl(handle, platform) : "") };
}

async function graphicsContext(engine: Engine, artifactId: string, platform: WatermarkPlatform): Promise<GraphicsContext> {
  requireVideo(engine, artifactId);
  const source = await captionMediaSource(engine, artifactId);
  const profile = await bookWatermarkProfile(engine, platform);
  const credit = await sourceCredit(engine, artifactId);
  const values: GraphicsSlotValues = { ...watermarkSlotValues(profile), ...(credit ? { credit: credit.text } : {}) };
  const starters = starterDocuments({ width: source.width, height: source.height }, profile, values);
  return { source, saved: readGraphicsDraft(engine, artifactId), fallback: defaultDocument(starters), credit, values, starters };
}

function notebooksFor(engine: Engine, notebookId: string | null): NotebookDocument[] {
  if (!notebookId) return engine.notebooks.list();
  const notebook = engine.notebooks.read(notebookId);
  return notebook.ok ? [notebook.value] : [];
}

function videoAddress(engine: Engine, artifactId: string, notebookId: string | null): string | null {
  for (const notebook of notebooksFor(engine, notebookId)) {
    const holders = notebook.cells.filter((cell) => resolveNotebookCellArtifactId(notebook, cell) === artifactId);
    const cell = holders.find((candidate) => candidate.type === "video") ?? holders[0];
    if (cell) return `@${notebookGridAddress(cell.slot)}`;
  }
  return null;
}

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

async function imageInfo(engine: Engine, artifactId: string): Promise<GraphicsImage | null> {
  const artifact = engine.artifacts.get(artifactId);
  if (!artifact.ok || artifact.value.kind !== "image") return null;
  const manifest = await engine.files.manifest(artifactId);
  if (!manifest.ok) return null;
  const urls = assetMediaUrls({
    bookId: engine.book.get().bookId,
    artifact: artifact.value,
    files: manifest.value.files,
    mediaFile: findPrimaryMediaFile(manifest.value.files, "image"),
    proxyFile: null,
  });
  const original = await engine.metadata.artifacts.read<{ width?: unknown; height?: unknown }>(artifactId, "original");
  const size = original.ok && original.value ? original.value : {};
  return { label: artifact.value.label ?? null, url: urls.media_url, width: positive(size.width), height: positive(size.height) };
}

function imageIds(document: GraphicsDocument): string[] {
  return [...new Set(document.layers.flatMap((layer) => (layer.kind === "image" ? [layer.artifactId] : [])))];
}

async function documentImages(engine: Engine, document: GraphicsDocument): Promise<Record<string, GraphicsImage>> {
  const entries = await Promise.all(imageIds(document).map(async (id) => [id, await imageInfo(engine, id)] as const));
  return Object.fromEntries(entries.filter((entry): entry is readonly [string, GraphicsImage] => entry[1] !== null));
}

export async function readGraphics(
  engine: Engine,
  artifactId: string,
  options: { notebookId: string | null; platform: WatermarkPlatform },
): Promise<GraphicsReadModel> {
  const context = await graphicsContext(engine, artifactId, options.platform);
  const current = context.saved ?? context.fallback;
  return {
    asset_id: artifactId,
    address: videoAddress(engine, artifactId, options.notebookId),
    label: context.source.label,
    source: {
      width: context.source.width,
      height: context.source.height,
      duration_seconds: context.source.durationSeconds,
      fps: context.source.fps,
      source_hash: context.source.mediaHash,
    },
    saved: context.saved !== null,
    revision: current.revision,
    updated_at: context.saved?.updatedAt ?? null,
    document: current.document,
    fill: {
      handle: context.values.handle ?? null,
      profile_url: context.values.profile ?? null,
      credit: context.credit?.text ?? null,
    },
    starters: context.starters,
    images: await documentImages(engine, current.document),
  };
}

function nextDocument(current: GraphicsDocument, input: GraphicsUpdateInput): GraphicsDocument {
  if (input.document !== undefined) {
    const parsed = parseGraphicsDocument(input.document);
    if (!parsed.ok) throw new GraphicsServiceError("invalid", parsed.error, { issues: parsed.issues });
    return parsed.document;
  }
  const applied = applyGraphicsEdits(current, input.edits ?? []);
  if (applied.ok) return applied.document;
  const { message, ...edit } = applied.error;
  throw new GraphicsServiceError("invalid", message, { edit });
}

function requireBookImages(engine: Engine, before: GraphicsDocument, after: GraphicsDocument): void {
  const known = new Set(imageIds(before));
  for (const layer of after.layers) {
    if (layer.kind !== "image" || known.has(layer.artifactId)) continue;
    const artifact = engine.artifacts.get(layer.artifactId);
    if (!artifact.ok || artifact.value.kind !== "image") {
      throw new GraphicsServiceError(
        "invalid",
        `Layer ${layer.id} names ${layer.artifactId}, which is not an image artifact in this book.`,
        { layer_id: layer.id },
      );
    }
  }
}

export async function updateGraphics(engine: Engine, artifactId: string, input: GraphicsUpdateInput): Promise<GraphicsDraft> {
  return withNotebookMutation(`graphics:${artifactId}`, async () => {
    const context = await graphicsContext(engine, artifactId, input.platform);
    const current = context.saved ?? context.fallback;
    if (current.revision !== input.expectedRevision) {
      throw new GraphicsServiceError("conflict", "These graphics changed somewhere else. Reload them before editing.", { revision: current.revision });
    }
    const next = nextDocument(current.document, input);
    requireBookImages(engine, current.document, next);
    return writeGraphicsDraft(engine, artifactId, next);
  });
}

export async function reviewedGraphics(
  engine: Engine,
  artifactId: string,
  platform: WatermarkPlatform,
  expectedRevision: string,
): Promise<ReviewedGraphics> {
  const context = await graphicsContext(engine, artifactId, platform);
  const current = context.saved ?? context.fallback;
  if (current.revision !== expectedRevision) {
    throw new GraphicsServiceError("conflict", "These graphics changed after review. Review the latest version, then render.", { revision: current.revision });
  }
  return { source: context.source, revision: current.revision, document: current.document };
}
