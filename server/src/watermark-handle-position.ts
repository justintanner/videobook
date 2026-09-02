import type { OsgPosition } from "./remotion/subtitles/types.js";

export const DEFAULT_HANDLE_VERTICAL_PERCENT = 33;
export const MIN_HANDLE_VERTICAL_PERCENT = 10;
export const MAX_HANDLE_VERTICAL_PERCENT = 90;

export const WATERMARK_HANDLE_PLACEMENTS = [
  "center",
  "above-qr",
  "on-qr",
  "below-qr",
] as const;

export type WatermarkHandlePlacement = (typeof WATERMARK_HANDLE_PLACEMENTS)[number];

export function isWatermarkHandlePlacement(
  value: unknown,
): value is WatermarkHandlePlacement {
  return typeof value === "string"
    && (WATERMARK_HANDLE_PLACEMENTS as readonly string[]).includes(value);
}

function clampHandleVerticalPercent(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_HANDLE_VERTICAL_PERCENT;
  return Math.min(MAX_HANDLE_VERTICAL_PERCENT, Math.max(MIN_HANDLE_VERTICAL_PERCENT, value));
}

export function watermarkHandleOverlayY(verticalPercent: number): string {
  const boundedPercent = clampHandleVerticalPercent(verticalPercent);
  return `main_h*${boundedPercent}/100-overlay_h/2`;
}

function axisPosition(
  align: "start" | "center" | "end",
  main: number,
  overlay: number,
  padding: number,
): number {
  if (align === "start") return padding;
  if (align === "end") return main - overlay - padding;
  return Math.round((main - overlay) / 2);
}

export function watermarkQrOverlayPixels(
  corner: OsgPosition,
  canvasWidth: number,
  canvasHeight: number,
  qrSize: number,
  padding: number,
): { x: number; y: number } {
  const [vertical, horizontal] = corner.split("-");
  return {
    x: axisPosition(
      horizontal === "left" ? "start" : horizontal === "right" ? "end" : "center",
      canvasWidth,
      qrSize,
      padding,
    ),
    y: axisPosition(
      vertical === "top" ? "start" : vertical === "bottom" ? "end" : "center",
      canvasHeight,
      qrSize,
      padding,
    ),
  };
}

function clampOverlayOrigin(
  value: number,
  main: number,
  overlay: number,
  padding: number,
): number {
  return Math.round(Math.min(main - overlay - padding, Math.max(padding, value)));
}

export function watermarkHandleOverlayPosition(options: {
  placement: WatermarkHandlePlacement;
  corner: OsgPosition;
  canvasWidth: number;
  canvasHeight: number;
  qrSize: number;
  handleWidth: number;
  handleHeight: number;
  padding: number;
  handleVerticalPercent?: number;
}): { x: string; y: string } {
  if (options.placement === "center") {
    return {
      x: "(main_w-overlay_w)/2",
      y: watermarkHandleOverlayY(
        options.handleVerticalPercent ?? DEFAULT_HANDLE_VERTICAL_PERCENT,
      ),
    };
  }
  const qr = watermarkQrOverlayPixels(
    options.corner,
    options.canvasWidth,
    options.canvasHeight,
    options.qrSize,
    options.padding,
  );
  const gap = Math.max(2, Math.round(options.qrSize * 0.06));
  const x = qr.x + (options.qrSize - options.handleWidth) / 2;
  const y = options.placement === "above-qr"
    ? qr.y - options.handleHeight - gap
    : options.placement === "below-qr"
      ? qr.y + options.qrSize + gap
      : qr.y + (options.qrSize - options.handleHeight) / 2;
  return {
    x: String(clampOverlayOrigin(
      x,
      options.canvasWidth,
      options.handleWidth,
      options.padding,
    )),
    y: String(clampOverlayOrigin(
      y,
      options.canvasHeight,
      options.handleHeight,
      options.padding,
    )),
  };
}
