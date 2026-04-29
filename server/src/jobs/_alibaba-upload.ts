import { alibaba, uploadFile } from "@apicity/alibaba";
import type { ClipfirstFs } from "clipfirst-engine";
import { prepareAssetForUpload, uploadBytesToFreeHost } from "../upload.js";

// Upload an asset to DashScope's OSS bucket via @apicity/alibaba's uploadFile
// helper. Falls back to the free-host rotation if the policy fetch or OSS
// POST fails.
export async function uploadAssetToAlibaba(
  fs: ClipfirstFs,
  assetId: string,
  filename: string,
  projectSlug: string,
  model: string,
): Promise<string> {
  const { data, hashedFilename, contentType } = await prepareAssetForUpload(
    fs,
    assetId,
    filename,
    projectSlug,
  );

  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (apiKey) {
    try {
      const provider = alibaba({ apiKey, timeout: 60_000 });
      return await uploadFile(provider, {
        model,
        data,
        filename: hashedFilename,
        contentType,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[alibaba-upload] native failed, falling back to free host: ${msg}`);
    }
  } else {
    console.warn("[alibaba-upload] DASHSCOPE_API_KEY not set, using free host");
  }

  return uploadBytesToFreeHost(data, hashedFilename);
}
