import { graphicsFrameSchema, ORIGINAL_GRAPHICS_FRAME, type GraphicsFraming } from "./frame.js";
import { createHash } from "node:crypto";
import type { Engine, NotebookDocument } from "videobook-engine";
import { findPrimaryMediaFile, resolveNotebookCellArtifactId } from "videobook-engine";
import { notebookGridAddress } from "videobook-engine/notebook-grid";
import { assetMediaUrls } from "../asset-media-projection.js";
import type { CaptionMediaSource } from "../captions/source.js";
import { captionMediaSource } from "../captions/source.js";
import { cachedFrameRegions } from "../frame-regions.js";
import type { LightningWatermarkProfile } from "../lightning-defaults.js";
import { withNotebookMutation } from "../notebook-mutations.js";
import type { OsgPosition } from "../remotion/subtitles/types.js";
import { effectiveWatermarkProfile, normalizeHandle, readWatermarkConfig, recordHandle, saveWatermarkProfile } from "../watermark-config.js";
import type { WatermarkPlatform } from "../watermark-platform.js";
import { watermarkProfileUrl } from "../watermark-platform.js";
import { profileWatermarkTimes, watermarkWindow } from "../watermark-timing.js";
import type { GraphicsCredit } from "./credit.js";
import { sourceCredit } from "./credit.js";
import type { GraphicsDraft } from "./drafts.js";
import { readGraphicsDraft, writeGraphicsDraft } from "./drafts.js";
import type { GraphicsEdit } from "./edits.js";
import { applyGraphicsEdits } from "./edits.js";
import { GraphicsServiceError } from "./errors.js";
import type { GraphicsDocument, GraphicsFrame, GraphicsLayerInput } from "./model.js";
import { isGraphicsUrl, parseGraphicsDocument } from "./model.js";
import type { GraphicsRegionFrame } from "./placement.js";
import type { GraphicsSlotValues } from "./slots.js";
import { fillGraphicsSlots, graphicsSlotValues } from "./slots.js";
import type { GraphicsStarterId } from "./starters.js";
import { DEFAULT_GRAPHICS_STARTER_ID, GRAPHICS_STARTERS } from "./starters.js";
import type { GraphicsTemplate, GraphicsTemplateStore } from "./templates.js";
import { graphicsTemplateImageIds, readGraphicsTemplates, watermarkGraphicsTemplate } from "./templates.js";
import { watermarkDrawnDocument, watermarkLookDocument, watermarkTemplateDraws } from "./watermark-burn.js";
import type { WatermarkWindow } from "./watermark-profile.js";
import { watermarkLayerInputs, watermarkSlotValues } from "./watermark-profile.js";

type GraphicsImage = { label: string | null; url: string | null; width: number | null; height: number | null };
type GraphicsStarterDocument = { id: GraphicsStarterId; name: string; document: GraphicsDocument };
type GraphicsSavedTemplate = { id: string; name: string; updated_at: string; document: GraphicsDocument; missing_layer_ids: string[] };
type Revisioned = { revision: string; document: GraphicsDocument };

export type GraphicsLook = { platform: WatermarkPlatform; watermark: boolean };

type GraphicsWatermarkLook = {
  platform: WatermarkPlatform;
  template_id: string | null;
  template_name: string | null;
  look: GraphicsDocument;
  qr: GraphicsLayerInput | null;
};

export type GraphicsReadModel = {
  asset_id: string;
  address: string | null;
  label: string | null;
  source: { width: number; height: number; duration_seconds: number; fps: number; source_hash: string };
  saved: boolean;
  revision: string;
  updated_at: string | null;
  document: GraphicsDocument;
  frame: GraphicsFraming;
  fill: { handle: string | null; profile_url: string | null; credit: string | null };
  starters: GraphicsStarterDocument[];
  templates: GraphicsSavedTemplate[];
  default_template_id: string;
  images: Record<string, GraphicsImage>;
  watermark: GraphicsWatermarkLook | null;
  regions: GraphicsRegionFrame[];
};

type GraphicsContext = {
  source: CaptionMediaSource;
  saved: GraphicsDraft | null;
  fallback: Revisioned;
  credit: GraphicsCredit | null;
  values: GraphicsSlotValues;
  starters: GraphicsStarterDocument[];
  templates: GraphicsTemplateStore;
  watermark: GraphicsWatermarkLook | null;
};

type ReviewedGraphics = { source: CaptionMediaSource; revision: string; document: GraphicsDocument; frame: GraphicsFraming };

type GraphicsUpdateInput = {
  expectedRevision: string;
  look: GraphicsLook;
  edits?: readonly GraphicsEdit[];
  document?: unknown;
  frame?: unknown;
};

const VIDEO_KINDS: ReadonlySet<string> = new Set(["video", "final"]);
const WATERMARK_CORNER: OsgPosition = "bottom-right";
const WHOLE_CLIP: WatermarkWindow = { startSeconds: null, endSeconds: null };

