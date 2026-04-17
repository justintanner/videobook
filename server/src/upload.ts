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

// Upload bytes to tmpfiles.org and return a publicly accessible download URL
// (valid for ~60 minutes). We bypass Kie's own CDN because tempfile.redpandaai.co
// is periodically unreachable from Kie's own job workers — the workers then
// fail with InvalidParameter / "Network is unreachable" before processing.
export async function uploadBytes(data: Uint8Array | Buffer, filename: string): Promise<string> {
  const mimeType = inferMimeType(filename) ?? "application/octet-stream";
  const blob = new Blob([new Uint8Array(data)], { type: mimeType });
  const file = new File([blob], filename, { type: mimeType });

  const f = free();
  const result = await f.tmpfiles.api.v1.upload({ file, filename });

  const url = result.data?.url;
  if (!url) throw new Error("tmpfiles.org upload returned no URL");
  // Convert display URL to direct download URL: insert /dl/ after the domain.
  return url.replace("tmpfiles.org/", "tmpfiles.org/dl/");
}

// Upload an asset file. The remote filename is derived from the file's
// SHA-256 hash so every distinct file lands at a unique path — this prevents
// cross-asset collisions where two assets with the same local filename
// (`original.mp4`) would otherwise overwrite each other.
export async function uploadAssetFile(
  fs: ClipfirstFs,
  assetId: string,
  filename: string,
  projectSlug: string,
): Promise<string> {
  const readResult = await fs.readFile(assetId, filename, projectSlug);
  if (!readResult.ok) throw new Error(readResult.error.message);
  const fileData = new Uint8Array(readResult.value);

  const ext = filename.split(".").pop() ?? "bin";
  const hashedFilename = `${contentHash(fileData)}.${ext}`;

  return uploadBytes(fileData, hashedFilename);
}
