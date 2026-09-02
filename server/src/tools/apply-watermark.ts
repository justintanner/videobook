import type { Engine } from "videobook-engine";
import { findVideoFile } from "videobook-engine";
import { join } from "node:path";
import { z } from "zod";
import { getApiKey } from "../api-key.js";
import { probeVideo } from "../ffmpeg.js";
import { sampleEvenly } from "../frame-utils.js";
import {
  DEFAULT_WATERMARK_FADE_SECONDS,
  MAX_WATERMARK_FADE_SECONDS,
} from "../jobs/burn-watermark.js";
import type {
  BurnWatermarkPayload,
  BurnWatermarkPlacementRequest,
  BurnWatermarkResult,
  WatermarkPlacementSource,
} from "../jobs/burn-watermark.js";
import type { OsgPlacementResult } from "../jobs/osg-placement.js";
import { resolveOsgImagePath } from "../osg-assets.js";
import {
  osgPlacementFingerprint,
  readOsgPlacementAnalysis,
} from "../osg-placement-cache.js";
import type { OsgPlacementAnalysis } from "../osg-placement-cache.js";
import { writeOsgSettings } from "../osg-settings.js";
import type { ArtifactManifestFile } from "videobook-engine";
import { logger } from "../logger.js";
import { queue } from "../queue.js";
import {
  scoreWatermarkCornersForCanvas,
  WATERMARK_MIN_DIM_FRACTION,
  WATERMARK_OPACITY,
  WATERMARK_OSG_SIZE,
  watermarkOsgScale,
} from "../remotion/osg-spec.js";
import type { Orientation, OsgPosition } from "../remotion/subtitles/types.js";
import {
  createWatermarkAsset,
  DEFAULT_HANDLE_PADDING,
  DEFAULT_HANDLE_ROUNDING,
  DEFAULT_HANDLE,
  defaultUrl,
  findWatermarkAsset,
  MAX_HANDLE_PADDING,
  MAX_HANDLE_ROUNDING,
  MIN_HANDLE_PADDING,
  MIN_HANDLE_ROUNDING,
  QR_ONLY_BADGE_ASPECT,
  watermarkBadgeAspect,
} from "../watermark-badge.js";
import type { WatermarkBadgeVariant } from "../watermark-badge.js";
import { readWatermarkConfig, recordHandle } from "../watermark-config.js";
import {
  DEFAULT_HANDLE_VERTICAL_PERCENT,
  MAX_HANDLE_VERTICAL_PERCENT,
  MIN_HANDLE_VERTICAL_PERCENT,
  WATERMARK_HANDLE_PLACEMENTS,
} from "../watermark-handle-position.js";
import type { WatermarkHandlePlacement } from "../watermark-handle-position.js";
import type { ToolDef } from "./tool-def.js";
import { requireArtifactKind } from "./_shared.js";
import { waitForAssetReadyDef } from "./wait-for-asset-ready.js";

const PLACEMENT_TIMEOUT_MS = 300_000;
const BURN_TIMEOUT_MS = 600_000;
const MAX_PLACEMENT_FRAMES = 8;
const WATERMARK_POSITIONS = [
  "top-left", "top-center", "top-right",
  "middle-left", "middle-center", "middle-right",
  "bottom-left", "bottom-center", "bottom-right",
] as const;
const WATERMARK_POSITION_OPTIONS = ["auto", ...WATERMARK_POSITIONS] as const;

const ANALYSIS_OSG_POSITIONS = new Set(["top-left", "top-right", "bottom-left", "bottom-right"]);
const DEFAULT_POSITION: OsgPosition = "bottom-right";

type WatermarkPositionOption = "auto" | OsgPosition;
type PlacementScaling = { aspect: number; userScale: number };
type OverlayPlacement = {
  positions: Record<Orientation, OsgPosition>;
  placementSource: WatermarkPlacementSource;
  jobId?: string;
};
type BurnPlacement = {
  corner: OsgPosition;
  placementSource: WatermarkPlacementSource;
  visionRequest: BurnWatermarkPlacementRequest | null;
};
type WatermarkAssetAppearance = {
  includeXIcon: boolean;
  includeHandleBorder: boolean;
  handlePadding: number;
  handlePaddingY: number;
  handleRounding: number;
};

