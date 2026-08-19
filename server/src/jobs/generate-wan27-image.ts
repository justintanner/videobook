import type { Engine } from "videobook-engine";
import { submitKieTask } from "./kie-paygate.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildWan27ImagePayload } from "../payload-builders.js";
import type { Wan27ImageRequest } from "@apicity/kie";
import { transformProviderPrompt } from "../provider-prompt-transform.js";

type GenerateWan27ImagePayload = {
  type: "generate_wan27_image";
  prompt: string;
  imageInputs: Array<{ assetId: string; filename: string }>;
  imgAssetId: string;
  imgAssetDir: string;
  sourceImageIds: string[];
  bookId: string;
  aspectRatio?: Wan27ImageRequest["input"]["aspect_ratio"];
  resolution?: Wan27ImageRequest["input"]["resolution"];
  seed?: number;
  nsfwChecker?: boolean;
};

export function registerGenerateWan27ImageJob(engine: Engine): void {
  registerJobHandler("generate_wan27_image", async (payload, ctx) => {
    const {
      prompt, imageInputs, imgAssetId, imgAssetDir,
      sourceImageIds, bookId, aspectRatio, resolution, seed, nsfwChecker,
    } = payload as GenerateWan27ImagePayload;

    requireApiKey("KIE_API_KEY");

    const uploadedUrls: string[] = [];
    for (const { assetId: srcAssetId, filename } of imageInputs) {
      uploadedUrls.push(await uploadAssetToKie(engine, srcAssetId, filename));
    }
    const normalizedPrompt = transformProviderPrompt(
      "generate_kie_wan_2_7_text_to_image",
      {
        prompt,
        image_refs: imageInputs.map((input) => input.assetId),
      },
    ) ?? "";

    const request = buildWan27ImagePayload(
      { prompt: normalizedPrompt, aspect_ratio: aspectRatio, resolution, seed, nsfw_checker: nsfwChecker },
      uploadedUrls,
    );
    const taskId = await submitKieTask(engine, ctx, {
      request,
      taskType: "wan27_image",
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
