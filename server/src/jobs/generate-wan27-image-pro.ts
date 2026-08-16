import type { Engine } from "videobook-engine";
import { submitKieTask } from "./kie-paygate.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildWan27ImageProPayload } from "../payload-builders.js";
import type { ImageInput } from "../tools/_image-inputs.js";
import type { Wan27ImageProRequest } from "@apicity/kie";
import { transformProviderPrompt } from "../provider-prompt-transform.js";

type GenerateWan27ImageProPayload = {
  type: "generate_wan27_image_pro";
  prompt: string;
  imageInputs: ImageInput[];
  imgAssetId: string;
  imgAssetDir: string;
  sourceImageIds: string[];
  bookId: string;
  aspectRatio?: Wan27ImageProRequest["input"]["aspect_ratio"];
  resolution?: Wan27ImageProRequest["input"]["resolution"];
  seed?: number;
  nsfwChecker?: boolean;
};

export function registerGenerateWan27ImageProJob(fs: Engine): void {
  registerJobHandler("generate_wan27_image_pro", async (payload, ctx) => {
    const {
      prompt, imageInputs, imgAssetId, imgAssetDir,
      sourceImageIds, bookId, aspectRatio, resolution, seed, nsfwChecker,
    } = payload as GenerateWan27ImageProPayload;

    requireApiKey("KIE_API_KEY");

    const uploadedUrls: string[] = [];
    for (const input of imageInputs) {
      uploadedUrls.push(
        "url" in input
          ? input.url
          : await uploadAssetToKie(fs, input.assetId, input.filename),
      );
    }
    const normalizedPrompt = transformProviderPrompt(
      "generate_kie_wan_2_7_pro_text_to_image",
      {
        prompt,
        image_refs: imageInputs
          .map((input) => ("assetId" in input ? input.assetId : null))
          .filter((assetId): assetId is string => assetId !== null),
      },
    ) ?? "";

    const request = buildWan27ImageProPayload(
      { prompt: normalizedPrompt, aspect_ratio: aspectRatio, resolution, seed, nsfw_checker: nsfwChecker },
      uploadedUrls,
    );
    const taskId = await submitKieTask(fs, ctx, {
      request,
      taskType: "wan27_image_pro",
      assetId: imgAssetId,
      assetDir: imgAssetDir,
      bookId,
      meta: {
        sourceImageIds,
        prompt,
        ...(aspectRatio !== undefined ? { aspectRatio } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        ...(seed !== undefined ? { seed } : {}),
        ...(nsfwChecker !== undefined ? { nsfwChecker } : {}),
      },
    });

    return { success: true, taskId };
  });
}
