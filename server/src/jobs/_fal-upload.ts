import { fal } from "@apicity/fal";
import type { ClipfirstFs } from "clipfirst-fs";
import { prepareAssetForUpload, uploadBytesToFreeHost } from "../upload.js";

// Upload an asset file to fal's official CDN via storage.upload.initiate.
// Returns a stable https://v3.fal.media/... URL that fal's own model endpoints
// can fetch directly — no third-party free-host dependency. Falls back to the
// free-host rotation if the native CDN path fails.
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
