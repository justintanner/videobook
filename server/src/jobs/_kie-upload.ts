import { uploadKieFile } from "../usage-providers.js";
import type { Engine } from "videobook-engine";
import {
  prepareAssetForUpload,
  uploadBytesToFreeHost,
} from "../upload.js";
import { getApiKey } from "../api-key.js";
import { logger } from "../logger.js";

// Upload prepared bytes to Kie's native storage via POST /api/file-stream-upload.
// Kie workers run in China — using their first-party CDN avoids the
// InvalidParameter.DataInspection failures we'd hit when the free-host URL
// is unreachable from their side. Falls back to the free-host rotation only
// if the native endpoint fails (missing key, timeout, 5xx, etc.).
async function uploadPreparedToKie(
  data: Uint8Array,
  hashedFilename: string,
  contentType: string,
): Promise<string> {
  const apiKey = getApiKey("KIE_API_KEY");
  if (apiKey) {
    try {
      const blob = new Blob([new Uint8Array(data)], { type: contentType });
      return await uploadKieFile({ apiKey, timeout: 120_000 }, blob, hashedFilename);
    } catch (err) {
      logger.warn("kie-upload-fallback", { error: err });
    }
  } else {
    logger.warn("kie-upload-unconfigured");
  }

  return uploadBytesToFreeHost(data, hashedFilename);
}

// Upload an asset to Kie's native storage.
export async function uploadAssetToKie(
  engine: Engine,
  assetId: string,
  filename: string,
): Promise<string> {
  const { data, hashedFilename, contentType } = await prepareAssetForUpload(
    engine,
    assetId,
    filename,
  );
  return uploadPreparedToKie(data, hashedFilename, contentType);
}
