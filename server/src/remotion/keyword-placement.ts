import {
  LANDSCAPE_HEIGHT,
  LANDSCAPE_WIDTH,
  PORTRAIT_HEIGHT,
  PORTRAIT_WIDTH,
  SQUARE_HEIGHT,
  SQUARE_WIDTH,
  getHighlightFontSize,
  getImpactFontSize,
  getYPosition,
} from "./constants.js";
import type {
  FontSizePreset,
  KeywordGraphic,
  KeywordGraphicAnchor,
  Orientation,
  SubtitlePosition,
  SubtitleStyle,
} from "./subtitles/types.js";

export const KEYWORD_PLACEMENT_VERSION = 1;
export const KEYWORD_FRAME_CACHE_FILENAME = ".keyword-frames.jpg";
export const KEYWORD_PLACEMENT_METADATA_KEY = "keyword-graphics.placement";

export type KeywordOccupiedRegionKind = "face" | "text" | "graphic";

export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface KeywordOccupiedRegion extends NormalizedRect {
  kind: KeywordOccupiedRegionKind;
  confidence: number;
}

export interface KeywordPlacementCueAnalysis {
  cueId: string;
  text: string;
  frameTime: number;
  regions: KeywordOccupiedRegion[];
}

export interface KeywordPlacementAnalysis {
  version: number;
  fingerprint: string;
  sourceWidth: number;
  sourceHeight: number;
  frameCacheFilename: string;
  analyzedAt: string;
  cues: KeywordPlacementCueAnalysis[];
}

export interface KeywordLayout {
  top: number;
  sideInset: number;
  containerWidth: number;
  fontSize: number;
  side: "left" | "right";
  rect: NormalizedRect;
}

export interface KeywordPlacementSettings {
  subtitlesEnabled: boolean;
  subtitlePosition: SubtitlePosition;
  subtitleStyle: SubtitleStyle;
  subtitleFontSize: FontSizePreset;
}

export interface KeywordPlacementResult {
  graphics: KeywordGraphic[];
  skipped: string[];
}

const PLACEMENT_SCALES = [1, 0.85, 0.7] as const;
const ANCHORS: readonly KeywordGraphicAnchor[] = [
  "upper-left",
  "upper-right",
  "middle-left",
  "middle-right",
];
const OCCUPIED_MARGIN = 0.04;

export function keywordCueId(graphic: KeywordGraphic): string {
  const frameTime = graphic.frameTime ?? graphic.start;
  return `${graphic.text.toLocaleLowerCase()}@${frameTime.toFixed(3)}`;
}

export function orientationDimensions(orientation: Orientation): { width: number; height: number } {
  if (orientation === "portrait") return { width: PORTRAIT_WIDTH, height: PORTRAIT_HEIGHT };
  if (orientation === "square") return { width: SQUARE_WIDTH, height: SQUARE_HEIGHT };
  return { width: LANDSCAPE_WIDTH, height: LANDSCAPE_HEIGHT };
}

export function keywordFontSize(text: string, width: number, height: number, scale = 1): number {
  const portrait = height > width;
  const square = height === width;
  const base = width * (portrait ? 0.095 : square ? 0.078 : 0.055);
  const length = Array.from(text).length;
  const lengthScale = length > 16 ? 0.64 : length > 11 ? 0.78 : 1;
  return Math.round(base * lengthScale * scale);
}

export function keywordAnchorSide(anchor: KeywordGraphicAnchor): "left" | "right" {
  return anchor.endsWith("right") ? "right" : "left";
}

export function keywordLayout(
  text: string,
  anchor: KeywordGraphicAnchor,
  width: number,
  height: number,
  scale = 1,
): KeywordLayout {
  const portrait = height > width;
  const top = height * (anchor.startsWith("upper") ? 0.18 : 0.38);
  const sideInset = width * (portrait ? 0.065 : 0.07);
  const containerWidth = width * (portrait ? 0.72 : 0.43);
  const fontSize = keywordFontSize(text, width, height, scale);
  const textWidth = Math.min(
    containerWidth,
    Array.from(text).length * fontSize * 0.68,
  );
  const underlineWidth = Math.min(width * 0.14, fontSize * 2.25);
  const rectWidth = Math.max(textWidth, underlineWidth);
  const rectHeight = fontSize * 1.22 + Math.max(2, width * 0.002);
  const side = keywordAnchorSide(anchor);
  const x = side === "left" ? sideInset : width - sideInset - rectWidth;
  return {
    top,
    sideInset,
    containerWidth,
    fontSize,
    side,
    rect: {
      x: x / width,
      y: top / height,
      width: rectWidth / width,
      height: rectHeight / height,
    },
  };
}

function clampRect(rect: NormalizedRect): NormalizedRect {
  const x = Math.max(0, Math.min(1, rect.x));
  const y = Math.max(0, Math.min(1, rect.y));
  return {
    x,
    y,
    width: Math.max(0, Math.min(1 - x, rect.width)),
    height: Math.max(0, Math.min(1 - y, rect.height)),
  };
}

function expandRect(rect: NormalizedRect, margin: number): NormalizedRect {
  return clampRect({
    x: rect.x - margin,
    y: rect.y - margin,
    width: rect.width + margin * 2,
    height: rect.height + margin * 2,
  });
}

