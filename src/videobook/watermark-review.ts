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
export const DEFAULT_HANDLE_ROUNDING = 100
export const MIN_HANDLE_ROUNDING = 0
export const MAX_HANDLE_ROUNDING = 100

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

export function clampHandleRounding(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_HANDLE_ROUNDING
  return Math.round(Math.min(MAX_HANDLE_ROUNDING, Math.max(MIN_HANDLE_ROUNDING, value)))
}

export function isWatermarkPosition(value: unknown): value is WatermarkPosition {
  return value === 'auto'
    || WATERMARK_POSITIONS.includes(value as (typeof WATERMARK_POSITIONS)[number])
}
