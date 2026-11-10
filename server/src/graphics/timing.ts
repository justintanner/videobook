import type { GraphicsTiming } from "./model.js";
import { MAX_GRAPHICS_FADE_SECONDS } from "./model.js";

export type ResolvedGraphicsTiming = { start: number; end: number; fadeIn: number; fadeOut: number };

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
