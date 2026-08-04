import type { Engine } from "videobook-engine";
import { submitKieTask } from "./kie-paygate.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildNanoBananaImagePayload } from "../payload-builders.js";
import { transformProviderPrompt } from "../provider-prompt-transform.js";
import type { ImageInput } from "../tools/_image-inputs.js";
import type { NanoBananaProRequest } from "@apicity/kie";

type GenerateNanoBananaImagePayload = {
  type: "generate_nano_banana_image";
  prompt: string;
  imageInputs: ImageInput[];
  imgAssetId: string;
  imgAssetDir: string;
  sourceImageIds: string[];
  bookId: string;
  aspectRatio?: NanoBananaProRequest["input"]["aspect_ratio"];
  resolution?: NanoBananaProRequest["input"]["resolution"];
  outputFormat?: NanoBananaProRequest["input"]["output_format"];
};

export function registerGenerateNanoBananaImageJob(fs: Engine): void {
  registerJobHandler("generate_nano_banana_image", async (payload, ctx) => {
    const {
      prompt, imageInputs, imgAssetId, imgAssetDir,
      sourceImageIds, bookId, aspectRatio, resolution, outputFormat,
    } = payload as GenerateNanoBananaImagePayload;

    requireApiKey("KIE_API_KEY");

    const uploadedUrls: string[] = [];
    for (const input of imageInputs) {
      uploadedUrls.push(
        "url" in input
          ? input.url
          : await uploadAssetToKie(fs, input.assetId, input.filename, bookId),
      );
    }

    const normalizedPrompt = transformProviderPrompt(
      "generate_kie_nano_banana_pro_text_to_image",
      {
        prompt,
        image_refs: imageInputs
          .map((input) => ("assetId" in input ? input.assetId : null))
          .filter((id): id is string => id !== null),
      },
    ) ?? "";
    const request = buildNanoBananaImagePayload(
      { prompt: normalizedPrompt, aspect_ratio: aspectRatio, resolution, output_format: outputFormat },
      uploadedUrls,
    );
    const taskId = await submitKieTask(fs, ctx, {
      request,
      taskType: "nano_banana_image",
      assetId: imgAssetId,
      assetDir: imgAssetDir,
      bookId,
      meta: {
        sourceImageIds,
        prompt,
        ...(aspectRatio !== undefined ? { aspectRatio } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        ...(outputFormat !== undefined ? { outputFormat } : {}),
      },
    });

    return { success: true, taskId };
  });
}