export function requireVideo(engine: Engine, artifactId: string): void {
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

function defaultTemplateDocument(
  templates: GraphicsTemplateStore,
  starters: readonly GraphicsStarterDocument[],
  values: GraphicsSlotValues,
): GraphicsDocument {
  const id = templates.defaultId ?? DEFAULT_GRAPHICS_STARTER_ID;
  const saved = templates.templates.find((template) => template.id === id);
  if (saved) return fillGraphicsSlots(saved.document, values, { overwrite: false });
  const starter = starters.find((candidate) => candidate.id === id)
    ?? starters.find((candidate) => candidate.id === DEFAULT_GRAPHICS_STARTER_ID)
    ?? starters[0];
  return starter.document;
}

function defaultDocument(document: GraphicsDocument): Revisioned {
  const digest = createHash("sha256").update(JSON.stringify(document)).digest("hex").slice(0, 32);
  return { revision: `default:${digest}`, document };
}

export async function bookWatermarkProfile(engine: Engine, platform: WatermarkPlatform): Promise<LightningWatermarkProfile> {
  const config = await readWatermarkConfig(engine, platform);
  const profile = effectiveWatermarkProfile(config, platform);
  const handle = normalizeHandle(config.savedHandle ?? config.authenticatedHandle ?? config.recent[0] ?? profile.handle) ?? "";
  const storedUrl = typeof config.profile?.profileUrl === "string" ? config.profile.profileUrl.trim() : "";
  return { ...profile, handle, profileUrl: storedUrl || (handle ? watermarkProfileUrl(handle, platform) : "") };
}

function lookWindow(included: boolean, label: string, durationSeconds: number, startSeconds?: number, endSeconds?: number): WatermarkWindow {
  if (!included) return WHOLE_CLIP;
  try {
    return watermarkWindow(label, durationSeconds, startSeconds, endSeconds);
  } catch {
    return WHOLE_CLIP;
  }
}

function profileCorner(profile: LightningWatermarkProfile): OsgPosition {
  return profile.qrPosition === "auto" ? WATERMARK_CORNER : profile.qrPosition;
}

type WatermarkLookInput = {
  source: CaptionMediaSource;
  profile: LightningWatermarkProfile;
  values: GraphicsSlotValues;
  template: GraphicsTemplate | null;
};

async function watermarkLook(engine: Engine, platform: WatermarkPlatform, input: WatermarkLookInput): Promise<GraphicsWatermarkLook> {
  const { source, profile, template } = input;
  const config = await readWatermarkConfig(engine, platform);
  const draws = template ? watermarkTemplateDraws(template.document) : null;
  const includeQr = draws?.qr ?? false;
  const includeHandle = draws?.handle ?? true;
  const frame = { width: source.width, height: source.height };
  const duration = source.durationSeconds;
  const times = profileWatermarkTimes(config.profile, profile, duration);
  const qrWindow = lookWindow(includeQr, "QR watermark", duration, times.qrStartSeconds, times.qrEndSeconds);
  const handleWindow = lookWindow(includeHandle, "Handle watermark", duration, times.handleStartSeconds, times.handleEndSeconds);
  const look = watermarkLookDocument({
    profile,
    frame,
    includeQr,
    includeHandle,
    corner: WATERMARK_CORNER,
    qrWindow,
    handleWindow,
    values: input.values,
    template: template?.document ?? null,
    patches: [],
    card: null,
  });
  const qr = watermarkLayerInputs(profile, frame, {
    includeQr: true,
    includeHandle: false,
    corner: profileCorner(profile),
    qrWindow: lookWindow(true, "QR watermark", duration, times.qrStartSeconds, times.qrEndSeconds),
  })[0] ?? null;
  return { platform, template_id: template?.id ?? null, template_name: template?.name ?? null, look, qr };
}

async function graphicsContext(engine: Engine, artifactId: string, look: GraphicsLook): Promise<GraphicsContext> {
  requireVideo(engine, artifactId);
  const source = await captionMediaSource(engine, artifactId);
  const profile = await bookWatermarkProfile(engine, look.platform);
  const credit = await sourceCredit(engine, artifactId);
  const values: GraphicsSlotValues = { ...watermarkSlotValues(profile), ...(credit ? { credit: credit.text } : {}) };
  const starters = starterDocuments({ width: source.width, height: source.height }, profile, values);
  const templates = readGraphicsTemplates(engine);
  const watermark = look.watermark
    ? await watermarkLook(engine, look.platform, { source, profile, values, template: watermarkGraphicsTemplate(engine, look.platform) })
    : null;
  const fallback = defaultDocument(watermark?.look ?? defaultTemplateDocument(templates, starters, values));
  return { source, saved: readGraphicsDraft(engine, artifactId), fallback, credit, values, starters, templates, watermark };
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

function templateImageIds(templates: GraphicsTemplateStore): string[] {
  return templates.templates.flatMap((template) => graphicsTemplateImageIds(template.document));
}

async function bookImages(engine: Engine, ids: readonly string[]): Promise<Record<string, GraphicsImage>> {
  const entries = await Promise.all([...new Set(ids)].map(async (id) => [id, await imageInfo(engine, id)] as const));
  return Object.fromEntries(entries.filter((entry): entry is readonly [string, GraphicsImage] => entry[1] !== null));
}

function savedTemplates(context: GraphicsContext, images: Record<string, GraphicsImage>): GraphicsSavedTemplate[] {
  return context.templates.templates.map((template) => ({
    id: template.id,
    name: template.name,
    updated_at: template.updatedAt,
    document: fillGraphicsSlots(template.document, context.values, { overwrite: false }),
    missing_layer_ids: template.document.layers.flatMap((layer) => (layer.kind === "image" && !images[layer.artifactId]?.url ? [layer.id] : [])),
  }));
}

export async function readGraphics(
  engine: Engine,
  artifactId: string,
  options: { notebookId: string | null; look: GraphicsLook },
): Promise<GraphicsReadModel> {
  const context = await graphicsContext(engine, artifactId, options.look);
  const current = context.saved ?? context.fallback;
  const images = await bookImages(engine, [...graphicsTemplateImageIds(current.document), ...templateImageIds(context.templates)]);
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
    frame: options.look.watermark ? ORIGINAL_GRAPHICS_FRAME : context.saved?.frame ?? ORIGINAL_GRAPHICS_FRAME,
    fill: {
      handle: context.values.handle ?? null,
      profile_url: context.values.profile ?? null,
      credit: context.credit?.text ?? null,
    },
    starters: context.starters,
    templates: savedTemplates(context, images),
    default_template_id: context.templates.defaultId ?? DEFAULT_GRAPHICS_STARTER_ID,
    images,
    watermark: context.watermark,
    regions: cachedFrameRegions(engine, context.source.mediaHash),
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

function requireBookImages(engine: Engine, before: GraphicsDocument, after: GraphicsDocument, templates: GraphicsTemplateStore): void {
  const known = new Set([...graphicsTemplateImageIds(before), ...templateImageIds(templates)]);
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
    const context = await graphicsContext(engine, artifactId, input.look);
    const current = context.saved ?? context.fallback;
    if (current.revision !== input.expectedRevision) {
      throw new GraphicsServiceError("conflict", "These graphics changed somewhere else. Reload them before editing.", { revision: current.revision });
    }
    const next = nextDocument(current.document, input);
    requireBookImages(engine, current.document, next, context.templates);
    const frame = graphicsFrameSchema.safeParse(input.frame ?? context.saved?.frame ?? ORIGINAL_GRAPHICS_FRAME);
    if (!frame.success) throw new GraphicsServiceError("invalid", "Choose a valid frame, fit and focus point.");
    if (input.look.watermark && input.frame !== undefined && frame.data.aspect !== "original") throw new GraphicsServiceError("invalid", "Watermarks use the source frame.");
    return writeGraphicsDraft(engine, artifactId, next, frame.data);
  });
}

export async function currentGraphics(engine: Engine, artifactId: string, look: GraphicsLook): Promise<ReviewedGraphics> {
  const context = await graphicsContext(engine, artifactId, look);
  const current = context.saved ?? context.fallback;
  return { source: context.source, revision: current.revision, document: current.document, frame: look.watermark ? ORIGINAL_GRAPHICS_FRAME : context.saved?.frame ?? ORIGINAL_GRAPHICS_FRAME };
}

export async function graphicsForTemplate(
  engine: Engine,
  artifactId: string,
  look: GraphicsLook,
  expectedRevision: string | undefined,
): Promise<GraphicsDocument> {
  const current = await currentGraphics(engine, artifactId, look);
  if (expectedRevision !== undefined && current.revision !== expectedRevision) {
    throw new GraphicsServiceError("conflict", "These graphics changed somewhere else. Reload them before saving a template.", { revision: current.revision });
  }
  return current.document;
}

export async function reviewedGraphics(
  engine: Engine,
  artifactId: string,
  look: GraphicsLook,
  expectedRevision: string,
): Promise<ReviewedGraphics> {
  const context = await graphicsContext(engine, artifactId, look);
  const current = context.saved ?? context.fallback;
  if (current.revision !== expectedRevision) {
    throw new GraphicsServiceError("conflict", "These graphics changed after review. Review the latest version, then render.", { revision: current.revision });
  }
  const document = look.watermark ? watermarkDrawnDocument(current.document) : current.document;
  return { source: context.source, revision: current.revision, document, frame: look.watermark ? ORIGINAL_GRAPHICS_FRAME : context.saved?.frame ?? ORIGINAL_GRAPHICS_FRAME };
}

export async function rememberWatermarkSlots(engine: Engine, platform: WatermarkPlatform, document: GraphicsDocument): Promise<void> {
  const profile = await bookWatermarkProfile(engine, platform);
  const slots = graphicsSlotValues(document);
  const handle = normalizeHandle(slots.handle ?? "");
  if (handle && handle !== profile.handle) await recordHandle(handle, { saveDefault: true, platform }, engine);
  const url = slots.profile?.trim() ?? "";
  if (url && isGraphicsUrl(url) && url !== profile.profileUrl) await saveWatermarkProfile({ profileUrl: url }, platform, engine);
}
