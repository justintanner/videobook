import type { GraphicsLayerLayout, GraphicsRect } from "./layout.js";
import { graphicsPlaceBox } from "./layout.js";
import type { GraphicsAnchor, GraphicsDocument, GraphicsFrame, GraphicsLayer, GraphicsPosition, GraphicsScrimLayer } from "./model.js";
import { GRAPHICS_ANCHOR_POINTS } from "./model.js";
import { resolveLayerTiming } from "./timing.js";

export type GraphicsRegionKind = "face" | "text" | "graphic";
export type GraphicsRegion = { kind: GraphicsRegionKind; confidence: number; x: number; y: number; width: number; height: number };
export type GraphicsRegionFrame = { time: number; regions: GraphicsRegion[] };
export type GraphicsWindow = { start: number; end: number };
export type GraphicsCover = { kind: "face" | "text"; time: number };
export type GraphicsPlacedLayer = Exclude<GraphicsLayer, GraphicsScrimLayer>;
export type GraphicsClearSpot = { position: GraphicsPosition; moved: boolean; covers: GraphicsCover[] };

type ClearSpotInput = {
  frame: GraphicsFrame;
  layer: GraphicsPlacedLayer;
  block: GraphicsRect;
  drawn: GraphicsRect;
  window: GraphicsWindow;
  frames: readonly GraphicsRegionFrame[];
  avoid: readonly GraphicsRect[];
};

type Candidate = { position: GraphicsPosition; drawn: GraphicsRect; score: number };

const BUCKET_SECONDS = 0.25;
const MAX_TIMES = 8;
const STEP_SECONDS = 1;
const MIN_CONFIDENCE = 0.4;
const COVER_FRACTION = 0.2;
const REGION_WEIGHTS: Readonly<Record<GraphicsRegionKind, number>> = { face: 3, text: 2, graphic: 1 };
const LAYER_WEIGHT = 2;
const PREFERRED_ANCHORS: readonly GraphicsAnchor[] = ["bottom-left", "bottom-right", "top-left", "top-right", "bottom", "top", "left", "right", "center"];
const EPSILON = 1e-6;

function bucket(time: number): number {
  return Number((Math.round(Math.max(0, time) / BUCKET_SECONDS) * BUCKET_SECONDS).toFixed(2));
}

export function graphicsLayerWindow(layer: GraphicsLayer, durationSeconds: number): GraphicsWindow | null {
  const timing = resolveLayerTiming(layer.timing, durationSeconds);
  return timing ? { start: timing.start, end: timing.end } : null;
}

export function graphicsPlacementTimes(window: GraphicsWindow): number[] {
  const span = Math.max(0, window.end - window.start);
  const count = Math.min(MAX_TIMES, Math.max(1, Math.ceil(span / STEP_SECONDS)));
  return [...new Set(Array.from({ length: count }, (_, index) => bucket(window.start + (span * (index + 0.5)) / count)))];
}

export function graphicsUncheckedTimes(times: readonly number[], frames: readonly GraphicsRegionFrame[]): number[] {
  const checked = new Set(frames.map((frame) => bucket(frame.time)));
  return times.filter((time) => !checked.has(bucket(time)));
}

function framesIn(window: GraphicsWindow, frames: readonly GraphicsRegionFrame[]): GraphicsRegionFrame[] {
  const slack = BUCKET_SECONDS / 2;
  return frames.filter((frame) => frame.time >= window.start - slack && frame.time <= window.end + slack);
}

