import type { GraphicsMotion, GraphicsTiming } from "./model.js";
import { MAX_GRAPHICS_FADE_SECONDS } from "./model.js";

export type ResolvedGraphicsTiming = { start: number; end: number; fadeIn: number; fadeOut: number; enter: GraphicsMotion; exit: GraphicsMotion };

const CLIP_END_TOLERANCE_SECONDS = 0.001;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundSeconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function requestedWindow(timing: GraphicsTiming, duration: number): { start: number; end: number } {
  if (timing.start !== null || timing.end !== null) return { start: timing.start ?? 0, end: timing.end ?? duration };
  return { start: timing.tail === null ? 0 : duration - timing.tail, end: duration };
}

export function resolveLayerTiming(timing: GraphicsTiming, durationSeconds: number): ResolvedGraphicsTiming | null {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;
  const window = requestedWindow(timing, durationSeconds);
  const start = clamp(window.start, 0, durationSeconds);
  const end = clamp(window.end, start, durationSeconds);
  if (!(end > start)) return null;
  const fade = roundSeconds(Math.min(clamp(timing.fade, 0, MAX_GRAPHICS_FADE_SECONDS), (end - start) / 2));
  return {
    start,
    end,
    enter: timing.enter ?? "fade",
    exit: timing.exit ?? "fade",
    fadeIn: start > 0 ? fade : 0,
    fadeOut: end < durationSeconds - CLIP_END_TOLERANCE_SECONDS ? fade : 0,
  };
}

export function layerOpacityAt(timing: ResolvedGraphicsTiming | null, seconds: number): number {
  if (!timing || !Number.isFinite(seconds) || seconds < timing.start || seconds > timing.end) return 0;
  const rising = timing.fadeIn > 0 ? (seconds - timing.start) / timing.fadeIn : 1;
  const falling = timing.fadeOut > 0 ? (timing.end - seconds) / timing.fadeOut : 1;
  return Math.min(1, rising, falling);
}

export type GraphicsMotionBox = { x: number; y: number; width: number; height: number; frameWidth: number; frameHeight: number };
export type GraphicsGroupMotion = { opacity: number; dx: number; dy: number; scale: number; reveal: number };

function nearestEdge(box: GraphicsMotionBox): { dx: number; dy: number } {
  const edges = [
    { distance: box.x, dx: -box.x - box.width, dy: 0 },
    { distance: box.frameWidth - box.x - box.width, dx: box.frameWidth - box.x, dy: 0 },
    { distance: box.y, dx: 0, dy: -box.y - box.height },
    { distance: box.frameHeight - box.y - box.height, dx: 0, dy: box.frameHeight - box.y },
  ];
  return edges.reduce((nearest, edge) => edge.distance < nearest.distance ? edge : nearest);
}

export function groupMotionAt(timing: ResolvedGraphicsTiming | null, seconds: number, box: GraphicsMotionBox): GraphicsGroupMotion {
  const motion = { opacity: 1, dx: 0, dy: 0, scale: 1, reveal: 1 };
  if (!timing || !Number.isFinite(seconds) || seconds < timing.start || seconds > timing.end) return { ...motion, opacity: 0, reveal: 0 };
  const entering = timing.fadeIn > 0 && seconds < timing.start + timing.fadeIn;
  const exiting = timing.fadeOut > 0 && seconds > timing.end - timing.fadeOut;
  if (!entering && !exiting) return motion;
  const preset = entering ? timing.enter : timing.exit;
  const progress = clamp(entering ? (seconds - timing.start) / timing.fadeIn : (seconds - timing.end + timing.fadeOut) / timing.fadeOut, 0, 1);
  const ease = 1 - (1 - progress) ** 3;
  const visible = entering ? ease : 1 - ease;
  if (preset === "fade") return { ...motion, opacity: layerOpacityAt(timing, seconds) };
  if (preset === "words") return { ...motion, opacity: visible > 0 ? 1 : 0, reveal: visible };
  if (preset === "pop") return { ...motion, opacity: visible, scale: 0.85 + 0.15 * visible };
  const edge = nearestEdge(box);
  return { ...motion, dx: edge.dx * (1 - visible), dy: edge.dy * (1 - visible) };
}
