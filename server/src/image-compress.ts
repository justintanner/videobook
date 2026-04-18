import sharp from "sharp";

export const JPEG_REENCODE_THRESHOLD_BYTES = 3 * 1024 * 1024;

const REENCODABLE_FORMATS = new Set(["jpeg", "png", "webp", "bmp", "tiff", "avif"]);

function replaceExtension(filename: string, newExt: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? `${filename}.${newExt}` : `${filename.slice(0, dot)}.${newExt}`;
}

// Re-encode raster images larger than the threshold to high-quality JPEG at
// the source resolution. Uploads to free hosts and Alibaba/Kie worker fetches
// are more reliable with smaller payloads, and wan i2v has a ~10 MB base-64
// cap (≈7 MB raw). Returns the input unchanged for non-images, small files,
// or cases where re-encoding would not shrink the payload.
export async function maybeReencodeImage(
  data: Uint8Array,
  filename: string,
): Promise<{ data: Uint8Array; filename: string }> {
  if (data.byteLength <= JPEG_REENCODE_THRESHOLD_BYTES) {
    return { data, filename };
  }

  let format: string | undefined;
  try {
    const meta = await sharp(data).metadata();
    format = meta.format;
  } catch {
    return { data, filename };
  }

  if (!format || !REENCODABLE_FORMATS.has(format)) {
    return { data, filename };
  }

  const reencoded = await sharp(data)
    .rotate()
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 92, mozjpeg: true, progressive: true, chromaSubsampling: "4:2:0" })
    .toBuffer();

  if (reencoded.byteLength >= data.byteLength) {
    return { data, filename };
  }

  return { data: new Uint8Array(reencoded), filename: replaceExtension(filename, "jpg") };
}
