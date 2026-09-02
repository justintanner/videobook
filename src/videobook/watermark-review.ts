export type WatermarkPosition =
  | 'auto'
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'middle-left'
  | 'middle-center'
  | 'middle-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right'

export const WATERMARK_POSITIONS = [
  'top-left', 'top-center', 'top-right',
  'middle-left', 'middle-center', 'middle-right',
  'bottom-left', 'bottom-center', 'bottom-right',
] as const

export const DEFAULT_HANDLE_VERTICAL_PERCENT = 33
export const MIN_HANDLE_VERTICAL_PERCENT = 10
export const MAX_HANDLE_VERTICAL_PERCENT = 90
export const DEFAULT_WATERMARK_OPACITY = 0.5
export const MIN_WATERMARK_OPACITY = 0.05
export const MAX_WATERMARK_OPACITY = 1
export const DEFAULT_HANDLE_PADDING = 32
export const MIN_HANDLE_PADDING = 0
export const MAX_HANDLE_PADDING = 96
export const DEFAULT_HANDLE_PILL_HEIGHT = 88
export const HANDLE_PILL_CONTENT_SIZE = 26
export const HANDLE_BADGE_WIDTH = 480
export const DEFAULT_HANDLE_ROUNDING = 100
export const MIN_HANDLE_ROUNDING = 0
export const MAX_HANDLE_ROUNDING = 100

export const WATERMARK_HANDLE_PLACEMENTS = [
  'center',
  'above-qr',
  'on-qr',
  'below-qr',
] as const

export type WatermarkHandlePlacement = (typeof WATERMARK_HANDLE_PLACEMENTS)[number]

export function clampHandleVerticalPercent(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_HANDLE_VERTICAL_PERCENT
  return Math.min(MAX_HANDLE_VERTICAL_PERCENT, Math.max(MIN_HANDLE_VERTICAL_PERCENT, value))
}

export function clampWatermarkOpacity(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_WATERMARK_OPACITY
  return Math.min(MAX_WATERMARK_OPACITY, Math.max(MIN_WATERMARK_OPACITY, value))
}

export function clampHandlePadding(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_HANDLE_PADDING
  return Math.round(Math.min(MAX_HANDLE_PADDING, Math.max(MIN_HANDLE_PADDING, value)))
}

export function handlePillHeight(paddingY: number): number {
  const clamped = clampHandlePadding(paddingY)
  return Math.max(
    HANDLE_PILL_CONTENT_SIZE + 4,
    DEFAULT_HANDLE_PILL_HEIGHT + 2 * (clamped - DEFAULT_HANDLE_PADDING),
  )
}

export function isWatermarkHandlePlacement(value: unknown): value is WatermarkHandlePlacement {
  return typeof value === 'string'
    && (WATERMARK_HANDLE_PLACEMENTS as readonly string[]).includes(value)
}

export function clampHandleRounding(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_HANDLE_ROUNDING
  return Math.round(Math.min(MAX_HANDLE_ROUNDING, Math.max(MIN_HANDLE_ROUNDING, value)))
}

export function isWatermarkPosition(value: unknown): value is WatermarkPosition {
  return value === 'auto'
    || WATERMARK_POSITIONS.includes(value as (typeof WATERMARK_POSITIONS)[number])
}

export const DEFAULT_WATERMARK_FADE_SECONDS = 0.5
export const MIN_WATERMARK_FADE_SECONDS = 0
export const MAX_WATERMARK_FADE_SECONDS = 2
const CLIP_END_TOLERANCE_SECONDS = 0.001

export function clampWatermarkFadeSeconds(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_WATERMARK_FADE_SECONDS
  const clamped = Math.min(MAX_WATERMARK_FADE_SECONDS, Math.max(MIN_WATERMARK_FADE_SECONDS, value))
  return Math.round(clamped * 10) / 10
}

export interface WatermarkFadeWindow {
  fadeIn: number
  fadeOut: number
}

// Mirrors the burn job: a watermark fades in only when it starts after the
// clip start and out only when it ends before the clip end, and each fade
// shrinks to half the window so short windows still peak at full opacity.
export function watermarkFadeWindow(
  startSeconds: number,
  endSeconds: number | null,
  durationSeconds: number,
  fadeSeconds: number,
): WatermarkFadeWindow {
  const start = Math.max(0, startSeconds)
  const clipEnd = endSeconds === null ? durationSeconds : Math.min(endSeconds, durationSeconds)
  const window = clipEnd - start
  if (!(fadeSeconds > 0) || !(window > 0)) return { fadeIn: 0, fadeOut: 0 }
  const fade = Math.min(fadeSeconds, window / 2)
  const endsEarly = endSeconds !== null
    && endSeconds < durationSeconds - CLIP_END_TOLERANCE_SECONDS
  return {
    fadeIn: start > 0 ? fade : 0,
    fadeOut: endsEarly ? fade : 0,
  }
}

// Preview opacity at the playhead: zero outside the window, ramping through
// the fades, `opacity` in between.
export function watermarkPreviewOpacity(
  currentTime: number,
  startSeconds: number,
  endSeconds: number | null,
  durationSeconds: number,
  opacity: number,
  fadeSeconds: number,
): number {
  if (currentTime < startSeconds) return 0
  if (endSeconds !== null && currentTime > endSeconds) return 0
  const fades = watermarkFadeWindow(startSeconds, endSeconds, durationSeconds, fadeSeconds)
  let factor = 1
  if (fades.fadeIn > 0) {
    factor = Math.min(factor, (currentTime - startSeconds) / fades.fadeIn)
  }
  if (fades.fadeOut > 0 && endSeconds !== null) {
    factor = Math.min(factor, (endSeconds - currentTime) / fades.fadeOut)
  }
  return opacity * Math.min(1, Math.max(0, factor))
}
