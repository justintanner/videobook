import { uploadAlibabaFile } from "../usage-providers.js";
import type { Engine } from "videobook-engine";
import { prepareAssetForUpload, uploadBytesToFreeHost, type UploadLimits } from "../upload.js";
import { getApiKey } from "../api-key.js";
import { logger } from "../logger.js";

// Upload an asset to DashScope's OSS bucket via @apicity/alibaba's uploadFile
// helper. Falls back to the free-host rotation if the policy fetch or OSS
// POST fails.
export async function uploadAssetToAlibaba(
  engine: Engine,
  assetId: string,
  filename: string,
  model: string,
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

  const apiKey = getApiKey("DASHSCOPE_API_KEY");
  if (apiKey) {
    try {
      return await uploadAlibabaFile({ apiKey, timeout: 60_000 }, {
        model,
        data,
        filename: hashedFilename,
        contentType,
      });
    } catch (err) {
      logger.warn("alibaba-upload-fallback", { error: err });
    }
  } else {
    logger.warn("alibaba-upload-unconfigured");
  }

  return uploadBytesToFreeHost(data, hashedFilename);
}
