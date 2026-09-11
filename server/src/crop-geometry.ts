export type CropRatio = "16:9" | "9:16" | "1:1";

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const CANONICAL_DIMS: Record<CropRatio, [number, number]> = {
  "16:9": [1920, 1080],
  "9:16": [1080, 1920],
  "1:1": [1080, 1080],
};

export function cropGeometry(rect: CropRect, srcW: number, srcH: number, ratio: CropRatio, alignment: 1 | 2) {
  if (!Number.isFinite(srcW) || !Number.isFinite(srcH) || srcW < alignment || srcH < alignment) {
    throw new Error("Could not probe usable source dimensions");
  }
  const cropW = Math.min(Math.floor(srcW / alignment) * alignment, Math.max(alignment, Math.round(rect.w * srcW / alignment) * alignment));
  const cropH = Math.min(Math.floor(srcH / alignment) * alignment, Math.max(alignment, Math.round(rect.h * srcH / alignment) * alignment));
  const roundOrigin = alignment === 2 ? Math.floor : Math.round;
  const cropX = Math.min(srcW - cropW, Math.max(0, roundOrigin(rect.x * srcW / alignment) * alignment));
  const cropY = Math.min(srcH - cropH, Math.max(0, roundOrigin(rect.y * srcH / alignment) * alignment));
  const [outW, outH] = CANONICAL_DIMS[ratio];
  const cropAspect = cropW / cropH;
  const targetAspect = outW / outH;
  const aspectError = Math.abs(cropAspect - targetAspect) / targetAspect;
  if (aspectError > 0.02) {
    throw new Error(`Crop rectangle aspect ${cropAspect.toFixed(4)} (${cropW}x${cropH}) does not match target ratio ${ratio} (${targetAspect.toFixed(4)}); error ${(aspectError * 100).toFixed(1)}% > 2%`);
  }
  return { cropX, cropY, cropW, cropH, outW, outH };
}
