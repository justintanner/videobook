import { isSubtitleStyle } from "../remotion/subtitles/styles.js";
import type { Engine } from "videobook-engine";
import { findVideoFile } from "videobook-engine";
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
} from "../remotion/subtitles/types.js";
import { RENDER_ORIENTATIONS, readStoredRenderDefaults } from "../tools/reconcile-project-work.js";
import { frameRegionsAt } from "../frame-regions.js";
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
  badgeAspect?: number;
};

export interface OsgPlacementResult {
  analysis: OsgPlacementAnalysis;
}

function isSubtitlePosition(value: unknown): value is SubtitlePosition {
  return value === "top" || value === "middle" || value === "bottom";
}

function isFontSizePreset(value: unknown): value is FontSizePreset {
  return value === "small" || value === "medium" || value === "large";
}

async function readSourceDimensions(
  engine: Engine,
  assetId: string,
  firstFrame: () => Promise<Buffer>,
): Promise<{ width: number; height: number }> {
  const meta = await engine.metadata.artifacts.read<{ width?: unknown; height?: unknown }>(assetId, "original");
  if (meta.ok
    && typeof meta.value.width === "number" && meta.value.width > 0
    && typeof meta.value.height === "number" && meta.value.height > 0) {
    return { width: meta.value.width, height: meta.value.height };
  }
  // Only the aspect matters for mapping onto the render canvas, so the sampled
  // frame's dimensions are an equivalent fallback.
  const probed = await sharp(await firstFrame()).metadata();
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
  badgeAspect: number,
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
      aspect: badgeAspect,
      userScale,
      subtitleBand: band,
    }).position;
  }
  return positions as Record<Orientation, OsgPosition>;
}

interface OsgPlacementRequest {
  assetId: string;
  fingerprint: string;
  userScale: number;
  badgeAspect?: number;
  signal: AbortSignal;
}

async function placementFrames(engine: Engine, assetId: string): Promise<{ sampled: string[]; mediaHash: string }> {
  const manifest = await engine.files.manifest(assetId);
  const mediaHash = manifest.ok ? findVideoFile(manifest.value.files)?.objectHash : null;
  const listResult = await engine.files.listSubdir(assetId, "original_frames");
  const frameFiles = listResult.ok
    ? listResult.value
        .filter((f) => f.endsWith(".jpg"))
        .sort((a, b) => parseFloat(a) - parseFloat(b))
    : [];
  if (frameFiles.length === 0 || !mediaHash) {
    throw new Error(`no_frames: asset ${assetId} has no original_frames to analyze`);
  }
  return { sampled: sampleEvenly(frameFiles, MAX_FRAMES), mediaHash };
}

async function readPlacementFrame(engine: Engine, assetId: string, file: string, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  const read = await engine.files.read(assetId, `original_frames/${file}`);
  if (!read.ok) throw new Error(read.error.message);
  return Buffer.from(read.value);
}

/**
 * Sample frames, look up their occupied regions (asking the vision model only
 * for frames no earlier caption, keyword or watermark pass covered), and pick
 * the least-busy corner per orientation. Writes the analysis cache on success.
 * Throws when there are no frames, or when uncached frames need vision and no
 * key is set, so callers can fall back to a coarser placement.
 */
export async function analyzeOsgPlacement(
  engine: Engine,
  request: OsgPlacementRequest,
): Promise<OsgPlacementAnalysis> {
  const { assetId, fingerprint, userScale, badgeAspect = BADGE_ASPECT, signal } = request;
  const { sampled, mediaHash } = await placementFrames(engine, assetId);
  const fileAt = new Map(sampled.map((file) => [parseFloat(file), file]));
  const frames = await frameRegionsAt({
    engine,
    artifactId: assetId,
    mediaHash,
    times: sampled.map((file) => parseFloat(file)),
    frames: (times) => Promise.all(times.map((time) => readPlacementFrame(engine, assetId, fileAt.get(time) ?? sampled[0], signal))),
    apiKey: getApiKey("OPENAI_API_KEY"),
    signal,
  });
  const regions = frames.flatMap((frame) => frame.regions);
  const source = await readSourceDimensions(engine, assetId, () => readPlacementFrame(engine, assetId, sampled[0], signal));

  const positions = await chooseWatermarkPositions(
    engine, assetId, regions, source.width, source.height, userScale, badgeAspect,
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
  return analysis;
}

export function registerOsgPlacementJob(engine: Engine): void {
  registerJobHandler("osg_placement", async (payload, ctx) => {
    const {
      assetId, assetDir, fingerprint, userScale, badgeAspect = BADGE_ASPECT,
    } = payload as OsgPlacementPayload;
    return withLockedLocalLease(
      engine,
      assetId,
      assetDir,
      ctx,
      "analyze",
      { durationMs: LOCK_DURATION_MS, data: { state: "analyzing-osg-placement" } },
      async () => {
        const analysis = await analyzeOsgPlacement(engine, {
          assetId,
          fingerprint,
          userScale,
          badgeAspect,
          signal: ctx.signal,
        });
        return { analysis } satisfies OsgPlacementResult;
      },
      { durationMs: LOCK_DURATION_MS, waitForActiveMs: 30_000 },
    );
  });
}
