import { createFal } from "../usage-providers.js";
import { uploadFile } from "@apicity/fal";
import type { Engine } from "videobook-engine";
import {
  prepareAssetForUpload,
  uploadBytesToFreeHost,
} from "../upload.js";
import { getApiKey } from "../api-key.js";
import { logger } from "../logger.js";

// Upload prepared bytes to fal's native CDN via @apicity/fal's uploadFile
// helper. Returns a stable https://v3.fal.media/... URL. Falls back to the
// free-host rotation on any native failure (missing key, network, non-2xx).
async function uploadPreparedToFal(
  data: Uint8Array,
  hashedFilename: string,
  contentType: string,
): Promise<string> {
  const apiKey = getApiKey("FAL_API_KEY");
  if (apiKey) {
    try {
      const provider = createFal({ apiKey, timeout: 60_000 });
      return await uploadFile(provider, {
        data,
        filename: hashedFilename,
        contentType,
      });
    } catch (err) {
      logger.warn("fal-upload-fallback", { error: err });
    }
  } else {
    logger.warn("fal-upload-unconfigured");
  }

  return uploadBytesToFreeHost(data, hashedFilename);
}

// Upload an asset file to fal's official CDN via storage.upload.initiate.
// Returns a stable https://v3.fal.media/... URL that fal's own model endpoints
// can fetch directly — no third-party free-host dependency.
export async function uploadAssetToFal(
  engine: Engine,
  assetId: string,
  filename: string,
): Promise<string> {
  const { data, hashedFilename, contentType } = await prepareAssetForUpload(
    engine,
    assetId,
    filename,
  );
  return uploadPreparedToFal(data, hashedFilename, contentType);
}
