import type { KieProvider } from "@apicity/kie";
import { KieError } from "@apicity/kie";
import { free } from "@apicity/free";
import { createHash } from "node:crypto";
import type { ClipfirstFs } from "clipfirst-fs";

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

function inferMimeType(filename: string): string | undefined {
  const ext = filename.split(".").pop()?.toLowerCase();
  return ext ? MIME_TYPES[ext] : undefined;
}

/**
 * Upload raw bytes to tmpfiles.org as a fallback when Kie's upload CDN is blocked.
 * Returns a publicly accessible download URL (valid for ~60 minutes).
 */
async function uploadToTmpfiles(data: Uint8Array | Buffer, filename: string): Promise<string> {
  const mimeType = inferMimeType(filename) ?? "application/octet-stream";
  const blob = new Blob([new Uint8Array(data)], { type: mimeType });
  const file = new File([blob], filename, { type: mimeType });

  const f = free();
  const result = await f.tmpfiles.api.v1.upload({ file, filename });

  const url = result.data?.url;
  if (!url) throw new Error("tmpfiles.org upload returned no URL");
  // Convert display URL to direct download URL: insert /dl/ after domain
  return url.replace("tmpfiles.org/", "tmpfiles.org/dl/");
}

/**
 * Upload raw bytes via Kie base64 endpoint, falling back to tmpfiles.org
 * when Kie's upload CDN is blocked by Cloudflare.
 */
export async function uploadBase64(
  provider: KieProvider,
  data: Uint8Array | Buffer,
  filename: string,
  uploadPath: string = "uploads",
): Promise<string> {
  const base64Data = Buffer.from(data).toString("base64");
  const mimeType = inferMimeType(filename);

  try {
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
  } catch (err) {
    if (err instanceof Error && "status" in err && (err as { status: number }).status === 403) {
      return uploadToTmpfiles(data, filename);
    }
    throw err;
  }
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
 * Upload an asset file to Kie. The remote filename is derived from the
 * file's SHA-256 hash so every distinct file lands at a unique CDN path —
 * this is what prevents cross-asset collisions where two assets with the
 * same local filename (`original.mp4`) would otherwise overwrite each
 * other in Kie's `uploads/{fileName}` bucket.
 *
 * A cached download_url is reused only when:
 *   1. the stored hash matches the current file content, AND
 *   2. the cached URL path contains that hash (proving it was written
 *      under the hashed-filename scheme — legacy URLs are invalidated).
 *
 * Falls back to base64 upload (with tmpfiles.org fallback if Kie's CDN
 * is blocked by Cloudflare).
 */
export async function uploadAssetFile(
  provider: KieProvider,
  fs: ClipfirstFs,
  assetId: string,
  filename: string,
  projectSlug: string,
): Promise<string> {
  const readResult = await fs.readFile(assetId, filename, projectSlug);
  if (!readResult.ok) throw new Error(readResult.error.message);
  const fileData = new Uint8Array(readResult.value);
  const fileHash = contentHash(fileData);

  const ext = filename.split(".").pop() ?? "bin";
  const hashedFilename = `${fileHash}.${ext}`;

  type OriginalMeta = { download_url?: string; download_url_content_hash?: string };
  const meta = await fs.readMetadata<OriginalMeta>(assetId, "original", projectSlug);
  const cachedUrl = meta.ok ? meta.value.download_url : undefined;
  const cacheHashMatches = meta.ok && meta.value.download_url_content_hash === fileHash;
  const cacheUrlIsHashed = cachedUrl !== undefined && cachedUrl.includes(fileHash);

  if (cachedUrl && cacheHashMatches && cacheUrlIsHashed) {
    try {
      return await uploadViaUrl(provider, cachedUrl, hashedFilename);
    } catch {
      // URL may be expired or upload CDN blocked — fall through to base64
    }
  }

  const url = await uploadBase64(provider, fileData, hashedFilename);

  // Cache the new URL + hash so repeated uploads of the same file skip base64.
  if (meta.ok) {
    await fs.writeMetadata(assetId, "original", {
      ...meta.value,
      download_url: url,
      download_url_content_hash: fileHash,
    }, projectSlug).catch(() => {});
  }

  return url;
}
