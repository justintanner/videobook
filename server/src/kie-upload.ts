import type { KieProvider } from "@nakedapi/kie";
import { KieError } from "@nakedapi/kie";
import type { ClipfirstFs } from "clipfirst-fs";

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

function inferMimeType(filename: string): string | undefined {
  const ext = filename.split(".").pop()?.toLowerCase();
  return ext ? MIME_TYPES[ext] : undefined;
}

/**
 * Upload raw bytes via base64 encoding.
 * Used for images and as fallback when no stored Kie URL exists.
 */
export async function uploadBase64(
  provider: KieProvider,
  data: Uint8Array | Buffer,
  filename: string,
  uploadPath: string = "uploads",
): Promise<string> {
  const base64Data = Buffer.from(data).toString("base64");
  const mimeType = inferMimeType(filename);

  const result = await provider.post.api.fileBase64Upload({
    base64Data,
    uploadPath,
    fileName: filename,
    ...(mimeType !== undefined ? { mimeType } : {}),
  });

  if (!result.data?.downloadUrl) {
    throw new KieError("upload failed: no downloadUrl in response", result.code);
  }
  return result.data.downloadUrl;
}

/**
 * Upload via a pre-existing URL.
 * Used for videos/audio that have a stored Kie download URL.
 */
export async function uploadViaUrl(
  provider: KieProvider,
  url: string,
  filename: string,
  uploadPath: string = "uploads",
): Promise<string> {
  const result = await provider.post.api.fileUrlUpload({
    fileUrl: url,
    uploadPath,
    fileName: filename,
  });

  if (!result.data?.downloadUrl) {
    throw new KieError("upload failed: no downloadUrl in response", result.code);
  }
  return result.data.downloadUrl;
}

/**
 * Upload an asset file to Kie. Tries stored download_url (via fileUrlUpload)
 * first, falls back to reading the file and uploading via base64.
 */
export async function uploadAssetFile(
  provider: KieProvider,
  fs: ClipfirstFs,
  assetId: string,
  filename: string,
  projectSlug: string,
): Promise<string> {
  const meta = await fs.readMetadata<{ download_url?: string }>(assetId, "original", projectSlug);
  if (meta.ok && meta.value.download_url) {
    try {
      return await uploadViaUrl(provider, meta.value.download_url, filename);
    } catch {
      // URL may be expired — fall through to base64
    }
  }

  const readResult = await fs.readFile(assetId, filename, projectSlug);
  if (!readResult.ok) throw new Error(readResult.error.message);
  return uploadBase64(provider, new Uint8Array(readResult.value), filename);
}
