import type { Engine } from "videobook-engine";
import { findVideoFile } from "videobook-engine";
import { join } from "node:path";
import { z } from "zod";
import { getApiKey } from "../api-key.js";
import { probeVideo } from "../ffmpeg.js";
import { sampleEvenly } from "../frame-utils.js";
import type { OsgPlacementResult } from "../jobs/osg-placement.js";
import { resolveOsgImagePath } from "../osg-assets.js";
import {
  osgPlacementFingerprint,
  readOsgPlacementAnalysis,
} from "../osg-placement-cache.js";
import type { OsgPlacementAnalysis } from "../osg-placement-cache.js";
import { writeOsgSettings } from "../osg-settings.js";
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
} from "../watermark-handle-position.js";
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

type WatermarkPlacementSource = "cached" | "vision" | "analysis" | "default" | "explicit" | "fixed";
type WatermarkPositionOption = "auto" | OsgPosition;
type WatermarkAssetAppearance = {
  includeXIcon: boolean;
  includeHandleBorder: boolean;
  handlePadding: number;
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

export function applyWatermarkDef(engine: Engine): ToolDef {
  return {
    name: "apply_watermark",
    description:
      "Previewed watermark apply for video: burns a positioned QR plus a separate horizontally centered plain X handle. Burn mode supports optional X icon and handle border, adjustable handle padding and corner rounding, independent QR/handle opacity, independent visibility windows, and adjustable handle height. The QR can be disabled. Pass mode=overlay to store the legacy single-card render-time overlay instead.",
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
      position: z
        .enum(WATERMARK_POSITION_OPTIONS)
        .optional()
        .describe("QR placement anchor, or auto (default) to choose the least-busy corner"),
      handle_vertical_percent: z
        .number()
        .min(MIN_HANDLE_VERTICAL_PERCENT)
        .max(MAX_HANDLE_VERTICAL_PERCENT)
        .optional()
        .describe("Burn-mode handle centerline as percent from the top (default 33; range 10-90)"),
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
        .describe("Reuse an existing QR image asset, or a handle image when include_qr is false"),
      mode: z
        .enum(["burn", "overlay"])
        .optional()
        .describe("burn (default): composite into the video file and reprocess; overlay: store render-time OSG settings only"),
    },
    handler: async (args) => {
      const {
        book_id,
        asset_id,
        handle,
        url,
        save_default,
        include_qr = true,
        position = "auto",
        handle_vertical_percent = DEFAULT_HANDLE_VERTICAL_PERCENT,
        include_x_icon = true,
        include_handle_border = true,
        handle_padding = DEFAULT_HANDLE_PADDING,
        handle_rounding = DEFAULT_HANDLE_ROUNDING,
        start_seconds,
        end_seconds,
        qr_start_seconds,
        qr_end_seconds,
        handle_start_seconds,
        handle_end_seconds,
        opacity = WATERMARK_OPACITY,
        qr_opacity,
        handle_opacity,
        scale = 1,
        card_asset_id,
        mode = "burn",
      } = args as {
        book_id: string;
        asset_id: string;
        handle?: string;
        url?: string;
        save_default?: boolean;
        include_qr?: boolean;
        position?: WatermarkPositionOption;
        handle_vertical_percent?: number;
        include_x_icon?: boolean;
        include_handle_border?: boolean;
        handle_padding?: number;
        handle_rounding?: number;
        start_seconds?: number;
        end_seconds?: number;
        opacity?: number;
        qr_start_seconds?: number;
        qr_end_seconds?: number;
        handle_start_seconds?: number;
        handle_end_seconds?: number;
        qr_opacity?: number;
        handle_opacity?: number;
        scale?: number;
        card_asset_id?: string;
        mode?: "burn" | "overlay";
      };

      const resolvedQrStartSeconds = qr_start_seconds ?? start_seconds;
      const resolvedQrEndSeconds = qr_end_seconds ?? end_seconds;
      const resolvedHandleStartSeconds = handle_start_seconds ?? start_seconds;
      const resolvedHandleEndSeconds = handle_end_seconds ?? end_seconds;
      const resolvedQrOpacity = qr_opacity ?? opacity;
      const resolvedHandleOpacity = handle_opacity ?? opacity;
      const timingError = watermarkTimingError(
        "handle",
        resolvedHandleStartSeconds,
        resolvedHandleEndSeconds,
      ) ?? (include_qr
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
      const resolvedHandle = (handle ?? config.savedHandle ?? config.authenticatedHandle ?? DEFAULT_HANDLE)
        .replace(/^@/, "")
        .trim();
      if (!resolvedHandle) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "handle must be a non-empty string" }],
        };
      }
      const resolvedUrl = url ?? defaultUrl(resolvedHandle);
      const appearance: WatermarkAssetAppearance = {
        includeXIcon: include_x_icon,
        includeHandleBorder: include_handle_border,
        handlePadding: handle_padding,
        handleRounding: handle_rounding,
      };

      let cardAssetId: string;
      let qrAssetId: string | null = null;
      let handleAssetId: string | null = null;
      if (card_asset_id) {
        const cardGate = await requireArtifactKind(engine, card_asset_id, ["image"], "card_asset_id");
        if (cardGate) return cardGate;
        cardAssetId = card_asset_id;
        if (mode === "burn" && include_qr) qrAssetId = card_asset_id;
        if (mode === "burn" && !include_qr) handleAssetId = card_asset_id;
      } else {
        const variant = mode === "burn"
          ? include_qr ? "qr" : "handle"
          : include_qr ? "combined" : "handle";
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
        if (mode === "burn" && !include_qr) handleAssetId = resolved.assetId;
      }

      if (mode === "burn" && handleAssetId === null) {
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

      // Frame-aware corner pick. Never fail the tool on placement problems —
      // degrade: vision job → analyze-video recommendation → bottom-right.
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

      const usesPosition = mode === "overlay" || include_qr;
      const badgeAspect = mode === "burn" && include_qr
        ? QR_ONLY_BADGE_ASPECT
        : watermarkBadgeAspect(include_qr);
      let analysis: OsgPlacementAnalysis | null = null;
      let recommended: OsgPosition | null = null;
      let placementSource: WatermarkPlacementSource = usesPosition
        ? position === "auto" ? "default" : "explicit"
        : "fixed";
      let jobId: string | undefined;

      if (usesPosition && position === "auto") {
        const framesResult = await engine.files.listSubdir(asset_id, "original_frames");
        const frameNames = framesResult.ok
          ? sampleEvenly(
              framesResult.value.filter((f) => f.endsWith(".jpg")).sort((a, b) => parseFloat(a) - parseFloat(b)),
              MAX_PLACEMENT_FRAMES,
            )
          : [];
        const fingerprint = osgPlacementFingerprint(videoFile, frameNames, {
          aspect: badgeAspect,
          minDimFraction: WATERMARK_MIN_DIM_FRACTION,
          userScale: scale,
        });
        const cached = await readOsgPlacementAnalysis(engine, asset_id);
        if (cached && cached.fingerprint === fingerprint) {
          analysis = cached;
          placementSource = "cached";
        } else if (getApiKey("OPENAI_API_KEY") && frameNames.length > 0) {
          try {
            await engine.jobs.failures.clear(asset_id);
            jobId = `osg-placement-${asset_id}-${Date.now()}`;
            const result = await queue.enqueueAndWait<OsgPlacementResult>(jobId, {
              type: "osg_placement",
              assetId: asset_id,
              assetDir: manifestResult.value.path,
              bookId: book_id,
              fingerprint,
              userScale: scale,
              badgeAspect,
            }, PLACEMENT_TIMEOUT_MS);
            analysis = result.analysis;
            placementSource = "vision";
          } catch (err) {
            logger.warn(`[apply_watermark] placement job failed for ${asset_id}, falling back:`, err instanceof Error ? err.message : err);
          }
        }
        recommended = analysis ? null : await readRecommendedOsgPosition(engine, asset_id);
        if (!analysis && recommended) placementSource = "analysis";
      }

      const summary = {
        asset_id,
        card_asset_id: cardAssetId,
        handle: resolvedHandle,
        url: resolvedUrl,
        include_qr,
        opacity,
        qr_opacity: resolvedQrOpacity,
        handle_opacity: resolvedHandleOpacity,
        scale,
        requested_position: position,
        handle_vertical_percent,
        include_x_icon,
        include_handle_border,
        handle_padding,
        handle_rounding,
        start_seconds: start_seconds ?? null,
        end_seconds: end_seconds ?? null,
        qr_start_seconds: resolvedQrStartSeconds ?? null,
        qr_end_seconds: resolvedQrEndSeconds ?? null,
        handle_start_seconds: resolvedHandleStartSeconds ?? null,
        handle_end_seconds: resolvedHandleEndSeconds ?? null,
        ...(jobId !== undefined && placementSource === "vision" ? { job_id: jobId } : {}),
      };

      if (mode === "overlay") {
        const positions: Record<Orientation, OsgPosition> = position !== "auto"
          ? uniformPositions(position)
          : analysis
            ? analysis.positions
            : uniformPositions(recommended ?? DEFAULT_POSITION);
        const written = await writeOsgSettings(engine, asset_id, (orientation) => ({
          osgImagePath: null,
          osgAssetId: cardAssetId,
          osgPosition: positions[orientation],
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
              mode: "overlay",
              positions,
              placement_source: placementSource,
            }),
          }],
        };
      }

      // Burn mode: composite the badge into the source video so the change is
      // visible in the notebook cell (renders and proxies both inherit it).
      const badge = await resolveOsgImagePath(engine, cardAssetId);
      if (!badge.ok || handleAssetId === null) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: badge.ok ? "Handle watermark asset is unavailable" : badge.error,
          }],
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

      const assetDir = manifestResult.value.path;
      const videoPath = join(assetDir, videoFile.name);
      let corner: OsgPosition = position === "auto"
        ? recommended ?? DEFAULT_POSITION
        : position;
      if (position === "auto" && analysis) {
        // Score corners against the source frame itself — a burned watermark
        // lives in source pixels, so one corner serves every orientation.
        try {
          const probe = await probeVideo(videoPath);
          corner = scoreWatermarkCornersForCanvas(probe.width, probe.height, analysis.regions, {
            aspect: badgeAspect,
            userScale: scale,
          }).position;
        } catch (err) {
          logger.warn(`[apply_watermark] probe failed for ${asset_id}, using ${corner}:`, err instanceof Error ? err.message : err);
        }
      }

      try {
        await engine.jobs.failures.clear(asset_id);
        const burnJobId = `burn-watermark-${asset_id}-${Date.now()}`;
        await queue.enqueueAndWait(burnJobId, {
          type: "burn_watermark",
          assetId: asset_id,
          assetDir,
          bookId: book_id,
          videoPath,
          ...(include_qr ? { qrPath: badge.path } : {}),
          handlePath: handleBadge.path,
          corner,
          opacity,
          qrOpacity: resolvedQrOpacity,
          handleOpacity: resolvedHandleOpacity,
          userScale: scale,
          handleVerticalPercent: handle_vertical_percent,
          ...(resolvedQrStartSeconds !== undefined
            ? { qrStartSeconds: resolvedQrStartSeconds }
            : {}),
          ...(resolvedQrEndSeconds !== undefined
            ? { qrEndSeconds: resolvedQrEndSeconds }
            : {}),
          ...(resolvedHandleStartSeconds !== undefined
            ? { handleStartSeconds: resolvedHandleStartSeconds }
            : {}),
          ...(resolvedHandleEndSeconds !== undefined
            ? { handleEndSeconds: resolvedHandleEndSeconds }
            : {}),
        }, BURN_TIMEOUT_MS);
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

      // The badge now lives in the pixels; clear any stored render-time overlay
      // so a later render can't stamp it twice.
      await writeOsgSettings(engine, asset_id, () => ({
        osgImagePath: null,
        osgAssetId: null,
        osgOpacity: 1,
        osgStartSeconds: null,
        osgEndSeconds: null,
        osgTailSeconds: null,
      })).catch(() => undefined);

      await recordHandle(resolvedHandle, { saveDefault: save_default }, engine).catch(() => undefined);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            ...summary,
            mode: "burn",
            position: include_qr ? corner : null,
            qr_asset_id: qrAssetId,
            handle_asset_id: handleAssetId,
            handle_position: "center",
            placement_source: placementSource,
          }),
        }],
      };
    },
  };
}
