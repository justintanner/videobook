import sharp from "sharp";

export interface ImageProbeResult {
  width: number;
  height: number;
}

export async function probeImage(buffer: Buffer): Promise<ImageProbeResult> {
  const metadata = await sharp(buffer).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  return { width, height };
}

export async function cropToFill(
  buffer: Buffer,
  targetW: number,
  targetH: number,
): Promise<Buffer> {
  return sharp(buffer)
    .resize(targetW, targetH, { fit: "cover", position: "centre" })
    .jpeg({ quality: 95 })
    .toBuffer();
}

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Extract a normalized (0..1) region and resize to target dimensions as JPEG. */
export async function cropRegion(
  buffer: Buffer,
  rect: CropRect,
  targetW: number,
  targetH: number,
): Promise<Buffer> {
  const meta = await sharp(buffer).metadata();
  const srcW = meta.width ?? 0;
  const srcH = meta.height ?? 0;
  if (!srcW || !srcH) {
    throw new Error("Could not probe image dimensions");
  }

  let width = Math.max(1, Math.round(rect.w * srcW));
  let height = Math.max(1, Math.round(rect.h * srcH));
  if (width > srcW) width = srcW;
  if (height > srcH) height = srcH;
  let left = Math.max(0, Math.round(rect.x * srcW));
  let top = Math.max(0, Math.round(rect.y * srcH));
  if (left + width > srcW) left = Math.max(0, srcW - width);
  if (top + height > srcH) top = Math.max(0, srcH - height);

  return sharp(buffer)
    .extract({ left, top, width, height })
    .resize(targetW, targetH, { fit: "fill" })
    .jpeg({ quality: 95 })
    .toBuffer();
}
