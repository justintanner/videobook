import type { VideocityFs } from "vc-engine";
import { submitKieTask } from "./kie-paygate.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildSeedreamImageEditPayload } from "../payload-builders.js";
import type { ImageInput } from "../tools/_image-inputs.js";

type GenerateSeedreamImagePayload = {
  type: "generate_seedream_image";
  prompt: string;
  imageInputs: ImageInput[];
  imgAssetId: string;
  imgAssetDir: string;
  sourceImageIds: string[];
  projectSlug: string;
  aspectRatio?: "1:1" | "4:3" | "3:4" | "16:9" | "9:16" | "2:3" | "3:2" | "21:9";
  quality?: "basic" | "high";
  nsfwChecker?: boolean;
};

export function registerGenerateSeedreamImageJob(fs: VideocityFs): void {
  registerJobHandler("generate_seedream_image", async (payload, ctx) => {
    const {
      prompt, imageInputs, imgAssetId, imgAssetDir,
      sourceImageIds, projectSlug, aspectRatio, quality, nsfwChecker,
    } = payload as GenerateSeedreamImagePayload;

    requireApiKey("KIE_API_KEY");

    const uploadedUrls: string[] = [];
    for (const input of imageInputs) {
      if ("url" in input) {
        uploadedUrls.push(input.url);
      } else {
        uploadedUrls.push(await uploadAssetToKie(fs, input.assetId, input.filename, projectSlug));
      }
    }

    const request = buildSeedreamImageEditPayload(
      {
        prompt,
        ...(aspectRatio !== undefined ? { aspect_ratio: aspectRatio } : {}),
        ...(quality !== undefined ? { quality } : {}),
        ...(nsfwChecker !== undefined ? { nsfw_checker: nsfwChecker } : {}),
      },
      uploadedUrls,
    );
    const taskId = await submitKieTask(fs, ctx, {
      request,
      taskType: "seedream_image",
      assetId: imgAssetId,
      assetDir: imgAssetDir,
      projectSlug,
      meta: {
        sourceImageIds,
        prompt,
        ...(aspectRatio !== undefined ? { aspectRatio } : {}),
        ...(quality !== undefined ? { quality } : {}),
        ...(nsfwChecker !== undefined ? { nsfwChecker } : {}),
      },
    });

    return { success: true, taskId };
  });
}
