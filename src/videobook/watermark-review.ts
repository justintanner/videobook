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

export function clampHandleVerticalPercent(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_HANDLE_VERTICAL_PERCENT
  return Math.min(MAX_HANDLE_VERTICAL_PERCENT, Math.max(MIN_HANDLE_VERTICAL_PERCENT, value))
}

export function isWatermarkPosition(value: unknown): value is WatermarkPosition {
  return value === 'auto'
    || WATERMARK_POSITIONS.includes(value as (typeof WATERMARK_POSITIONS)[number])
}
