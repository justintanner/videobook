import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Engine } from "videobook-engine";
import { probeVideo } from "../ffmpeg.js";
import type { ProbeResult } from "../ffmpeg.js";
import { burnGraphics, graphicsBurnFrame } from "../graphics/burn.js";
import type { GraphicsDocument, GraphicsFrame } from "../graphics/model.js";
import { definedFields, parseGraphicsDocument } from "../graphics/model.js";
import { graphicsImagePath, graphicsImageSize } from "../graphics/render.js";
import type { GraphicsStillImage } from "../graphics/render-stills.js";
import { renderGraphicsStills } from "../graphics/render-stills.js";
import { bookWatermarkProfile } from "../graphics/service.js";
import { graphicsStillGroups } from "../graphics/stills.js";
import type { WatermarkCard, WatermarkPatch } from "../graphics/watermark-burn.js";
import { watermarkBurnDocument } from "../graphics/watermark-burn.js";
import type { WatermarkWindow } from "../graphics/watermark-profile.js";
import { watermarkSlotValues } from "../graphics/watermark-profile.js";
import type { LightningWatermarkProfile } from "../lightning-defaults.js";
import { watermarkProfileFor } from "../lightning-defaults.js";
import { logger } from "../logger.js";
import { queue, registerJobHandler } from "../queue.js";
import { scoreWatermarkCornersForCanvas, WATERMARK_OPACITY } from "../remotion/osg-spec.js";
import type { OsgPosition } from "../remotion/subtitles/types.js";
import type { WatermarkHandlePlacement } from "../watermark-handle-position.js";
import type { WatermarkPlatform } from "../watermark-platform.js";
import { watermarkWindow } from "../watermark-timing.js";
import { analyzeOsgPlacement } from "./osg-placement.js";
import { replaceArtifactFileFromPath } from "./_persist-output.js";
import { withLockedLocalLease } from "./_lease.js";

const LOCK_DURATION_MS = 600_000;
const DEFAULT_WATERMARK_FADE_SECONDS = 0.5;
export const MAX_WATERMARK_FADE_SECONDS = 2;
const SCRATCH_PREFIX = "videobook-watermark-burn-";
const OUTPUT_NAME = "watermarked.mp4";
const WHOLE_CLIP: WatermarkWindow = { startSeconds: null, endSeconds: null };
const NOTHING_TO_DRAW = "This watermark draws nothing on this video. Include the handle or the QR code, or add them to the saved watermark template.";

export type WatermarkPlacementSource =
  | "cached"
  | "vision"
  | "analysis"
  | "default"
  | "explicit"
  | "fixed"
  | "template";

export type BurnWatermarkPlacementRequest = {
  fingerprint: string;
  badgeAspect: number;
};

export type BurnWatermarkTemplate = { id: string; document: GraphicsDocument };

export type BurnWatermarkPayload = {
  type: "burn_watermark";
  assetId: string;
  assetDir: string;
  bookId: string;
  videoPath: string;
  platform?: WatermarkPlatform;
  handle?: string;
  url?: string;
  includeQr?: boolean;
  includeHandle?: boolean;
  qrPath?: string;
  handlePath?: string;
  corner: OsgPosition;
  placementSource?: WatermarkPlacementSource;
  placement?: BurnWatermarkPlacementRequest;
  opacity?: number;
  qrOpacity?: number;
  handleOpacity?: number;
  userScale: number;
  includePlatformIcon?: boolean;
  includeHandleBorder?: boolean;
  handlePaddingX?: number;
  handlePaddingY?: number;
  handleRounding?: number;
  handleVerticalPercent?: number;
  handlePlacement?: WatermarkHandlePlacement;
  fadeSeconds?: number;
  startSeconds?: number;
  endSeconds?: number;
  qrStartSeconds?: number;
  qrEndSeconds?: number;
  handleStartSeconds?: number;
  handleEndSeconds?: number;
  cardAssetId?: string;
  credit?: string | null;
  template?: BurnWatermarkTemplate | null;
  patches?: WatermarkPatch[];
  transcribe?: false;
};

