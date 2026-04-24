import sharp from "sharp";

const JPEG_REENCODE_THRESHOLD_BYTES = 3 * 1024 * 1024;

// External image-gen APIs reject or silently degrade sub-300px inputs. Keep both
// dimensions at or above this floor by upscaling small images to JPEG.
const MIN_IMAGE_DIMENSION = 300;

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

// Upscale raster images whose shortest side is below MIN_IMAGE_DIMENSION so that
// both dimensions are at least MIN_IMAGE_DIMENSION, preserving aspect ratio.
// Output is always JPEG. Returns the input unchanged for non-raster formats or
// images that already meet the floor.
export async function maybeUpscaleSmallImage(
  data: Uint8Array,
  filename: string,
): Promise<{ data: Uint8Array; filename: string }> {
  let format: string | undefined;
  let width: number | undefined;
  let height: number | undefined;
  try {
    const meta = await sharp(data).metadata();
    format = meta.format;
    width = meta.width;
    height = meta.height;
  } catch {
    return { data, filename };
  }

  if (!format || !REENCODABLE_FORMATS.has(format)) return { data, filename };
  if (!width || !height) return { data, filename };
  if (width >= MIN_IMAGE_DIMENSION && height >= MIN_IMAGE_DIMENSION) {
    return { data, filename };
  }

  const resized = await sharp(data)
    .rotate()
    .flatten({ background: "#ffffff" })
    .resize({
      width: MIN_IMAGE_DIMENSION,
      height: MIN_IMAGE_DIMENSION,
      fit: "outside",
      withoutEnlargement: false,
    })
    .jpeg({ quality: 92, mozjpeg: true, progressive: true, chromaSubsampling: "4:2:0" })
    .toBuffer();

  return { data: new Uint8Array(resized), filename: replaceExtension(filename, "jpg") };
}
