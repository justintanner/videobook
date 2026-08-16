import type { Engine } from "videobook-engine";
import { submitKieTask } from "./kie-paygate.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildQwen2ImageEditPayload } from "../payload-builders.js";
import type { ImageInput } from "../tools/_image-inputs.js";
import type { Qwen2ImageEditRequest } from "@apicity/kie";
import { transformProviderPrompt } from "../provider-prompt-transform.js";

type GenerateQwen2ImageEditPayload = {
  type: "generate_qwen2_image_edit";
  prompt: string;
  imageInputs: ImageInput[];
  imgAssetId: string;
  imgAssetDir: string;
  sourceImageIds: string[];
  bookId: string;
  imageSize?: Qwen2ImageEditRequest["input"]["image_size"];
  outputFormat?: Qwen2ImageEditRequest["input"]["output_format"];
  seed?: number;
};

export function registerGenerateQwen2ImageEditJob(fs: Engine): void {
  registerJobHandler("generate_qwen2_image_edit", async (payload, ctx) => {
    const {
      prompt, imageInputs, imgAssetId, imgAssetDir,
      sourceImageIds, bookId, imageSize, outputFormat, seed,
    } = payload as GenerateQwen2ImageEditPayload;

    requireApiKey("KIE_API_KEY");

    const input = imageInputs[0];
    if (!input) throw new Error("generate_qwen2_image_edit requires exactly one reference image");
    const imageUrl =
      "url" in input
        ? input.url
        : await uploadAssetToKie(fs, input.assetId, input.filename);
    const normalizedPrompt = transformProviderPrompt(
      "generate_kie_qwen_2_0_edit_image",
      {
        prompt,
        image_refs: "assetId" in input ? [input.assetId] : [],
      },
    ) ?? "";

    const request = buildQwen2ImageEditPayload(
      { prompt: normalizedPrompt, image_size: imageSize, output_format: outputFormat, seed },
      imageUrl,
    );
    const taskId = await submitKieTask(fs, ctx, {
      request,
      taskType: "qwen2_image_edit",
      assetId: imgAssetId,
      assetDir: imgAssetDir,
      bookId,
      meta: {
        sourceImageIds,
        prompt,
        ...(imageSize !== undefined ? { imageSize } : {}),
        ...(outputFormat !== undefined ? { outputFormat } : {}),
        ...(seed !== undefined ? { seed } : {}),
      },
    });

    return { success: true, taskId };
  });
}