type WatermarkAssetResolution =
  | { ok: true; assetId: string }
  | { ok: false; error: string };

function uniformPositions(position: OsgPosition): Record<Orientation, OsgPosition> {
  return { landscape: position, portrait: position, square: position };
}

function watermarkTimingError(
  fieldPrefix: "qr" | "handle",
  startSeconds?: number,
  endSeconds?: number,
): string | null {
  const start = startSeconds ?? 0;
  return endSeconds !== undefined && endSeconds <= start
    ? `${fieldPrefix}_end_seconds must be greater than ${fieldPrefix}_start_seconds`
    : null;
}

function watermarkVariantForApply(
  mode: "burn" | "overlay",
  includeQr: boolean,
  includeHandle: boolean,
): WatermarkBadgeVariant {
  if (includeQr && !includeHandle) return "qr";
  if (!includeQr) return "handle";
  return mode === "burn" ? "qr" : "combined";
}

async function resolveWatermarkAsset(
  engine: Engine,
  handle: string,
  url: string,
  variant: WatermarkBadgeVariant,
  appearance: WatermarkAssetAppearance,
): Promise<WatermarkAssetResolution> {
  const options = { variant, ...appearance };
  const existing = await findWatermarkAsset(engine, handle, url, options);
  if (existing) return { ok: true, assetId: existing };
  return createWatermarkAsset(engine, handle, url, options);
}

/** Coarse fallback: the corner analyze-video recommended for this clip. */
async function readRecommendedOsgPosition(engine: Engine, assetId: string): Promise<OsgPosition | null> {
  const result = await engine.files.read(assetId, ".original.analysis.json");
  if (!result.ok) return null;
  try {
    const raw = typeof result.value === "string"
      ? result.value
      : new TextDecoder().decode(result.value);
    const analysis = JSON.parse(raw) as Record<string, unknown>;
    const position = analysis.recommendedOsgPosition;
    return typeof position === "string" && ANALYSIS_OSG_POSITIONS.has(position)
      ? position as OsgPosition
      : null;
  } catch {
    return null;
  }
}

async function listPlacementFrames(engine: Engine, assetId: string): Promise<string[]> {
  const framesResult = await engine.files.listSubdir(assetId, "original_frames");
  if (!framesResult.ok) return [];
  return sampleEvenly(
    framesResult.value.filter((f) => f.endsWith(".jpg")).sort((a, b) => parseFloat(a) - parseFloat(b)),
    MAX_PLACEMENT_FRAMES,
  );
}

function placementFingerprint(
  videoFile: ArtifactManifestFile,
  frameNames: string[],
  scaling: PlacementScaling,
): string {
  return osgPlacementFingerprint(videoFile, frameNames, {
    aspect: scaling.aspect,
    minDimFraction: WATERMARK_MIN_DIM_FRACTION,
    userScale: scaling.userScale,
  });
}

/**
 * Overlay placement: per-orientation corners. Never fails on placement
 * problems — degrade: cache → vision job → analyze-video recommendation →
 * bottom-right.
 */
async function resolveOverlayPlacement(
  engine: Engine,
  bookId: string,
  assetId: string,
  assetDir: string,
  videoFile: ArtifactManifestFile,
  position: WatermarkPositionOption,
  scaling: PlacementScaling,
): Promise<OverlayPlacement> {
  if (position !== "auto") {
    return { positions: uniformPositions(position), placementSource: "explicit" };
  }
  const frameNames = await listPlacementFrames(engine, assetId);
  const fingerprint = placementFingerprint(videoFile, frameNames, scaling);
  const cached = await readOsgPlacementAnalysis(engine, assetId);
  if (cached && cached.fingerprint === fingerprint) {
    return { positions: cached.positions, placementSource: "cached" };
  }
  if (getApiKey("OPENAI_API_KEY") && frameNames.length > 0) {
    const jobId = `osg-placement-${assetId}-${Date.now()}`;
    try {
      await engine.jobs.failures.clear(assetId);
      const result = await queue.enqueueAndWait<OsgPlacementResult>(jobId, {
        type: "osg_placement",
        assetId,
        assetDir,
        bookId,
        fingerprint,
        userScale: scaling.userScale,
        badgeAspect: scaling.aspect,
      }, PLACEMENT_TIMEOUT_MS);
      return { positions: result.analysis.positions, placementSource: "vision", jobId };
    } catch (err) {
      logger.warn(`[apply_watermark] placement job failed for ${assetId}, falling back:`, err instanceof Error ? err.message : err);
    }
  }
  const recommended = await readRecommendedOsgPosition(engine, assetId);
  return recommended
    ? { positions: uniformPositions(recommended), placementSource: "analysis" }
    : { positions: uniformPositions(DEFAULT_POSITION), placementSource: "default" };
}

