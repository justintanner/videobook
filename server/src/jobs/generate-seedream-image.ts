import type { Engine } from "videobook-engine";
import { submitKieTask } from "./kie-paygate.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildSeedreamImageEditPayload } from "../payload-builders.js";
import type { ImageInput } from "../tools/_image-inputs.js";
import type { SeedreamImageToImageRequest } from "@apicity/kie";
import { transformProviderPrompt } from "../provider-prompt-transform.js";

type GenerateSeedreamImagePayload = {
  type: "generate_seedream_image";
  prompt: string;
  imageInputs: ImageInput[];
  imgAssetId: string;
  imgAssetDir: string;
  sourceImageIds: string[];
  bookId: string;
  aspectRatio?: SeedreamImageToImageRequest["input"]["aspect_ratio"];
  quality?: SeedreamImageToImageRequest["input"]["quality"];
  nsfwChecker?: boolean;
};

export function registerGenerateSeedreamImageJob(fs: Engine): void {
  registerJobHandler("generate_seedream_image", async (payload, ctx) => {
    const {
      prompt, imageInputs, imgAssetId, imgAssetDir,
      sourceImageIds, bookId, aspectRatio, quality, nsfwChecker,
    } = payload as GenerateSeedreamImagePayload;

    requireApiKey("KIE_API_KEY");

    const uploadedUrls: string[] = [];
    for (const input of imageInputs) {
      if ("url" in input) {
        uploadedUrls.push(input.url);
      } else {
        uploadedUrls.push(await uploadAssetToKie(fs, input.assetId, input.filename, bookId));
      }
    }
    const normalizedPrompt = transformProviderPrompt(
      "generate_kie_seedream_v5_lite_image_to_image",
      {
        prompt,
        image_slugs: imageInputs
          .map((input) => ("assetId" in input ? input.assetId : null))
          .filter((assetId): assetId is string => assetId !== null),
      },
    ) ?? "";

    const request = buildSeedreamImageEditPayload(
      {
        prompt: normalizedPrompt,
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
      bookId,
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