export type BurnWatermarkResult = {
  success: true;
  corner: OsgPosition;
  placementSource: WatermarkPlacementSource;
};

type BurnPlacement = { corner: OsgPosition; placementSource: WatermarkPlacementSource };
type BurnCard = { card: WatermarkCard; image: GraphicsStillImage };

async function burnProfile(engine: Engine, payload: BurnWatermarkPayload, platform: WatermarkPlatform): Promise<LightningWatermarkProfile> {
  const base = payload.handle === undefined ? await bookWatermarkProfile(engine, platform) : watermarkProfileFor(platform, null);
  return {
    ...base,
    ...definedFields({
      handle: payload.handle,
      profileUrl: payload.url,
      includePlatformIcon: payload.includePlatformIcon,
      includeHandleBorder: payload.includeHandleBorder,
      handlePaddingX: payload.handlePaddingX,
      handlePaddingY: payload.handlePaddingY,
      handleRounding: payload.handleRounding,
      handlePlacement: payload.handlePlacement,
      handleVerticalPercent: payload.handleVerticalPercent,
    }),
    scale: payload.userScale,
    qrOpacity: payload.qrOpacity ?? payload.opacity ?? WATERMARK_OPACITY,
    handleOpacity: payload.handleOpacity ?? payload.opacity ?? WATERMARK_OPACITY,
    fadeSeconds: payload.fadeSeconds ?? DEFAULT_WATERMARK_FADE_SECONDS,
  };
}

function burnTemplate(template: BurnWatermarkTemplate | null | undefined): GraphicsDocument | null {
  if (!template) return null;
  const parsed = parseGraphicsDocument(template.document);
  if (!parsed.ok) throw new Error(`The saved watermark template cannot be drawn: ${parsed.error}`);
  return parsed.document;
}

async function burnCard(engine: Engine, artifactId: string | undefined): Promise<BurnCard | null> {
  if (!artifactId) return null;
  const path = await graphicsImagePath(engine, artifactId);
  if (!path) throw new Error("The watermark card is no longer an image in this book. Choose another card, or apply the watermark without one.");
  const size = await graphicsImageSize(path);
  if (!size) throw new Error("The size of the watermark card cannot be read.");
  return { card: { artifactId, aspect: size.width / size.height }, image: { path, ...size } };
}

/**
 * Resolve the QR corner inside the job: a deferred vision pass when the tool
 * asked for one, otherwise the corner the tool already settled on. Vision
 * failures degrade to the tool's fallback rather than failing the burn.
 */
async function resolveBurnCorner(
  engine: Engine,
  payload: BurnWatermarkPayload,
  frame: GraphicsFrame,
  signal: AbortSignal,
): Promise<BurnPlacement> {
  const fallback = {
    corner: payload.corner,
    placementSource: payload.placementSource ?? "explicit",
  };
  if (!payload.placement) return fallback;
  try {
    const analysis = await analyzeOsgPlacement(engine, {
      assetId: payload.assetId,
      fingerprint: payload.placement.fingerprint,
      userScale: payload.userScale,
      badgeAspect: payload.placement.badgeAspect,
      signal,
    });
    const corner = scoreWatermarkCornersForCanvas(frame.width, frame.height, analysis.regions, {
      aspect: payload.placement.badgeAspect,
      userScale: payload.userScale,
    }).position;
    return { corner, placementSource: "vision" };
  } catch (err) {
    signal.throwIfAborted();
    logger.warn("watermark-placement-fallback", { assetId: payload.assetId, error: err });
    return fallback;
  }
}