async function scoreCachedCorner(
  videoPath: string,
  analysis: OsgPlacementAnalysis,
  scaling: PlacementScaling,
  fallback: OsgPosition,
): Promise<OsgPosition> {
  // Score corners against the source frame itself — a burned watermark
  // lives in source pixels, so one corner serves every orientation.
  try {
    const probe = await probeVideo(videoPath);
    return scoreWatermarkCornersForCanvas(probe.width, probe.height, analysis.regions, scaling).position;
  } catch (err) {
    logger.warn(`[apply_watermark] probe failed for ${videoPath}, using ${fallback}:`, err instanceof Error ? err.message : err);
    return fallback;
  }
}

/**
 * Burn placement: one corner. Cached analyses resolve here; a fresh vision
 * pass is handed to the burn job so the tool can return before it runs, with
 * the analyze-video recommendation (or bottom-right) as its fallback.
 */
async function resolveBurnPlacement(
  engine: Engine,
  assetId: string,
  videoFile: ArtifactManifestFile,
  videoPath: string,
  position: WatermarkPositionOption,
  scaling: PlacementScaling,
): Promise<BurnPlacement> {
  if (position !== "auto") {
    return { corner: position, placementSource: "explicit", visionRequest: null };
  }
  const frameNames = await listPlacementFrames(engine, assetId);
  const fingerprint = placementFingerprint(videoFile, frameNames, scaling);
  const cached = await readOsgPlacementAnalysis(engine, assetId);
  if (cached && cached.fingerprint === fingerprint) {
    return {
      corner: await scoreCachedCorner(videoPath, cached, scaling, DEFAULT_POSITION),
      placementSource: "cached",
      visionRequest: null,
    };
  }
  const recommended = await readRecommendedOsgPosition(engine, assetId);
  const visionAvailable = Boolean(getApiKey("OPENAI_API_KEY")) && frameNames.length > 0;
  return {
    corner: recommended ?? DEFAULT_POSITION,
    placementSource: recommended ? "analysis" : "default",
    visionRequest: visionAvailable ? { fingerprint, badgeAspect: scaling.aspect } : null,
  };
}

