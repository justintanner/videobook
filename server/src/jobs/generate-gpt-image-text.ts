import type { VideocityFs } from "videobook-engine";
import { submitKieTask } from "./kie-paygate.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildGptImageTextPayload } from "../payload-builders.js";
import type { GptImage2TextToImageRequest } from "@apicity/kie";

type GenerateGptImageTextPayload = {
  type: "generate_gpt_image_text";
  prompt: string;
  imgAssetId: string;
  imgAssetDir: string;
  projectSlug: string;
  aspectRatio?: GptImage2TextToImageRequest["input"]["aspect_ratio"];
  resolution?: GptImage2TextToImageRequest["input"]["resolution"];
  nsfwChecker?: boolean;
};

export function registerGenerateGptImageTextJob(fs: VideocityFs): void {
  registerJobHandler("generate_gpt_image_text", async (payload, ctx) => {
    const {
      prompt, imgAssetId, imgAssetDir, projectSlug, aspectRatio, resolution, nsfwChecker,
    } = payload as GenerateGptImageTextPayload;

    requireApiKey("KIE_API_KEY");

    const request = buildGptImageTextPayload({
      prompt,
      aspect_ratio: aspectRatio,
      resolution,
      nsfw_checker: nsfwChecker,
    });
    const taskId = await submitKieTask(fs, ctx, {
      request,
      taskType: "gpt_image_text",
      assetId: imgAssetId,
      assetDir: imgAssetDir,
      projectSlug,
      meta: {
        sourceImageIds: [],
        prompt,
        ...(aspectRatio !== undefined ? { aspectRatio } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        ...(nsfwChecker !== undefined ? { nsfwChecker } : {}),
      },
    });

    return { success: true, taskId };
  });
}
