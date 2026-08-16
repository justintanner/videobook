import {
  expandRect,
  intersectionArea,
  orientationDimensions,
} from "./keyword-placement.js";
import type { KeywordOccupiedRegion, NormalizedRect } from "./keyword-placement.js";
import type { Orientation, OsgPosition, OsgSize } from "./subtitles/types.js";

// Max edge of the graphic as a fraction of the video width. Sized for a
// visible on-screen graphic (TV-style logo bug): `medium` ≈ 14% of width,
// `small` half that, `large` 1.5×. The previous 5%/2.5%/7.5% presets rendered
// a near-invisible corner thumbnail that users read as "OSG didn't apply".
const SIZE_FACTOR: Record<OsgSize, number> = {
  small: 0.07,
  medium: 0.14,
  large: 0.21,
};

// The OSG always eases in/out over this window so it never pops abruptly.
export const FADE_SECONDS = 0.4;

export interface OsgWindow {
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

function ramp(frame: number, x0: number, x1: number, y0: number, y1: number): number {
  if (frame <= x0) return y0;
  if (frame >= x1) return y1;
  return y0 + ((frame - x0) / (x1 - x0)) * (y1 - y0);
}

/**
 * Opacity envelope for a frame within a window: eases in over FADE_SECONDS and
 * symmetrically eases out toward the window end — including the implicit
 * end-of-clip, so a whole-video watermark fades at both edges. Frames outside
 * [startFrame, endFrame) are hard-gated to 0 so a collapsed fade on a
 * sub-second span can't leave the graphic showing past its window.
 */
export function osgFadeEnvelope(frame: number, window: OsgWindow, fps: number): number {
  const { startFrame, endFrame } = window;
  if (frame < startFrame || frame >= endFrame) return 0;
  const span = Math.max(1, endFrame - startFrame);
  const maxFade = Math.max(1, Math.round(FADE_SECONDS * fps));
  const fade = Math.max(1, Math.min(maxFade, Math.floor(span / 2)));
  const inEnd = startFrame + fade;
  const outStart = endFrame - fade;
  if (outStart > inEnd) {
    if (frame >= outStart) return ramp(frame, outStart, endFrame, 1, 0);
    return ramp(frame, startFrame, inEnd, 0, 1);
  }
  return ramp(frame, startFrame, inEnd, 0, 1);
}

export function osgMaxSize(width: number, size: OsgSize, scale: number): number {
  return Math.round(width * SIZE_FACTOR[size] * scale);
}

export function osgPadding(width: number): number {
  return Math.round(width * 0.02);
}

export interface OsgAnchorPlacement {
  top?: number | string;
  bottom?: number | string;
  left?: number | string;
  right?: number | string;
  transforms: string[];
}

export function osgAnchorPlacement(position: OsgPosition, padding: number): OsgAnchorPlacement {
  const [vertical, horizontal] = position.split("-");
  const placement: OsgAnchorPlacement = { transforms: [] };
  if (vertical === "top") placement.top = padding;
  else if (vertical === "bottom") placement.bottom = padding;
  else {
    placement.top = "50%";
    placement.transforms.push("translateY(-50%)");
  }
  if (horizontal === "left") placement.left = padding;
  else if (horizontal === "right") placement.right = padding;
  else {
    placement.left = "50%";
    placement.transforms.push("translateX(-50%)");
  }
  return placement;
}

// ---------------------------------------------------------------------------
// Floating watermark: a faint QR + @handle badge shown for the whole clip.
// Sized off the canvas's min dimension (via a per-orientation osgScale) so the
// badge is the same physical size on landscape, portrait, and square renders.
// ---------------------------------------------------------------------------

// Badge height as a fraction of min(width, height) — ≈173px on a 1080 min dim,
// keeping the QR (~2/3 of badge height) scannable while staying unobtrusive.
export const WATERMARK_MIN_DIM_FRACTION = 0.16;
export const WATERMARK_OSG_SIZE: OsgSize = "medium";
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
 * OsgOverlay sizes off canvas width; translate the min-dim target into the
 * equivalent per-orientation osgScale for the `medium` preset, clamped to the
 * set_video_overlay schema range.
 */
export function watermarkOsgScale(orientation: Orientation, userScale = 1): number {
  const { width, height } = orientationDimensions(orientation);
  const minDim = Math.min(width, height);
  const raw = (WATERMARK_MIN_DIM_FRACTION / SIZE_FACTOR[WATERMARK_OSG_SIZE]) * (minDim / width) * userScale;
  return Math.min(2, Math.max(0.1, Number(raw.toFixed(4))));
}

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

export interface WatermarkCornerChoice {
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