function union(rects: readonly GraphicsRect[]): GraphicsRect | null {
  const drawn = rects.filter((rect) => rect.width > 0 && rect.height > 0);
  if (drawn.length === 0) return null;
  const left = Math.min(...drawn.map((rect) => rect.x));
  const top = Math.min(...drawn.map((rect) => rect.y));
  const right = Math.max(...drawn.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...drawn.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function graphicsDrawnBox(entry: GraphicsLayerLayout): GraphicsRect | null {
  if (entry.kind === "scrim") return null;
  if (entry.kind === "image" && entry.missing) return null;
  if (entry.kind !== "text") return union([entry.box]);
  if (entry.plate) return union([entry.plate]);
  return union(entry.items.flatMap((item) => [...item.lines, ...(item.icon ? [item.icon] : []), ...(item.accent ? [item.accent] : [])]));
}

function unitRect(rect: GraphicsRect, frame: GraphicsFrame): GraphicsRect {
  return { x: rect.x / frame.width, y: rect.y / frame.height, width: rect.width / frame.width, height: rect.height / frame.height };
}

function overlapArea(a: GraphicsRect, b: GraphicsRect): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

function coverage(box: GraphicsRect, region: GraphicsRect): number {
  const area = region.width * region.height;
  return area > 0 ? overlapArea(box, region) / area : 0;
}

export function graphicsLayerCovers(drawn: GraphicsRect, frame: GraphicsFrame, window: GraphicsWindow, frames: readonly GraphicsRegionFrame[]): GraphicsCover[] {
  const box = unitRect(drawn, frame);
  const covers = new Map<string, GraphicsCover>();
  for (const entry of framesIn(window, frames)) {
    for (const region of entry.regions) {
      if (region.kind === "graphic" || region.confidence < MIN_CONFIDENCE || coverage(box, region) < COVER_FRACTION) continue;
      covers.set(`${region.kind}@${entry.time}`, { kind: region.kind, time: entry.time });
    }
  }
  return [...covers.values()].sort((a, b) => a.time - b.time || a.kind.localeCompare(b.kind));
}

export function graphicsAvoidBoxes(document: GraphicsDocument, layout: readonly GraphicsLayerLayout[], layerId: string, durationSeconds: number): GraphicsRect[] {
  const target = document.layers.find((layer) => layer.id === layerId);
  const window = target ? graphicsLayerWindow(target, durationSeconds) : null;
  if (!window) return [];
  const drawn = new Map(layout.map((entry) => [entry.layerId, graphicsDrawnBox(entry)]));
  return document.layers.flatMap((layer) => {
    if (layer.id === layerId || !layer.visible) return [];
    const box = drawn.get(layer.id);
    const other = graphicsLayerWindow(layer, durationSeconds);
    return box && other && other.start < window.end && other.end > window.start ? [box] : [];
  });
}

function penalty(drawn: GraphicsRect, frames: readonly GraphicsRegionFrame[], avoid: readonly GraphicsRect[]): number {
  const regions = frames.reduce((total, entry) => total + entry.regions.reduce((sum, region) => (
    region.confidence < MIN_CONFIDENCE ? sum : sum + REGION_WEIGHTS[region.kind] * region.confidence * coverage(drawn, region)
  ), 0), 0);
  const layers = avoid.reduce((total, other) => total + LAYER_WEIGHT * coverage(drawn, other), 0);
  return regions / Math.max(1, frames.length) + layers;
}

function anchorPosition(layer: GraphicsPlacedLayer, anchor: GraphicsAnchor): GraphicsPosition {
  const point = GRAPHICS_ANCHOR_POINTS[anchor];
  return { anchor, x: point.x, y: point.y, space: layer.position.space };
}

export function graphicsClearSpot(input: ClearSpotInput): GraphicsClearSpot {
  const frames = framesIn(input.window, input.frames);
  const avoid = input.avoid.map((rect) => unitRect(rect, input.frame));
  const size = { width: input.block.width, height: input.block.height };
  const score = (drawn: GraphicsRect) => penalty(unitRect(drawn, input.frame), frames, avoid);
  const candidates = PREFERRED_ANCHORS.map((anchor): Candidate => {
    const position = anchorPosition(input.layer, anchor);
    const block = graphicsPlaceBox(input.frame, position, size);
    const drawn = { ...input.drawn, x: input.drawn.x + block.x - input.block.x, y: input.drawn.y + block.y - input.block.y };
    return { position, drawn, score: score(drawn) };
  });
  const best = candidates.reduce((winner, candidate) => (candidate.score < winner.score - EPSILON ? candidate : winner));
  if (score(input.drawn) <= best.score + EPSILON) {
    return { position: input.layer.position, moved: false, covers: graphicsLayerCovers(input.drawn, input.frame, input.window, input.frames) };
  }
  return { position: best.position, moved: true, covers: graphicsLayerCovers(best.drawn, input.frame, input.window, input.frames) };
}
