import {
  expandRect,
  intersectionArea,
  orientationDimensions,
} from "./keyword-placement.js";
import type { KeywordOccupiedRegion, NormalizedRect } from "./keyword-placement.js";
import type { Orientation, OsgPosition } from "./subtitles/types.js";

interface OsgWindow {
  startFrame: number;
  endFrame: number;
  hasExplicitEnd: boolean;
}

/**
 * Resolve the visibility window [startFrame, endFrame). Precedence: an explicit
 * absolute window (startSeconds/endSeconds) wins; else a duration-relative tail;
 * else the full clip.
 */
export function resolveOsgWindow(opts: {
  startSeconds: number | null;
  endSeconds: number | null;
  tailSeconds: number | null;
  durationInFrames: number;
  fps: number;
}): OsgWindow {
  const { startSeconds, endSeconds, tailSeconds, durationInFrames, fps } = opts;
  const hasAbsoluteWindow = startSeconds != null || endSeconds != null;
  let startFrame: number;
  let endFrame: number;
  if (hasAbsoluteWindow) {
    startFrame = startSeconds != null ? Math.round(startSeconds * fps) : 0;
    endFrame = endSeconds != null ? Math.round(endSeconds * fps) : durationInFrames;
  } else if (tailSeconds != null) {
    startFrame = Math.max(0, durationInFrames - Math.round(tailSeconds * fps));
    endFrame = durationInFrames;
  } else {
    startFrame = 0;
    endFrame = durationInFrames;
  }
  startFrame = Math.min(Math.max(0, startFrame), durationInFrames);
  endFrame = Math.min(Math.max(startFrame, endFrame), durationInFrames);
  return { startFrame, endFrame, hasExplicitEnd: endFrame < durationInFrames };
}

export function osgPadding(width: number): number {
  return Math.round(width * 0.02);
}

// Badge height as a fraction of min(width, height) — ≈173px on a 1080 min dim,
// keeping the QR (~2/3 of badge height) scannable while staying unobtrusive.
export const WATERMARK_MIN_DIM_FRACTION = 0.16;
export const WATERMARK_OPACITY = 0.5;

// Candidate anchors in tie-break preference order.
export const WATERMARK_CORNERS: readonly OsgPosition[] = [
  "bottom-right",
  "bottom-left",
  "top-right",
  "top-left",
];

const WATERMARK_OCCUPIED_MARGIN = 0.04;
const REGION_KIND_WEIGHT: Record<KeywordOccupiedRegion["kind"], number> = {
  face: 3,
  text: 2,
  graphic: 1,
};

/**
 * On-canvas rect of the contain-fitted badge at a given anchor, normalized to
 * an arbitrary canvas (a render orientation or the source frame itself, for
 * burned-in watermarks). `aspect` is the badge's width/height (< 1: the badge
 * is taller than wide, so height binds at maxSize).
 */
function watermarkRectForCanvas(
  width: number,
  height: number,
  corner: OsgPosition,
  aspect: number,
  userScale = 1,
): NormalizedRect {
  const maxSize = Math.round(Math.min(width, height) * WATERMARK_MIN_DIM_FRACTION * userScale);
  const badgeHeight = aspect < 1 ? maxSize : maxSize / aspect;
  const badgeWidth = badgeHeight * aspect;
  const padding = osgPadding(width);
  const [vertical, horizontal] = corner.split("-");
  const x = horizontal === "left"
    ? padding
    : horizontal === "right"
      ? width - padding - badgeWidth
      : (width - badgeWidth) / 2;
  const y = vertical === "top"
    ? padding
    : vertical === "bottom"
      ? height - padding - badgeHeight
      : (height - badgeHeight) / 2;
  return {
    x: x / width,
    y: y / height,
    width: badgeWidth / width,
    height: badgeHeight / height,
  };
}

export function watermarkRectForCorner(
  orientation: Orientation,
  corner: OsgPosition,
  aspect: number,
  userScale = 1,
): NormalizedRect {
  const { width, height } = orientationDimensions(orientation);
  return watermarkRectForCanvas(width, height, corner, aspect, userScale);
}

interface WatermarkCornerChoice {
  position: OsgPosition;
  scores: Partial<Record<OsgPosition, number>>;
}

/**
 * Pick the least-occupied corner for the watermark. Score per corner is the
 * summed overlap area with each occupied region (expanded by a margin),
 * weighted by region kind and confidence; the subtitle band counts as a
 * full-confidence text region. Ties resolve by WATERMARK_CORNERS order.
 */
export function scoreWatermarkCornersForCanvas(
  width: number,
  height: number,
  occupied: KeywordOccupiedRegion[],
  opts: { aspect: number; userScale?: number; subtitleBand?: NormalizedRect | null },
): WatermarkCornerChoice {
  const { aspect, userScale = 1, subtitleBand = null } = opts;
  const scores: Partial<Record<OsgPosition, number>> = {};
  let best: OsgPosition = WATERMARK_CORNERS[0];
  let bestScore = Number.POSITIVE_INFINITY;
  for (const corner of WATERMARK_CORNERS) {
    const rect = watermarkRectForCanvas(width, height, corner, aspect, userScale);
    let score = 0;
    for (const region of occupied) {
      const expanded = expandRect(region, WATERMARK_OCCUPIED_MARGIN);
      score += intersectionArea(rect, expanded) * REGION_KIND_WEIGHT[region.kind] * region.confidence;
    }
    if (subtitleBand) {
      const expanded = expandRect(subtitleBand, WATERMARK_OCCUPIED_MARGIN);
      score += intersectionArea(rect, expanded) * REGION_KIND_WEIGHT.text;
    }
    scores[corner] = score;
    // Epsilon so float noise between mathematically-equal corner areas can't
    // steal a tie from the preference order.
    if (score < bestScore - 1e-9) {
      bestScore = score;
      best = corner;
    }
  }
  return { position: best, scores };
}

export function scoreWatermarkCorners(
  orientation: Orientation,
  occupied: KeywordOccupiedRegion[],
  opts: { aspect: number; userScale?: number; subtitleBand?: NormalizedRect | null },
): WatermarkCornerChoice {
  const { width, height } = orientationDimensions(orientation);
  return scoreWatermarkCornersForCanvas(width, height, occupied, opts);
}
