import type { Engine } from "videobook-engine";
import { submitKieTask } from "./kie-paygate.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildGptImagePayload } from "../payload-builders.js";
import type { ImageInput } from "../tools/_image-inputs.js";
import type { GptImage2ImageToImageRequest } from "@apicity/kie";

type GenerateGptImagePayload = {
  type: "generate_gpt_image";
  prompt: string;
  imageInputs: ImageInput[];
  imgAssetId: string;
  imgAssetDir: string;
  sourceImageIds: string[];
  bookId: string;
  aspectRatio?: GptImage2ImageToImageRequest["input"]["aspect_ratio"];
  resolution?: GptImage2ImageToImageRequest["input"]["resolution"];
  nsfwChecker?: boolean;
};

export function registerGenerateGptImageJob(fs: Engine): void {
  registerJobHandler("generate_gpt_image", async (payload, ctx) => {
    const {
      prompt, imageInputs, imgAssetId, imgAssetDir,
      sourceImageIds, bookId, aspectRatio, resolution, nsfwChecker,
    } = payload as GenerateGptImagePayload;

    requireApiKey("KIE_API_KEY");

    const uploadedUrls: string[] = [];
    for (const input of imageInputs) {
      uploadedUrls.push(
        "url" in input
          ? input.url
          : await uploadAssetToKie(fs, input.assetId, input.filename, bookId),
      );
    }

    const request = buildGptImagePayload(
      { prompt, aspect_ratio: aspectRatio, resolution, nsfw_checker: nsfwChecker },
      uploadedUrls,
    );
    const taskId = await submitKieTask(fs, ctx, {
      request,
      taskType: "gpt_image",
      assetId: imgAssetId,
      assetDir: imgAssetDir,
      bookId,
      meta: {
        sourceImageIds,
        prompt,
        ...(aspectRatio !== undefined ? { aspectRatio } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        ...(nsfwChecker !== undefined ? { nsfwChecker } : {}),
      },
    });

    return { success: true, taskId };
  });
}