export function applyWatermarkDef(engine: Engine): ToolDef {
  return {
    name: "apply_watermark",
    description:
      "Previewed watermark apply for video: burns an optional positioned QR and optional X handle. The handle can stay horizontally centered or sit above, on, or below the QR. At least one must be included. Burn mode supports optional X icon and handle border, independent handle padding X/Y and corner rounding, independent QR/handle opacity, independent visibility windows that fade in/out at any edge inside the clip, and adjustable handle height. Pass wait=false to return once the burn is queued (poll list_jobs or wait_for_asset_ready). Pass mode=overlay to store a legacy single-card render-time overlay instead.",
    schema: {
      book_id: z.string().describe("Book id"),
      asset_id: z.string().describe("Video asset id to watermark"),
      handle: z.string().optional().describe("X handle without @ (default: saved handle)"),
      url: z.string().optional().describe("URL the QR code resolves to (default: https://x.com/<handle>)"),
      save_default: z
        .boolean()
        .optional()
        .describe("Remember this handle as the default for future watermarks"),
      include_qr: z
        .boolean()
        .optional()
        .describe("Include a separately positioned QR watermark (default true); false applies only the centered handle"),
      include_handle: z
        .boolean()
        .optional()
        .describe("Include the handle watermark (default true); false applies only the QR"),
      position: z
        .enum(WATERMARK_POSITION_OPTIONS)
        .optional()
        .describe("QR placement anchor, or auto (default) to choose the least-busy corner"),
      handle_vertical_percent: z
        .number()
        .min(MIN_HANDLE_VERTICAL_PERCENT)
        .max(MAX_HANDLE_VERTICAL_PERCENT)
        .optional()
        .describe("Burn-mode centered-handle centerline as percent from the top (default 33; range 10-90). Ignored when handle_position attaches the handle to the QR"),
      handle_position: z
        .enum(WATERMARK_HANDLE_PLACEMENTS)
        .optional()
        .describe("Burn-mode handle placement: center (default), above-qr, on-qr, or below-qr"),
      include_x_icon: z
        .boolean()
        .optional()
        .describe("Show the X icon before the plain handle (default true)"),
      include_handle_border: z
        .boolean()
        .optional()
        .describe("Draw a border around the handle pill (default true)"),
      handle_padding: z
        .number()
        .int()
        .min(MIN_HANDLE_PADDING)
        .max(MAX_HANDLE_PADDING)
        .optional()
        .describe(`Horizontal handle padding in reference pixels (default ${DEFAULT_HANDLE_PADDING}; range ${MIN_HANDLE_PADDING}-${MAX_HANDLE_PADDING})`),
      handle_padding_y: z
        .number()
        .int()
        .min(MIN_HANDLE_PADDING)
        .max(MAX_HANDLE_PADDING)
        .optional()
        .describe(`Vertical handle padding in reference pixels (default ${DEFAULT_HANDLE_PADDING}; range ${MIN_HANDLE_PADDING}-${MAX_HANDLE_PADDING})`),
      handle_rounding: z
        .number()
        .int()
        .min(MIN_HANDLE_ROUNDING)
        .max(MAX_HANDLE_ROUNDING)
        .optional()
        .describe(`Handle corner rounding percent (default ${DEFAULT_HANDLE_ROUNDING}; range ${MIN_HANDLE_ROUNDING}-${MAX_HANDLE_ROUNDING})`),
      start_seconds: z
        .number()
        .min(0)
        .optional()
        .describe("Legacy shared first visible second, used when a watermark-specific start is omitted"),
      end_seconds: z
        .number()
        .min(0)
        .optional()
        .describe("Legacy shared last visible second, used when a watermark-specific end is omitted"),
      qr_start_seconds: z
        .number()
        .min(0)
        .optional()
        .describe("First second where the QR is visible (default clip start)"),
      qr_end_seconds: z
        .number()
        .min(0)
        .optional()
        .describe("Last second where the QR is visible (default clip end)"),
      handle_start_seconds: z
        .number()
        .min(0)
        .optional()
        .describe("First second where the handle is visible (default clip start)"),
      handle_end_seconds: z
        .number()
        .min(0)
        .optional()
        .describe("Last second where the handle is visible (default clip end)"),
      fade_seconds: z
        .number()
        .min(0)
        .max(MAX_WATERMARK_FADE_SECONDS)
        .optional()
        .describe(`Burn-mode fade in/out length in seconds at a watermark edge that falls inside the clip (default ${DEFAULT_WATERMARK_FADE_SECONDS}; 0 keeps hard edges). Whole-clip watermarks never fade`),
      opacity: z
        .number()
        .min(0.05)
        .max(1)
        .optional()
        .describe("Legacy shared opacity, used when a watermark-specific opacity is omitted"),
      qr_opacity: z
        .number()
        .min(0.05)
        .max(1)
        .optional()
        .describe("QR opacity from 0.05 to 1 (default 0.5)"),
      handle_opacity: z
        .number()
        .min(0.05)
        .max(1)
        .optional()
        .describe("Handle opacity from 0.05 to 1 (default 0.5)"),
      scale: z
        .number()
        .min(0.5)
        .max(2)
        .optional()
        .describe("Size multiplier on the default badge size (default 1)"),
      card_asset_id: z
        .string()
        .optional()
        .describe("Reuse an existing image asset for the primary QR or handle watermark"),
      mode: z
        .enum(["burn", "overlay"])
        .optional()
        .describe("burn (default): composite into the video file and reprocess; overlay: store render-time OSG settings only"),
      wait: z
        .boolean()
        .optional()
        .describe("Burn mode: wait for the burn and reprocess to finish (default true). false returns status=accepted with the queue job_id as soon as the burn is queued"),
    },
    handler: async (args) => {
      const {
        book_id,
        asset_id,
        handle,
        url,
        save_default,
        include_qr = true,
        include_handle = true,
        position = "auto",
        handle_vertical_percent = DEFAULT_HANDLE_VERTICAL_PERCENT,
        handle_position = "center",
        include_x_icon = true,
        include_handle_border = true,
        handle_padding = DEFAULT_HANDLE_PADDING,
        handle_padding_y = DEFAULT_HANDLE_PADDING,
        handle_rounding = DEFAULT_HANDLE_ROUNDING,
        start_seconds,
        end_seconds,
        qr_start_seconds,
        qr_end_seconds,
        handle_start_seconds,
        handle_end_seconds,
        fade_seconds = DEFAULT_WATERMARK_FADE_SECONDS,
        opacity = WATERMARK_OPACITY,
        qr_opacity,
        handle_opacity,
        scale = 1,
        card_asset_id,
        mode = "burn",
        wait = true,
      } = args as {
        book_id: string;
        asset_id: string;
        handle?: string;
        url?: string;
        save_default?: boolean;
        include_qr?: boolean;
        include_handle?: boolean;
        position?: WatermarkPositionOption;
        handle_vertical_percent?: number;
        handle_position?: WatermarkHandlePlacement;
        include_x_icon?: boolean;
        include_handle_border?: boolean;
        handle_padding?: number;
        handle_padding_y?: number;
        handle_rounding?: number;
        start_seconds?: number;
        end_seconds?: number;
        opacity?: number;
        qr_start_seconds?: number;
        qr_end_seconds?: number;
        handle_start_seconds?: number;
        handle_end_seconds?: number;
        fade_seconds?: number;
        qr_opacity?: number;
        handle_opacity?: number;
        scale?: number;
        card_asset_id?: string;
        mode?: "burn" | "overlay";
        wait?: boolean;
      };

      const resolvedQrStartSeconds = qr_start_seconds ?? start_seconds;
      const resolvedQrEndSeconds = qr_end_seconds ?? end_seconds;
      const resolvedHandleStartSeconds = handle_start_seconds ?? start_seconds;
      const resolvedHandleEndSeconds = handle_end_seconds ?? end_seconds;
      const resolvedQrOpacity = qr_opacity ?? opacity;
      const resolvedHandleOpacity = handle_opacity ?? opacity;
      if (!include_qr && !include_handle) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "include_qr or include_handle must be true" }],
        };
      }
      const timingError = (include_handle
        ? watermarkTimingError(
            "handle",
            resolvedHandleStartSeconds,
            resolvedHandleEndSeconds,
          )
        : null) ?? (include_qr
        ? watermarkTimingError("qr", resolvedQrStartSeconds, resolvedQrEndSeconds)
        : null);
      if (timingError) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: timingError }],
        };
      }

      const kindGate = await requireArtifactKind(engine, asset_id, ["video"], "apply_watermark");
      if (kindGate) return kindGate;

      const config = await readWatermarkConfig(engine);
      const fallbackHandle = config.savedHandle ?? config.authenticatedHandle ?? DEFAULT_HANDLE;
      const resolvedHandle = (handle ?? (include_handle || url === undefined ? fallbackHandle : ""))
        .replace(/^@/, "")
        .trim();
      if (include_handle && !resolvedHandle) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "handle must be a non-empty string" }],
        };
      }
      const resolvedUrl = (url ?? (resolvedHandle ? defaultUrl(resolvedHandle) : "")).trim();
      if (include_qr && !resolvedUrl) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "url or handle must provide a QR destination" }],
        };
      }
      const resolvedHandlePosition: WatermarkHandlePlacement = include_qr
        ? handle_position
        : "center";
      const appearance: WatermarkAssetAppearance = {
        includeXIcon: include_x_icon,
        includeHandleBorder: include_handle_border,
        handlePadding: handle_padding,
        handlePaddingY: handle_padding_y,
        handleRounding: handle_rounding,
      };

      let cardAssetId: string;
      let qrAssetId: string | null = null;
      let handleAssetId: string | null = null;
      const variant = watermarkVariantForApply(mode, include_qr, include_handle);
      if (card_asset_id) {
        const cardGate = await requireArtifactKind(engine, card_asset_id, ["image"], "card_asset_id");
        if (cardGate) return cardGate;
        cardAssetId = card_asset_id;
        if (mode === "burn" && include_qr) qrAssetId = card_asset_id;
        if (mode === "burn" && include_handle && !include_qr) handleAssetId = card_asset_id;
      } else {
        const resolved = await resolveWatermarkAsset(
          engine,
          resolvedHandle,
          resolvedUrl,
          variant,
          appearance,
        );
        if (!resolved.ok) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: resolved.error }],
          };
        }
        cardAssetId = resolved.assetId;
        if (mode === "burn" && include_qr) qrAssetId = resolved.assetId;
        if (mode === "burn" && include_handle && !include_qr) handleAssetId = resolved.assetId;
      }

      if (mode === "burn" && include_handle && handleAssetId === null) {
        const resolved = await resolveWatermarkAsset(
          engine,
          resolvedHandle,
          resolvedUrl,
          "handle",
          appearance,
        );
        if (!resolved.ok) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: resolved.error }],
          };
        }
        handleAssetId = resolved.assetId;
      }

      const manifestResult = await engine.files.manifest(asset_id);
      if (!manifestResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: manifestResult.error.message }],
        };
      }
      const videoFile = findVideoFile(manifestResult.value.files);
      if (!videoFile) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `No video file found in asset ${asset_id}` }],
        };
      }
      const assetDir = manifestResult.value.path;
      const videoPath = join(assetDir, videoFile.name);

      const badgeAspect = variant === "qr"
        ? QR_ONLY_BADGE_ASPECT
        : watermarkBadgeAspect(include_qr, handle_padding_y);
      const scaling: PlacementScaling = { aspect: badgeAspect, userScale: scale };

      const summary = {
        asset_id,
        card_asset_id: cardAssetId,
        handle: resolvedHandle || null,
        url: resolvedUrl,
        include_qr,
        include_handle,
        opacity,
        qr_opacity: resolvedQrOpacity,
        handle_opacity: resolvedHandleOpacity,
        scale,
        requested_position: position,
        handle_vertical_percent,
        handle_position: include_handle ? resolvedHandlePosition : null,
        include_x_icon,
        include_handle_border,
        handle_padding,
        handle_padding_y,
        handle_rounding,
        fade_seconds,
        start_seconds: start_seconds ?? null,
        end_seconds: end_seconds ?? null,
        qr_start_seconds: include_qr ? resolvedQrStartSeconds ?? null : null,
        qr_end_seconds: include_qr ? resolvedQrEndSeconds ?? null : null,
        handle_start_seconds: include_handle ? resolvedHandleStartSeconds ?? null : null,
        handle_end_seconds: include_handle ? resolvedHandleEndSeconds ?? null : null,
      };

      if (mode === "overlay") {
        const placement = await resolveOverlayPlacement(
          engine, book_id, asset_id, assetDir, videoFile, position, scaling,
        );
        const written = await writeOsgSettings(engine, asset_id, (orientation) => ({
          osgImagePath: null,
          osgAssetId: cardAssetId,
          osgPosition: placement.positions[orientation],
          osgSize: WATERMARK_OSG_SIZE,
          osgScale: watermarkOsgScale(orientation, scale),
          osgOpacity: opacity,
          osgStartSeconds: start_seconds ?? null,
          osgEndSeconds: end_seconds ?? null,
          osgTailSeconds: null,
        }));
        if (!written.ok) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: written.error }],
          };
        }
        await recordHandle(resolvedHandle, { saveDefault: save_default }, engine).catch(() => undefined);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              ...summary,
              ...(placement.jobId !== undefined ? { job_id: placement.jobId } : {}),
              mode: "overlay",
              positions: placement.positions,
              placement_source: placement.placementSource,
            }),
          }],
        };
      }

      // Burn mode: composite the badge into the source video so the change is
      // visible in the notebook cell (renders and proxies both inherit it).
      const badge = await resolveOsgImagePath(engine, cardAssetId);
      if (!badge.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: badge.error }],
        };
      }
      let handlePath: string | undefined;
      if (include_handle) {
        if (handleAssetId === null) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: "Handle watermark asset is unavailable" }],
          };
        }
        const handleBadge = handleAssetId === cardAssetId
          ? badge
          : await resolveOsgImagePath(engine, handleAssetId);
        if (!handleBadge.ok) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: handleBadge.error }],
          };
        }
        handlePath = handleBadge.path;
      }

      // A handle-only burn has nothing to place; the corner is inert.
      const placement: BurnPlacement = include_qr
        ? await resolveBurnPlacement(engine, asset_id, videoFile, videoPath, position, scaling)
        : { corner: DEFAULT_POSITION, placementSource: "fixed", visionRequest: null };

      const burnJobId = `burn-watermark-${asset_id}-${Date.now()}`;
      const payload: BurnWatermarkPayload = {
        type: "burn_watermark",
        assetId: asset_id,
        assetDir,
        bookId: book_id,
        videoPath,
        ...(include_qr ? { qrPath: badge.path } : {}),
        ...(handlePath !== undefined ? { handlePath } : {}),
        corner: placement.corner,
        placementSource: placement.placementSource,
        ...(placement.visionRequest ? { placement: placement.visionRequest } : {}),
        opacity,
        qrOpacity: resolvedQrOpacity,
        handleOpacity: resolvedHandleOpacity,
        userScale: scale,
        fadeSeconds: fade_seconds,
        ...(include_handle ? { handleVerticalPercent: handle_vertical_percent } : {}),
        ...(include_handle ? { handlePlacement: resolvedHandlePosition } : {}),
        ...(include_handle ? { handlePaddingY: handle_padding_y } : {}),
        ...(resolvedQrStartSeconds !== undefined
          ? { qrStartSeconds: resolvedQrStartSeconds }
          : {}),
        ...(resolvedQrEndSeconds !== undefined
          ? { qrEndSeconds: resolvedQrEndSeconds }
          : {}),
        ...(include_handle && resolvedHandleStartSeconds !== undefined
          ? { handleStartSeconds: resolvedHandleStartSeconds }
          : {}),
        ...(include_handle && resolvedHandleEndSeconds !== undefined
          ? { handleEndSeconds: resolvedHandleEndSeconds }
          : {}),
      };
      const burnSummary = {
        ...summary,
        mode: "burn",
        operation_id: burnJobId,
        qr_asset_id: qrAssetId,
        handle_asset_id: handleAssetId,
        handle_position: include_handle ? resolvedHandlePosition : null,
      };

      await engine.jobs.failures.clear(asset_id);
      await recordHandle(resolvedHandle, { saveDefault: save_default }, engine).catch(() => undefined);

      if (!wait) {
        // Return as soon as the burn is queued; the frame-aware corner is
        // settled inside the job, so it stays pending here.
        const job = await queue.enqueue(burnJobId, payload);
        const pending = placement.visionRequest !== null;
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              ...burnSummary,
              status: "accepted",
              job_id: job.id,
              position: include_qr && !pending ? placement.corner : null,
              placement_source: pending ? "pending" : placement.placementSource,
            }),
          }],
        };
      }

      let burned: BurnWatermarkResult;
      try {
        burned = await queue.enqueueAndWait<BurnWatermarkResult>(burnJobId, payload, BURN_TIMEOUT_MS);
        const readiness = await waitForAssetReadyDef(engine).handler({
          asset_id,
          book_id,
          timeout_seconds: 300,
        });
        if (readiness.isError) {
          const text = readiness.content.find((entry) => entry.type === "text")?.text;
          throw new Error(text ?? "Post-watermark processing failed");
        }
      } catch (err) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Watermark failed: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            ...burnSummary,
            status: "completed",
            position: include_qr ? burned.corner : null,
            placement_source: burned.placementSource,
          }),
        }],
      };
    },
  };
}
