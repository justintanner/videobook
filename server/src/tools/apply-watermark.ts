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
  BADGE_ASPECT,
  createWatermarkAsset,
  DEFAULT_HANDLE,
  defaultUrl,
  findWatermarkAsset,
} from "../watermark-badge.js";
import { readWatermarkConfig, recordHandle } from "../watermark-config.js";
import type { ToolDef } from "./tool-def.js";
import { requireArtifactKind } from "./_shared.js";
import { waitForAssetReadyDef } from "./wait-for-asset-ready.js";

const PLACEMENT_TIMEOUT_MS = 300_000;
const BURN_TIMEOUT_MS = 600_000;
const MAX_PLACEMENT_FRAMES = 8;

const ANALYSIS_OSG_POSITIONS = new Set(["top-left", "top-right", "bottom-left", "bottom-right"]);
const DEFAULT_POSITION: OsgPosition = "bottom-right";

type WatermarkPlacementSource = "cached" | "vision" | "analysis" | "default";

function uniformPositions(position: OsgPosition): Record<Orientation, OsgPosition> {
  return { landscape: position, portrait: position, square: position };
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
      "Apply a faint floating QR + @handle watermark to a video: builds (or reuses) the badge image, picks the least-busy corner via frame analysis, and burns the badge into the video at 50% opacity so the clip visibly updates. Pass mode=overlay to only store render-time overlay settings instead.",
    schema: {
      book_id: z.string().describe("Book id"),
      asset_id: z.string().describe("Video asset id to watermark"),
      handle: z.string().optional().describe("X handle without @ (default: saved handle)"),
      url: z.string().optional().describe("URL the QR code resolves to (default: https://x.com/<handle>)"),
      save_default: z
        .boolean()
        .optional()
        .describe("Remember this handle as the default for future watermarks"),
      opacity: z
        .number()
        .min(0.05)
        .max(1)
        .optional()
        .describe("Watermark opacity (default 0.5)"),
      scale: z
        .number()
        .min(0.5)
        .max(2)
        .optional()
        .describe("Size multiplier on the default badge size (default 1)"),
      card_asset_id: z
        .string()
        .optional()
        .describe("Reuse an existing watermark image asset instead of generating one"),
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
        opacity = WATERMARK_OPACITY,
        scale = 1,
        card_asset_id,
        mode = "burn",
      } = args as {
        book_id: string;
        asset_id: string;
        handle?: string;
        url?: string;
        save_default?: boolean;
        opacity?: number;
        scale?: number;
        card_asset_id?: string;
        mode?: "burn" | "overlay";
      };

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

      // Badge: explicit card wins, then an existing matching badge, then a fresh one.
      let cardAssetId: string;
      if (card_asset_id) {
        const cardGate = await requireArtifactKind(engine, card_asset_id, ["image"], "card_asset_id");
        if (cardGate) return cardGate;
        cardAssetId = card_asset_id;
      } else {
        const existing = await findWatermarkAsset(engine, resolvedHandle, resolvedUrl);
        if (existing) {
          cardAssetId = existing;
        } else {
          const created = await createWatermarkAsset(engine, resolvedHandle, resolvedUrl);
          if (!created.ok) {
            return {
              isError: true as const,
              content: [{ type: "text" as const, text: created.error }],
            };
          }
          cardAssetId = created.assetId;
        }
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

      const framesResult = await engine.files.listSubdir(asset_id, "original_frames");
      const frameNames = framesResult.ok
        ? sampleEvenly(
            framesResult.value.filter((f) => f.endsWith(".jpg")).sort((a, b) => parseFloat(a) - parseFloat(b)),
            MAX_PLACEMENT_FRAMES,
          )
        : [];
      const fingerprint = osgPlacementFingerprint(videoFile, frameNames, {
        aspect: BADGE_ASPECT,
        minDimFraction: WATERMARK_MIN_DIM_FRACTION,
        userScale: scale,
      });

      let analysis: OsgPlacementAnalysis | null = null;
      let placementSource: WatermarkPlacementSource = "default";
      let jobId: string | undefined;

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
          }, PLACEMENT_TIMEOUT_MS);
          analysis = result.analysis;
          placementSource = "vision";
        } catch (err) {
          logger.warn(`[apply_watermark] placement job failed for ${asset_id}, falling back:`, err instanceof Error ? err.message : err);
        }
      }
      const recommended = analysis ? null : await readRecommendedOsgPosition(engine, asset_id);
      if (!analysis && recommended) placementSource = "analysis";

      const summary = {
        asset_id,
        card_asset_id: cardAssetId,
        handle: resolvedHandle,
        url: resolvedUrl,
        opacity,
        scale,
        ...(jobId !== undefined && placementSource === "vision" ? { job_id: jobId } : {}),
      };

      if (mode === "overlay") {
        const positions: Record<Orientation, OsgPosition> = analysis
          ? analysis.positions
          : uniformPositions(recommended ?? DEFAULT_POSITION);
        const written = await writeOsgSettings(engine, asset_id, (orientation) => ({
          osgImagePath: null,
          osgAssetId: cardAssetId,
          osgPosition: positions[orientation],
          osgSize: WATERMARK_OSG_SIZE,
          osgScale: watermarkOsgScale(orientation, scale),
          osgOpacity: opacity,
          osgStartSeconds: null,
          osgEndSeconds: null,
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
      if (!badge.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: badge.error }],
        };
      }

      const assetDir = manifestResult.value.path;
      const videoPath = join(assetDir, videoFile.name);
      let corner: OsgPosition = recommended ?? DEFAULT_POSITION;
      if (analysis) {
        // Score corners against the source frame itself — a burned watermark
        // lives in source pixels, so one corner serves every orientation.
        try {
          const probe = await probeVideo(videoPath);
          corner = scoreWatermarkCornersForCanvas(probe.width, probe.height, analysis.regions, {
            aspect: BADGE_ASPECT,
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
          badgePath: badge.path,
          corner,
          opacity,
          userScale: scale,
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
            position: corner,
            placement_source: placementSource,
          }),
        }],
      };
    },
  };
}
