import { freeMediaUpload, uploadToAnyHost } from "@apicity/free-media-upload";
import { createHash } from "node:crypto";
import type { VideocityFs } from "vc-engine";
import { maybeReencodeImage, maybeUpscaleSmallImage } from "./image-compress.js";

export function contentHash(data: Buffer | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

const MIME_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
  aac: "audio/aac",
  m4a: "audio/mp4",
};

export function inferMimeType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  return (ext && MIME_TYPES[ext]) ?? "application/octet-stream";
}

// Upload bytes to a free file host and return a publicly accessible download
// URL. Delegates rotation to @apicity/free-media-upload's `uploadToAnyHost` across
// litterbox/uguu/tflink.
//
// Host selection matters: Alibaba/Kie workers run in China and synchronously
// fetch the URL server-side during data inspection. Several otherwise-fine
// hosts (catbox.moe, filebin.net, temp.sh, tmpfiles.org) are unreachable or
// mis-typed from that side and cause InvalidParameter.DataInspection 400s
// even when the upload itself succeeded. The three hosts below were verified
// end-to-end (upload OK + Alibaba submit accepted).
export async function uploadBytesToFreeHost(
  data: Uint8Array | Buffer,
  filename: string,
): Promise<string> {
  const mimeType = inferMimeType(filename);
  const blob = new Blob([new Uint8Array(data)], { type: mimeType });
  const file = new File([blob], filename, { type: mimeType });

  return uploadToAnyHost(freeMediaUpload(), {
    file,
    filename,
    hosts: ["litterbox", "uguu", "tflink"],
    time: "1h",
  });
}

// Re-encode bytes (if applicable), upscale small images, and hash the final
// bytes for a collision-free remote filename. Shared preamble for both asset
// and raw-bytes provider upload wrappers.
export async function prepareBytesForUpload(
  bytes: Uint8Array | Buffer,
  filename: string,
): Promise<{ data: Uint8Array; hashedFilename: string; contentType: string }> {
  const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const reencoded = await maybeReencodeImage(raw, filename);
  const { data, filename: outName } = await maybeUpscaleSmallImage(reencoded.data, reencoded.filename);

  const ext = outName.split(".").pop() ?? "bin";
  const hashedFilename = `${contentHash(data)}.${ext}`;
  const contentType = inferMimeType(outName);

  return { data, hashedFilename, contentType };
}

// Read an asset, optionally re-encode it, and hash its final bytes for use as
// a collision-free remote filename. Shared preamble for every provider-native
// upload wrapper.
export async function prepareAssetForUpload(
  fs: VideocityFs,
  assetId: string,
  filename: string,
  projectSlug: string,
): Promise<{ data: Uint8Array; hashedFilename: string; contentType: string }> {
  const readResult = await fs.readFile(assetId, filename, projectSlug);
  if (!readResult.ok) throw new Error(readResult.error.message);
  return prepareBytesForUpload(new Uint8Array(readResult.value), filename);
}

// Upload an asset file via the free-host rotation. Kept for
// provider-agnostic callers (e.g. `transcribe.ts`) that don't target a
// specific AI provider. Provider-specific jobs should call the matching
// `uploadAssetTo{Fal,Kie,Alibaba}` wrapper instead.
export async function uploadAssetFile(
  fs: VideocityFs,
  assetId: string,
  filename: string,
  projectSlug: string,
): Promise<string> {
  const { data, hashedFilename } = await prepareAssetForUpload(fs, assetId, filename, projectSlug);
  return uploadBytesToFreeHost(data, hashedFilename);
}
