import { fal } from "@apicity/fal";
import type { ClipfirstFs } from "clipfirst-fs";
import {
  prepareAssetForUpload,
  prepareBytesForUpload,
  uploadBytesToFreeHost,
} from "../upload.js";

// Upload prepared bytes to fal's native CDN via storage.upload.initiate.
// Returns a stable https://v3.fal.media/... URL. Falls back to the free-host
// rotation on any native failure (missing key, network, non-2xx, etc.).
async function uploadPreparedToFal(
  data: Uint8Array,
  hashedFilename: string,
  contentType: string,
): Promise<string> {
  const apiKey = process.env.FAL_API_KEY;
  if (apiKey) {
    try {
      const provider = fal({ apiKey, timeout: 60_000 });
      const { file_url, upload_url } = await provider.storage.upload.initiate({
        file_name: hashedFilename,
        content_type: contentType,
      });

      const put = await fetch(upload_url, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: new Blob([new Uint8Array(data)], { type: contentType }),
      });
      if (!put.ok) {
        throw new Error(`fal storage PUT failed: ${put.status} ${put.statusText}`);
      }
      return file_url;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[fal-upload] native failed, falling back to free host: ${msg}`);
    }
  } else {
    console.warn("[fal-upload] FAL_API_KEY not set, using free host");
  }

  return uploadBytesToFreeHost(data, hashedFilename);
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
  const { data, hashedFilename, contentType } = await prepareAssetForUpload(
    fs,
    assetId,
    filename,
    projectSlug,
  );
  return uploadPreparedToFal(data, hashedFilename, contentType);
}

// Upload raw bytes (not a persisted asset) to fal's CDN — used for ephemeral
// inputs like outfit pose skeletons that never become project assets.
export async function uploadBytesToFal(
  bytes: Uint8Array | Buffer,
  filename: string,
): Promise<string> {
  const { data, hashedFilename, contentType } = await prepareBytesForUpload(bytes, filename);
  return uploadPreparedToFal(data, hashedFilename, contentType);
}
