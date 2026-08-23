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

export function isWatermarkPosition(value: unknown): value is WatermarkPosition {
  return value === 'auto'
    || WATERMARK_POSITIONS.includes(value as (typeof WATERMARK_POSITIONS)[number])
}
