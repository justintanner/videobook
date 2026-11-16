import { uploadFalFile } from "../usage-providers.js";
import type { Engine } from "videobook-engine";
import {
  prepareAssetForUpload,
  uploadBytesToFreeHost,
  type UploadLimits,
} from "../upload.js";
import { getApiKey } from "../api-key.js";
import { logger } from "../logger.js";

async function uploadPreparedToFal(
  data: Uint8Array,
  hashedFilename: string,
  contentType: string,
): Promise<string> {
  const apiKey = getApiKey("FAL_API_KEY");
  if (apiKey) {
    try {
      return await uploadFalFile({ apiKey, timeout: 60_000 }, {
        data,
        filename: hashedFilename,
        contentType,
      });
    } catch (err) {
      const status = err && typeof err === "object" && "status" in err ? err.status : null;
      if (status === 401 || status === 403 || /\b(?:401|403|unauthori[sz]ed|insufficient (?:balance|credits)|account (?:blocked|disabled))\b/iu.test(err instanceof Error ? err.message : String(err))) throw err;
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
  signal?: AbortSignal,
  limits?: UploadLimits,
): Promise<string> {
  const { data, hashedFilename, contentType } = await prepareAssetForUpload(
    engine,
    assetId,
    filename,
    signal,
    limits,
  );
  return uploadPreparedToFal(data, hashedFilename, contentType);
}
