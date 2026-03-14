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
