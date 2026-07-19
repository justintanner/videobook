import type { VideocityFs } from "videocity-engine";
import { submitKieTask } from "./kie-paygate.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildWan27ImageProPayload } from "../payload-builders.js";
import type { ImageInput } from "../tools/_image-inputs.js";
import type { Wan27ImageProRequest } from "@apicity/kie";

type GenerateWan27ImageProPayload = {
  type: "generate_wan27_image_pro";
  prompt: string;
  imageInputs: ImageInput[];
  imgAssetId: string;
  imgAssetDir: string;
  sourceImageIds: string[];
  projectSlug: string;
  aspectRatio?: Wan27ImageProRequest["input"]["aspect_ratio"];
  resolution?: Wan27ImageProRequest["input"]["resolution"];
  seed?: number;
  nsfwChecker?: boolean;
};

export function registerGenerateWan27ImageProJob(fs: VideocityFs): void {
  registerJobHandler("generate_wan27_image_pro", async (payload, ctx) => {
    const {
      prompt, imageInputs, imgAssetId, imgAssetDir,
      sourceImageIds, projectSlug, aspectRatio, resolution, seed, nsfwChecker,
    } = payload as GenerateWan27ImageProPayload;

    requireApiKey("KIE_API_KEY");

    const uploadedUrls: string[] = [];
    for (const input of imageInputs) {
      uploadedUrls.push(
        "url" in input
          ? input.url
          : await uploadAssetToKie(fs, input.assetId, input.filename, projectSlug),
      );
    }

    const request = buildWan27ImageProPayload(
      { prompt, aspect_ratio: aspectRatio, resolution, seed, nsfw_checker: nsfwChecker },
      uploadedUrls,
    );
    const taskId = await submitKieTask(fs, ctx, {
      request,
      taskType: "wan27_image_pro",
      assetId: imgAssetId,
      assetDir: imgAssetDir,
      projectSlug,
      meta: {
        sourceImageIds,
        prompt,
        ...(aspectRatio !== undefined ? { aspectRatio } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        ...(seed !== undefined ? { seed } : {}),
        ...(nsfwChecker !== undefined ? { nsfwChecker } : {}),
      },
    });

    return { success: true, taskId };
  });
}
