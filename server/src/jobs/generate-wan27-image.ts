import type { VideocityFs } from "videobook-engine";
import { submitKieTask } from "./kie-paygate.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildWan27ImagePayload } from "../payload-builders.js";
import type { Wan27ImageRequest } from "@apicity/kie";

type GenerateWan27ImagePayload = {
  type: "generate_wan27_image";
  prompt: string;
  imageInputs: Array<{ assetId: string; filename: string }>;
  imgAssetId: string;
  imgAssetDir: string;
  sourceImageIds: string[];
  projectSlug: string;
  aspectRatio?: Wan27ImageRequest["input"]["aspect_ratio"];
  resolution?: Wan27ImageRequest["input"]["resolution"];
  seed?: number;
  nsfwChecker?: boolean;
};

export function registerGenerateWan27ImageJob(fs: VideocityFs): void {
  registerJobHandler("generate_wan27_image", async (payload, ctx) => {
    const {
      prompt, imageInputs, imgAssetId, imgAssetDir,
      sourceImageIds, projectSlug, aspectRatio, resolution, seed, nsfwChecker,
    } = payload as GenerateWan27ImagePayload;

    requireApiKey("KIE_API_KEY");

    const uploadedUrls: string[] = [];
    for (const { assetId: srcAssetId, filename } of imageInputs) {
      uploadedUrls.push(await uploadAssetToKie(fs, srcAssetId, filename, projectSlug));
    }

    const request = buildWan27ImagePayload(
      { prompt, aspect_ratio: aspectRatio, resolution, seed, nsfw_checker: nsfwChecker },
      uploadedUrls,
    );
    const taskId = await submitKieTask(fs, ctx, {
      request,
      taskType: "wan27_image",
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
