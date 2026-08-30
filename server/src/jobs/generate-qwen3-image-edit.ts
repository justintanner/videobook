import type { Qwen3ImageToImageRequest } from "@apicity/kie";
import type { Engine } from "videobook-engine";
import { requireApiKey } from "../api-key.js";
import { buildQwen3ImageEditPayload } from "../payload-builders.js";
import { transformProviderPrompt } from "../provider-prompt-transform.js";
import { registerJobHandler } from "../queue.js";
import type { ImageInput } from "../tools/_image-inputs.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import { submitKieTask } from "./kie-paygate.js";

type GenerateQwen3ImageEditPayload = {
  type: "generate_qwen3_image_edit";
  prompt: string;
  imageInputs: ImageInput[];
  imgAssetId: string;
  imgAssetDir: string;
  sourceImageIds: string[];
  bookId: string;
  imageSize?: Qwen3ImageToImageRequest["input"]["image_size"];
  outputFormat?: Qwen3ImageToImageRequest["input"]["output_format"];
  promptExtend?: boolean;
  nsfwChecker?: boolean;
  negativePrompt?: string;
  seed?: number;
  resolution?: Qwen3ImageToImageRequest["input"]["resolution"];
};

export function registerGenerateQwen3ImageEditJob(engine: Engine): void {
  registerJobHandler("generate_qwen3_image_edit", async (payload, ctx) => {
    const {
      prompt,
      imageInputs,
      imgAssetId,
      imgAssetDir,
      sourceImageIds,
      bookId,
      imageSize,
      outputFormat,
      promptExtend,
      nsfwChecker,
      negativePrompt,
      seed,
      resolution,
    } = payload as GenerateQwen3ImageEditPayload;

    requireApiKey("KIE_API_KEY");

    const imageUrls = await Promise.all(
      imageInputs.map((input) => "url" in input
        ? Promise.resolve(input.url)
        : uploadAssetToKie(engine, input.assetId, input.filename)),
    );
    const normalizedPrompt = transformProviderPrompt(
      "generate_kie_qwen_3_0_edit_image",
      { prompt, image_refs: sourceImageIds },
    ) ?? "";
    const request = buildQwen3ImageEditPayload(
      {
        prompt: normalizedPrompt,
        ...(imageSize !== undefined ? { image_size: imageSize } : {}),
        ...(outputFormat !== undefined ? { output_format: outputFormat } : {}),
        ...(promptExtend !== undefined ? { prompt_extend: promptExtend } : {}),
        ...(nsfwChecker !== undefined ? { nsfw_checker: nsfwChecker } : {}),
        ...(negativePrompt !== undefined ? { negative_prompt: negativePrompt } : {}),
        ...(seed !== undefined ? { seed } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
      },
      imageUrls,
    );
    const taskId = await submitKieTask(engine, ctx, {
      request,
      taskType: "qwen3_image_edit",
      assetId: imgAssetId,
      assetDir: imgAssetDir,
      bookId,
      meta: {
        sourceImageIds,
        prompt,
        ...(imageSize !== undefined ? { imageSize } : {}),
        ...(outputFormat !== undefined ? { outputFormat } : {}),
        ...(promptExtend !== undefined ? { promptExtend } : {}),
        ...(nsfwChecker !== undefined ? { nsfwChecker } : {}),
        ...(negativePrompt !== undefined ? { negativePrompt } : {}),
        ...(seed !== undefined ? { seed } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
      },
    });

    return { success: true, taskId };
  });
}
