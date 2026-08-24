export const DEFAULT_HANDLE_VERTICAL_PERCENT = 33;
export const MIN_HANDLE_VERTICAL_PERCENT = 10;
export const MAX_HANDLE_VERTICAL_PERCENT = 90;

function clampHandleVerticalPercent(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_HANDLE_VERTICAL_PERCENT;
  return Math.min(MAX_HANDLE_VERTICAL_PERCENT, Math.max(MIN_HANDLE_VERTICAL_PERCENT, value));
}

export function watermarkHandleOverlayY(verticalPercent: number): string {
  const boundedPercent = clampHandleVerticalPercent(verticalPercent);
  return `main_h*${boundedPercent}/100-overlay_h/2`;
}