export async function watermarkPayloadDocument(
  engine: Engine,
  payload: BurnWatermarkPayload,
  duration: number,
  frame: GraphicsFrame,
  corner: OsgPosition,
  card: WatermarkCard | null,
): Promise<GraphicsDocument> {
  const platform = payload.platform ?? "tiktok";
  const includeQr = payload.includeQr ?? payload.qrPath !== undefined;
  const includeHandle = payload.includeHandle ?? payload.handlePath !== undefined;
  const profile = await burnProfile(engine, payload, platform);
  return watermarkBurnDocument({
    profile,
    frame,
    includeQr,
    includeHandle,
    corner,
    qrWindow: includeQr
      ? watermarkWindow("QR watermark", duration, payload.qrStartSeconds ?? payload.startSeconds, payload.qrEndSeconds ?? payload.endSeconds)
      : WHOLE_CLIP,
    handleWindow: includeHandle
      ? watermarkWindow("Handle watermark", duration, payload.handleStartSeconds ?? payload.startSeconds, payload.handleEndSeconds ?? payload.endSeconds)
      : WHOLE_CLIP,
    values: { ...watermarkSlotValues(profile), ...(payload.credit ? { credit: payload.credit } : {}) },
    template: burnTemplate(payload.template),
    patches: payload.patches ?? [],
    card,
  });
}

async function burnDocument(
  engine: Engine,
  payload: BurnWatermarkPayload,
  probe: ProbeResult,
  frame: GraphicsFrame,
  placement: BurnPlacement,
  card: BurnCard | null,
): Promise<GraphicsDocument> {
  const document = await watermarkPayloadDocument(engine, payload, probe.videoDuration, frame, placement.corner, card?.card ?? null);
  if (graphicsStillGroups(document, probe.videoDuration).length === 0) throw new Error(NOTHING_TO_DRAW);
  return document;
}

async function burnInto(
  engine: Engine,
  payload: BurnWatermarkPayload,
  signal: AbortSignal,
): Promise<{ videoPath: string; placement: BurnPlacement }> {
  const probe = await probeVideo(payload.videoPath, { signal });
  const frame = graphicsBurnFrame(probe);
  const placement = await resolveBurnCorner(engine, payload, frame, signal);
  const card = await burnCard(engine, payload.cardAssetId);
  const document = await burnDocument(engine, payload, probe, frame, placement, card);
  const scratch = await mkdtemp(join(tmpdir(), SCRATCH_PREFIX));
  try {
    const { groups } = await renderGraphicsStills({
      document,
      frame,
      durationSeconds: probe.videoDuration,
      images: card ? { [card.card.artifactId]: card.image } : {},
      outputDir: scratch,
      signal,
    });
    const outputPath = join(scratch, OUTPUT_NAME);
    await burnGraphics({ videoPath: payload.videoPath, outputPath, stills: groups, probe, signal });
    await replaceArtifactFileFromPath(engine, payload.assetId, basename(payload.videoPath), outputPath);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  await engine.files.delete(payload.assetId, ".original.analysis.json");
  return { videoPath: join(payload.assetDir, basename(payload.videoPath)), placement };
}

export function registerBurnWatermarkJob(engine: Engine): void {
  registerJobHandler("burn_watermark", async (rawPayload, ctx) => {
    const payload = rawPayload as BurnWatermarkPayload;
    const result = await withLockedLocalLease(
      engine,
      payload.assetId,
      payload.assetDir,
      ctx,
      "process",
      { durationMs: LOCK_DURATION_MS, data: { state: "burning-watermark" } },
      () => burnInto(engine, payload, ctx.signal),
      { durationMs: LOCK_DURATION_MS, waitForActiveMs: 30_000 },
    );

    await queue.enqueue(`process-video-${payload.assetId}-${Date.now()}`, {
      type: "process_video",
      videoPath: result.videoPath,
      assetId: payload.assetId,
      assetDir: payload.assetDir,
      bookId: payload.bookId,
      provenance: {
        origin: "watermark",
        watermarked_at: new Date().toISOString(),
        ...(payload.transcribe === false ? { transcribe: false } : {}),
      },
      force: true,
    } as unknown as Record<string, unknown>);

    return {
      success: true,
      corner: result.placement.corner,
      placementSource: result.placement.placementSource,
    } satisfies BurnWatermarkResult;
  });
}
