export const DEFAULT_HANDLE_VERTICAL_PERCENT = 33;
export const MIN_HANDLE_VERTICAL_PERCENT = 10;
export const MAX_HANDLE_VERTICAL_PERCENT = 90;

export const WATERMARK_HANDLE_PLACEMENTS = [
  "center",
  "above-title",
  "above-qr",
  "on-qr",
  "below-qr",
] as const;

export type WatermarkHandlePlacement = (typeof WATERMARK_HANDLE_PLACEMENTS)[number];
