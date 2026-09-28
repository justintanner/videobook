import type { Engine } from "videobook-engine";
import type { Qwen21TextToImageRequest } from "@apicity/kie";
import { requireApiKey } from "../api-key.js";
import { buildQwen21TextToImagePayload } from "../payload-builders.js";
import { registerJobHandler } from "../queue.js";
import { submitKieTask } from "./kie-paygate.js";

type GenerateQwen21TextImagePayload = {
  type: "generate_qwen21_text_image";
  prompt: string;
  imgAssetId: string;
  imgAssetDir: string;
  bookId: string;
  aspectRatio?: Qwen21TextToImageRequest["input"]["aspect_ratio"];
  background?: Qwen21TextToImageRequest["input"]["background"];
  outputFormat?: Qwen21TextToImageRequest["input"]["output_format"];
  resolution?: Qwen21TextToImageRequest["input"]["resolution"];
  enhancePrompt?: boolean;
  nsfwChecker?: boolean;
  seed?: number;
};

export function registerGenerateQwen21TextImageJob(engine: Engine): void {
  registerJobHandler("generate_qwen21_text_image", async (payload, ctx) => {
    const {
      prompt,
      imgAssetId,
      imgAssetDir,
      bookId,
      aspectRatio,
      background,
      outputFormat,
      resolution,
      enhancePrompt,
      nsfwChecker,
      seed,
    } = payload as GenerateQwen21TextImagePayload;

    requireApiKey("KIE_API_KEY");

    const request = buildQwen21TextToImagePayload({
      prompt,
      ...(aspectRatio !== undefined ? { aspect_ratio: aspectRatio } : {}),
      ...(background !== undefined ? { background } : {}),
      ...(outputFormat !== undefined ? { output_format: outputFormat } : {}),
      ...(resolution !== undefined ? { resolution } : {}),
      ...(enhancePrompt !== undefined ? { enhance_prompt: enhancePrompt } : {}),
      ...(nsfwChecker !== undefined ? { nsfw_checker: nsfwChecker } : {}),
      ...(seed !== undefined ? { seed } : {}),
    });
    const taskId = await submitKieTask(engine, ctx, {
      request,
      taskType: "qwen21_text_image",
      assetId: imgAssetId,
      assetDir: imgAssetDir,
      bookId,
      meta: {
        sourceImageIds: [],
        prompt,
        ...(aspectRatio !== undefined ? { aspectRatio } : {}),
        ...(outputFormat !== undefined ? { outputFormat } : {}),
        ...(seed !== undefined ? { seed } : {}),
      },
    });

    return { success: true, taskId };
  });
}
