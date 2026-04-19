import { fal } from "@apicity/fal";
import type { ClipfirstFs } from "clipfirst-fs";
import { maybeReencodeImage } from "../image-compress.js";

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

function inferContentType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  return (ext && MIME_TYPES[ext]) ?? "application/octet-stream";
}

// Upload an asset file to fal's official CDN via storage.upload.initiate.
// Returns a stable https://v3.fal.media/... URL that fal's own model endpoints
// can fetch directly — no third-party free-host dependency.
export async function uploadAssetToFal(
  fs: ClipfirstFs,
  assetId: string,
  filename: string,
  projectSlug: string,
): Promise<string> {
  const apiKey = process.env.FAL_API_KEY;
  if (!apiKey) throw new Error("FAL_API_KEY environment variable is not set");

  const read = await fs.readFile(assetId, filename, projectSlug);
  if (!read.ok) throw new Error(read.error.message);
  const raw = new Uint8Array(read.value);
  const { data, filename: outName } = await maybeReencodeImage(raw, filename);

  const content_type = inferContentType(outName);
  const provider = fal({ apiKey, timeout: 60_000 });
  const { file_url, upload_url } = await provider.storage.upload.initiate({
    file_name: outName,
    content_type,
  });

  const put = await fetch(upload_url, {
    method: "PUT",
    headers: { "Content-Type": content_type },
    body: new Blob([new Uint8Array(data)], { type: content_type }),
  });
  if (!put.ok) {
    throw new Error(`fal storage PUT failed: ${put.status} ${put.statusText}`);
  }

  return file_url;
}
