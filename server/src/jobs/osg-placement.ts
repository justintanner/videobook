import type { Engine } from "videobook-engine";
import sharp from "sharp";
import { getApiKey } from "../api-key.js";
import { sampleEvenly } from "../frame-utils.js";
import {
  OSG_PLACEMENT_VERSION,
  writeOsgPlacementAnalysis,
} from "../osg-placement-cache.js";
import type { OsgPlacementAnalysis } from "../osg-placement-cache.js";
import { registerJobHandler } from "../queue.js";
import {
  mapSourceRectToTarget,
  orientationDimensions,
  subtitleBand,
} from "../remotion/keyword-placement.js";
import type { KeywordOccupiedRegion } from "../remotion/keyword-placement.js";
import { scoreWatermarkCorners } from "../remotion/osg-spec.js";
import type {
  FontSizePreset,
  Orientation,
  OsgPosition,
  SubtitlePosition,
  SubtitleStyle,
} from "../remotion/subtitles/types.js";
import { RENDER_ORIENTATIONS, readStoredRenderDefaults } from "../tools/reconcile-project-work.js";
import { detectOccupiedRegions } from "../vision-regions.js";
import { BADGE_ASPECT } from "../watermark-badge.js";
import { withLockedLocalLease } from "./_lease.js";

const LOCK_DURATION_MS = 300_000;
const MAX_FRAMES = 8;

type OsgPlacementPayload = {
  type: "osg_placement";
  assetId: string;
  assetDir: string;
  bookId: string;
  fingerprint: string;
  userScale: number;
};

export interface OsgPlacementResult {
  analysis: OsgPlacementAnalysis;
}

const SYSTEM_PROMPT = `You are a precise video-layout analyst. Each attached image is a frame sampled evenly across a video clip that will carry a small persistent corner watermark.

For every frame, identify all occupied regions the watermark must not cover:
- every visible human face, including partial faces and faces in posters or screens
- every existing visible text block, subtitle, caption, title, logo, watermark, or graphic

Return one entry for every cue_id. Coordinates use a normalized image scale from 0 to 1000: x and y are the top-left corner, followed by width and height. Use tight boxes around the visible occupied content. Do not return boxes for bodies, clothing, scenery, microphones, or ordinary objects. Return an empty occupied_regions array only when none of the listed content is visible. Never omit, rename, or duplicate a cue_id.`;

function isSubtitlePosition(value: unknown): value is SubtitlePosition {
  return value === "top" || value === "middle" || value === "bottom";
}

function isSubtitleStyle(value: unknown): value is SubtitleStyle {
  return value === "impact" || value === "highlight";
}

function isFontSizePreset(value: unknown): value is FontSizePreset {
  return value === "small" || value === "medium" || value === "large";
}

async function readSourceDimensions(
  engine: Engine,
  assetId: string,
  firstFrame: Buffer,
): Promise<{ width: number; height: number }> {
  const meta = await engine.metadata.artifacts.read<{ width?: unknown; height?: unknown }>(assetId, "original");
  if (meta.ok
    && typeof meta.value.width === "number" && meta.value.width > 0
    && typeof meta.value.height === "number" && meta.value.height > 0) {
    return { width: meta.value.width, height: meta.value.height };
  }
  // Only the aspect matters for mapping onto the render canvas, so the sampled
  // frame's dimensions are an equivalent fallback.
  const probed = await sharp(firstFrame).metadata();
  if (!probed.width || !probed.height) {
    throw new Error(`Could not determine source dimensions for ${assetId}`);
  }
  return { width: probed.width, height: probed.height };
}

async function chooseWatermarkPositions(
  engine: Engine,
  assetId: string,
  regions: KeywordOccupiedRegion[],
  sourceWidth: number,
  sourceHeight: number,
  userScale: number,
): Promise<Record<Orientation, OsgPosition>> {
  const positions: Partial<Record<Orientation, OsgPosition>> = {};
  for (const orientation of RENDER_ORIENTATIONS) {
    const { width, height } = orientationDimensions(orientation);
    const occupied = regions.map((region): KeywordOccupiedRegion => ({
      ...mapSourceRectToTarget(region, sourceWidth, sourceHeight, width, height),
      kind: region.kind,
      confidence: region.confidence,
    }));
    const stored = await readStoredRenderDefaults(engine, assetId, orientation);
    const band = stored.subtitlesEnabled === true
      ? subtitleBand(
          orientation,
          height,
          isSubtitlePosition(stored.position) ? stored.position : "bottom",
          isSubtitleStyle(stored.highlightStyle) ? stored.highlightStyle : "impact",
          isFontSizePreset(stored.fontSize) ? stored.fontSize : "medium",
        )
      : null;
    positions[orientation] = scoreWatermarkCorners(orientation, occupied, {
      aspect: BADGE_ASPECT,
      userScale,
      subtitleBand: band,
    }).position;
  }
  return positions as Record<Orientation, OsgPosition>;
}

export function registerOsgPlacementJob(engine: Engine): void {
  registerJobHandler("osg_placement", async (payload, ctx) => {
    const { assetId, assetDir, fingerprint, userScale } = payload as OsgPlacementPayload;
    return withLockedLocalLease(
      engine,
      assetId,
      assetDir,
      ctx,
      "analyze",
      { durationMs: LOCK_DURATION_MS, data: { state: "analyzing-osg-placement" } },
      async () => {
        const apiKey = getApiKey("OPENAI_API_KEY");
        if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

        const listResult = await engine.files.listSubdir(assetId, "original_frames");
        const frameFiles = listResult.ok
          ? listResult.value
              .filter((f) => f.endsWith(".jpg"))
              .sort((a, b) => parseFloat(a) - parseFloat(b))
          : [];
        if (frameFiles.length === 0) {
          throw new Error(`no_frames: asset ${assetId} has no original_frames to analyze`);
        }
        const sampled = sampleEvenly(frameFiles, MAX_FRAMES);

        const frames: Array<{ id: string; label: string; buffer: Buffer }> = [];
        for (const file of sampled) {
          ctx.signal.throwIfAborted();
          const read = await engine.files.read(assetId, `original_frames/${file}`);
          if (!read.ok) throw new Error(read.error.message);
          frames.push({
            id: file,
            label: `timestamp=${parseFloat(file).toFixed(3)}s`,
            buffer: Buffer.from(read.value),
          });
        }

        const source = await readSourceDimensions(engine, assetId, frames[0].buffer);
        const regionsByFrame = await detectOccupiedRegions(frames, {
          apiKey,
          signal: ctx.signal,
          instructions: SYSTEM_PROMPT,
          schemaName: "osg_placement_analysis",
          errorLabel: "OSG placement",
          timeout: 240_000,
        });
        const regions = [...regionsByFrame.values()].flat();

        const positions = await chooseWatermarkPositions(
          engine, assetId, regions, source.width, source.height, userScale,
        );

        const analysis: OsgPlacementAnalysis = {
          version: OSG_PLACEMENT_VERSION,
          fingerprint,
          sourceWidth: source.width,
          sourceHeight: source.height,
          frameTimes: sampled.map((file) => parseFloat(file)),
          regions,
          positions,
          analyzedAt: new Date().toISOString(),
        };
        await writeOsgPlacementAnalysis(engine, assetId, analysis);
        return { analysis } satisfies OsgPlacementResult;
      },
      { durationMs: LOCK_DURATION_MS, waitForActiveMs: 30_000 },
    );
  });
}
