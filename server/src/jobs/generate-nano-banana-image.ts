import type { VideocityFs } from "vc-engine";
import { submitKieTask } from "./kie-paygate.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildNanoBananaImagePayload } from "../payload-builders.js";
import type { ImageInput } from "../tools/_image-inputs.js";

type GenerateNanoBananaImagePayload = {
  type: "generate_nano_banana_image";
  prompt: string;
  imageInputs: ImageInput[];
  imgAssetId: string;
  imgAssetDir: string;
  sourceImageIds: string[];
  projectSlug: string;
  aspectRatio?: string;
  resolution?: string;
  outputFormat?: string;
};

export function registerGenerateNanoBananaImageJob(fs: VideocityFs): void {
  registerJobHandler("generate_nano_banana_image", async (payload, ctx) => {
    const {
      prompt, imageInputs, imgAssetId, imgAssetDir,
      sourceImageIds, projectSlug, aspectRatio, resolution, outputFormat,
    } = payload as GenerateNanoBananaImagePayload;

    requireApiKey("KIE_API_KEY");

    const uploadedUrls: string[] = [];
    for (const input of imageInputs) {
      uploadedUrls.push(
        "url" in input
          ? input.url
          : await uploadAssetToKie(fs, input.assetId, input.filename, projectSlug),
      );
    }

    const request = buildNanoBananaImagePayload(
      { prompt, aspect_ratio: aspectRatio, resolution, output_format: outputFormat },
      uploadedUrls,
    );
    const taskId = await submitKieTask(fs, ctx, {
      request,
      taskType: "nano_banana_image",
      assetId: imgAssetId,
      assetDir: imgAssetDir,
      projectSlug,
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