function intersects(a: NormalizedRect, b: NormalizedRect): boolean {
  return a.x < b.x + b.width
    && a.x + a.width > b.x
    && a.y < b.y + b.height
    && a.y + a.height > b.y;
}

function rectGap(a: NormalizedRect, b: NormalizedRect): number {
  const dx = Math.max(a.x - (b.x + b.width), b.x - (a.x + a.width), 0);
  const dy = Math.max(a.y - (b.y + b.height), b.y - (a.y + a.height), 0);
  return Math.hypot(dx, dy);
}

export function mapSourceRectToTarget(
  rect: NormalizedRect,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): NormalizedRect {
  const sourceAspect = sourceWidth / sourceHeight;
  const targetAspect = targetWidth / targetHeight;
  let foregroundWidth: number;
  let foregroundHeight: number;
  if (sourceAspect > targetAspect) {
    foregroundWidth = targetWidth;
    foregroundHeight = targetWidth / sourceAspect;
  } else {
    foregroundHeight = targetHeight;
    foregroundWidth = targetHeight * sourceAspect;
  }
  const offsetX = (targetWidth - foregroundWidth) / 2;
  const offsetY = (targetHeight - foregroundHeight) / 2;
  return clampRect({
    x: (offsetX + rect.x * foregroundWidth) / targetWidth,
    y: (offsetY + rect.y * foregroundHeight) / targetHeight,
    width: rect.width * foregroundWidth / targetWidth,
    height: rect.height * foregroundHeight / targetHeight,
  });
}

function subtitleBand(
  orientation: Orientation,
  targetWidth: number,
  targetHeight: number,
  position: SubtitlePosition,
  style: SubtitleStyle,
  fontSize: FontSizePreset,
): NormalizedRect {
  const y = getYPosition(position, orientation);
  const fontPx = style === "impact"
    ? getImpactFontSize(fontSize, orientation)
    : getHighlightFontSize(fontSize, orientation);
  const height = Math.max(targetHeight * 0.1, fontPx * 1.9) / targetHeight;
  const top = position === "top"
    ? y - 0.025
    : position === "bottom"
      ? y - height + 0.025
      : y - height / 2;
  return clampRect({ x: 0.02, y: top, width: 0.96, height });
}

function preferredAnchorOrder(index: number): KeywordGraphicAnchor[] {
  const preferRight = index % 2 === 0;
  return preferRight
    ? ["upper-right", "middle-right", "upper-left", "middle-left"]
    : ["upper-left", "middle-left", "upper-right", "middle-right"];
}

function choosePlacement(
  graphic: KeywordGraphic,
  index: number,
  targetWidth: number,
  targetHeight: number,
  occupied: NormalizedRect[],
): { anchor: KeywordGraphicAnchor; scale: number } | null {
  const order = preferredAnchorOrder(index);
  for (const scale of PLACEMENT_SCALES) {
    const safe = ANCHORS.flatMap((anchor) => {
      const rect = keywordLayout(graphic.text, anchor, targetWidth, targetHeight, scale).rect;
      if (occupied.some((region) => intersects(rect, region))) return [];
      const distance = occupied.length === 0
        ? 1
        : Math.min(...occupied.map((region) => rectGap(rect, region)));
      const preference = (order.length - order.indexOf(anchor)) * 0.0001;
      return [{ anchor, scale, score: distance + preference }];
    });
    safe.sort((a, b) => b.score - a.score);
    if (safe[0]) return { anchor: safe[0].anchor, scale: safe[0].scale };
  }
  return null;
}

export function resolveKeywordPlacements(
  graphics: KeywordGraphic[],
  analysis: KeywordPlacementAnalysis,
  orientation: Orientation,
  settings: KeywordPlacementSettings,
): KeywordPlacementResult {
  const { width, height } = orientationDimensions(orientation);
  const cues = new Map(analysis.cues.map((cue) => [cue.cueId, cue]));
  const placed: KeywordGraphic[] = [];
  const skipped: string[] = [];

  for (let index = 0; index < graphics.length; index++) {
    const graphic = graphics[index];
    const cue = cues.get(keywordCueId(graphic));
    if (!cue) throw new Error(`Missing placement analysis for keyword ${graphic.text}`);
    const occupied = cue.regions.map((region) => expandRect(mapSourceRectToTarget(
      region,
      analysis.sourceWidth,
      analysis.sourceHeight,
      width,
      height,
    ), OCCUPIED_MARGIN));
    if (settings.subtitlesEnabled) {
      occupied.push(expandRect(subtitleBand(
        orientation,
        width,
        height,
        settings.subtitlePosition,
        settings.subtitleStyle,
        settings.subtitleFontSize,
      ), OCCUPIED_MARGIN));
    }
    const decision = choosePlacement(graphic, index, width, height, occupied);
    if (!decision) {
      skipped.push(graphic.text);
      continue;
    }
    placed.push({
      ...graphic,
      anchor: decision.anchor,
      scale: decision.scale,
      side: keywordAnchorSide(decision.anchor),
    });
  }

  return { graphics: placed, skipped };
}
