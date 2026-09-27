import type { Engine } from "videobook-engine";
import { requireApiKey } from "../api-key.js";
import { buildGptImage25Payload, GPT_IMAGE_2_5_MODELS } from "../gpt-image-2-5.js";
import type { GptImage25Input, GptImage25Variant } from "../gpt-image-2-5.js";
import { transformProviderPrompt } from "../provider-prompt-transform.js";
import { registerJobHandler } from "../queue.js";
import type { ImageInput } from "../tools/_image-inputs.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import { submitKieTask } from "./kie-paygate.js";

type GenerateGptImage25Payload = {
  variant: GptImage25Variant;
  input: GptImage25Input;
  imageInputs: ImageInput[];
  sourceImageIds: string[];
  imgAssetId: string;
  imgAssetDir: string;
  bookId: string;
};

export function registerGenerateGptImage25Job(engine: Engine): void {
  registerJobHandler("generate_gpt_image_2_5", async (payload, ctx) => {
    const { variant, input, imageInputs, sourceImageIds, imgAssetId, imgAssetDir, bookId } = payload as GenerateGptImage25Payload;
    requireApiKey("KIE_API_KEY");
    const imageUrls: string[] = [];
    for (const image of imageInputs) {
      imageUrls.push("url" in image ? image.url : await uploadAssetToKie(engine, image.assetId, image.filename));
    }
    const prompt = transformProviderPrompt(GPT_IMAGE_2_5_MODELS[variant].tool, {
      prompt: input.prompt,
      image_refs: imageInputs.map((image) => "url" in image ? image.url : image.assetId),
    }) ?? input.prompt;
    const request = buildGptImage25Payload(variant, { ...input, prompt }, imageUrls);
    const taskId = await submitKieTask(engine, ctx, {
      request,
      taskType: imageUrls.length > 0 ? "gpt_image" : "gpt_image_text",
      assetId: imgAssetId,
      assetDir: imgAssetDir,
      bookId,
      meta: {
        model: request.model,
        sourceImageIds,
        prompt: input.prompt,
        aspectRatio: request.input.aspect_ratio,
        resolution: request.input.resolution,
        ...(request.input.background !== undefined ? { background: request.input.background } : {}),
      },
    });
    return { success: true, taskId };
  });
}
