import { createAlibaba, uploadFile } from "@apicity/alibaba";
import type { Engine } from "videobook-engine";
import { prepareAssetForUpload, uploadBytesToFreeHost } from "../upload.js";
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
): Promise<string> {
  const { data, hashedFilename, contentType } = await prepareAssetForUpload(
    engine,
    assetId,
    filename,
  );

  const apiKey = getApiKey("DASHSCOPE_API_KEY");
  if (apiKey) {
    try {
      const provider = createAlibaba({ apiKey, timeout: 60_000 });
      return await uploadFile(provider, {
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
