import type { FontSizePreset, Orientation, SubtitlePosition } from "./subtitles/types.js";

export const LANDSCAPE_WIDTH = 1920;
export const LANDSCAPE_HEIGHT = 1080;
export const PORTRAIT_WIDTH = 1080;
export const PORTRAIT_HEIGHT = 1920;

const TIKDANCE_FONT_SIZES: Record<FontSizePreset, Record<Orientation, number>> = {
  small:  { portrait: 90,  landscape: 72 },
  medium: { portrait: 120, landscape: 96 },
  large:  { portrait: 150, landscape: 120 },
};

const HIGHLIGHT_FONT_SIZES: Record<FontSizePreset, Record<Orientation, number>> = {
  small:  { portrait: 56,  landscape: 40 },
  medium: { portrait: 72,  landscape: 52 },
  large:  { portrait: 88,  landscape: 64 },
};

export function getTikDanceFontSize(preset: FontSizePreset, orientation: Orientation): number {
  return TIKDANCE_FONT_SIZES[preset][orientation];
}

export function getHighlightFontSize(preset: FontSizePreset, orientation: Orientation): number {
  return HIGHLIGHT_FONT_SIZES[preset][orientation];
}

const Y_POSITIONS: Record<SubtitlePosition, Record<Orientation, number>> = {
  top:    { portrait: 0.15, landscape: 0.15 },
  middle: { portrait: 0.45, landscape: 0.45 },
  bottom: { portrait: 0.72, landscape: 0.80 },
};

export function getYPosition(position: SubtitlePosition, orientation: Orientation): number {
  return Y_POSITIONS[position][orientation];
}

export const DEFAULT_TEXT_COLOR = "#F8FAFC";
export const DEFAULT_HIGHLIGHT_COLOR = "#991B1B";
export const POP_DURATION_FRAMES = 4; // ~120ms at 30fps
export const POP_SCALE_START = 1.3;
export const POP_SCALE_END = 1.0;
