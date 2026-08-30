import type { FalEndpointInputMap } from "@apicity/fal";
import { KieError } from "@apicity/kie";
import type { Qwen3ImageToImageRequest } from "@apicity/kie";
import type { Engine } from "videobook-engine";
import { getApiKey, requireApiKey } from "../api-key.js";
import { buildQwen3ImageEditPayload } from "../payload-builders.js";
import { transformProviderPrompt } from "../provider-prompt-transform.js";
import { registerJobHandler } from "../queue.js";
import type { ImageInput } from "../tools/_image-inputs.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import { submitFalJob } from "./_fal-shared.js";
import { withProviderHandoff } from "./_lease.js";
import { submitKieTask } from "./kie-paygate.js";

type FalQwen3EditInput = FalEndpointInputMap["alibaba/qwen-image-3/edit"];

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

const KIE_TO_FAL_IMAGE_SIZE: Record<string, Exclude<FalQwen3EditInput["image_size"], undefined>> = {
  "1:1": "square_hd",
  "9:16": "portrait_16_9",
  "16:9": "landscape_16_9",
  "3:4": "portrait_4_3",
  "4:3": "landscape_4_3",
};

export function isKieBlankPlaygroundTaskError(error: unknown): boolean {
  if (!(error instanceof KieError)) return false;
  const status = error.status;
  return status === 422 && /task id is blank/i.test(error.message);
}

export function falImageSizeForKieQwen3(
  imageSize: Qwen3ImageToImageRequest["input"]["image_size"] | undefined,
): FalQwen3EditInput["image_size"] | undefined {
  if (!imageSize) return undefined;
  return KIE_TO_FAL_IMAGE_SIZE[imageSize];
}

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

    return withProviderHandoff(engine, imgAssetId, ctx, "generate", async (ownerId) => {
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

      try {
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
        return { taskId, result: { success: true, taskId } };
      } catch (error) {
        if (!isKieBlankPlaygroundTaskError(error) || !getApiKey("FAL_API_KEY")) {
          throw error;
        }
        const falImageSize = falImageSizeForKieQwen3(imageSize);
        const falInput: FalQwen3EditInput = {
          prompt: normalizedPrompt,
          image_urls: imageUrls,
          ...(falImageSize !== undefined ? { image_size: falImageSize } : {}),
          ...(promptExtend !== undefined ? { enable_prompt_expansion: promptExtend } : {}),
          ...(nsfwChecker !== undefined ? { enable_safety_checker: nsfwChecker } : {}),
          ...(negativePrompt !== undefined ? { negative_prompt: negativePrompt } : {}),
          ...(seed !== undefined ? { seed } : {}),
          ...(outputFormat !== undefined ? { output_format: outputFormat } : {}),
        };
        const taskId = await submitFalJob({
          engine,
          bookId,
          assetId: imgAssetId,
          assetDir: imgAssetDir,
          endpointId: "alibaba/qwen-image-3/edit",
          input: falInput,
          taskType: "fal_qwen3_image_edit",
          meta: {
            sourceImageIds,
            prompt: normalizedPrompt,
            kiePlaygroundFallback: true,
            ...(outputFormat !== undefined ? { outputFormat } : {}),
            ...(seed !== undefined ? { seed } : {}),
          },
          expectedOwnerId: ownerId,
        });
        return { taskId, result: { success: true, taskId } };
      }
    });
  });
}
