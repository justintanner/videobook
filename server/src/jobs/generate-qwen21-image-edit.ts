import type { Engine } from "videobook-engine";
import type { Qwen21ImageToImageRequest } from "@apicity/kie";
import { requireApiKey } from "../api-key.js";
import { buildQwen21ImageEditPayload } from "../payload-builders.js";
import { transformProviderPrompt } from "../provider-prompt-transform.js";
import { registerJobHandler } from "../queue.js";
import type { ImageInput } from "../tools/_image-inputs.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import { submitKieTask } from "./kie-paygate.js";

type GenerateQwen21ImageEditPayload = {
  type: "generate_qwen21_image_edit";
  prompt: string;
  imageInputs: ImageInput[];
  imgAssetId: string;
  imgAssetDir: string;
  sourceImageIds: string[];
  bookId: string;
  aspectRatio?: Qwen21ImageToImageRequest["input"]["aspect_ratio"];
  background?: Qwen21ImageToImageRequest["input"]["background"];
  outputFormat?: Qwen21ImageToImageRequest["input"]["output_format"];
  resolution?: Qwen21ImageToImageRequest["input"]["resolution"];
  enhancePrompt?: boolean;
  nsfwChecker?: boolean;
  seed?: number;
};

export function registerGenerateQwen21ImageEditJob(engine: Engine): void {
  registerJobHandler("generate_qwen21_image_edit", async (payload, ctx) => {
    const {
      prompt,
      imageInputs,
      imgAssetId,
      imgAssetDir,
      sourceImageIds,
      bookId,
      aspectRatio,
      background,
      outputFormat,
      resolution,
      enhancePrompt,
      nsfwChecker,
      seed,
    } = payload as GenerateQwen21ImageEditPayload;

    requireApiKey("KIE_API_KEY");

    const imageUrls = await Promise.all(
      imageInputs.map((input) => "url" in input
        ? Promise.resolve(input.url)
        : uploadAssetToKie(engine, input.assetId, input.filename)),
    );
    const normalizedPrompt = transformProviderPrompt(
      "generate_kie_qwen_2_1_edit_image",
      { prompt, image_refs: sourceImageIds },
    ) ?? "";
    const request = buildQwen21ImageEditPayload(
      {
        prompt: normalizedPrompt,
        ...(aspectRatio !== undefined ? { aspect_ratio: aspectRatio } : {}),
        ...(background !== undefined ? { background } : {}),
        ...(outputFormat !== undefined ? { output_format: outputFormat } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        ...(enhancePrompt !== undefined ? { enhance_prompt: enhancePrompt } : {}),
        ...(nsfwChecker !== undefined ? { nsfw_checker: nsfwChecker } : {}),
        ...(seed !== undefined ? { seed } : {}),
      },
      imageUrls,
    );
    const taskId = await submitKieTask(engine, ctx, {
      request,
      taskType: "qwen21_image_edit",
      assetId: imgAssetId,
      assetDir: imgAssetDir,
      bookId,
      meta: {
        sourceImageIds,
        prompt,
        ...(aspectRatio !== undefined ? { aspectRatio } : {}),
        ...(outputFormat !== undefined ? { outputFormat } : {}),
        ...(seed !== undefined ? { seed } : {}),
      },
    });

    return { success: true, taskId };
  });
}
