import type { VideocityFs } from "vc-engine";
import { submitKieTask } from "./kie-paygate.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildSeedreamTextImagePayload } from "../payload-builders.js";

type GenerateSeedreamTextImagePayload = {
  type: "generate_seedream_text_image";
  prompt: string;
  imgAssetId: string;
  imgAssetDir: string;
  projectSlug: string;
  aspectRatio?: "1:1" | "4:3" | "3:4" | "16:9" | "9:16" | "2:3" | "3:2" | "21:9";
  quality?: "basic" | "high";
  nsfwChecker?: boolean;
};

export function registerGenerateSeedreamTextImageJob(fs: VideocityFs): void {
  registerJobHandler("generate_seedream_text_image", async (payload, ctx) => {
    const {
      prompt, imgAssetId, imgAssetDir, projectSlug,
      aspectRatio, quality, nsfwChecker,
    } = payload as GenerateSeedreamTextImagePayload;

    requireApiKey("KIE_API_KEY");

    const request = buildSeedreamTextImagePayload({
      prompt,
      ...(aspectRatio !== undefined ? { aspect_ratio: aspectRatio } : {}),
      ...(quality !== undefined ? { quality } : {}),
      ...(nsfwChecker !== undefined ? { nsfw_checker: nsfwChecker } : {}),
    });
    const taskId = await submitKieTask(fs, ctx, {
      request,
      taskType: "seedream_text_image",
      assetId: imgAssetId,
      assetDir: imgAssetDir,
      projectSlug,
      meta: {
        sourceImageIds: [],
        prompt,
        ...(aspectRatio !== undefined ? { aspectRatio } : {}),
        ...(quality !== undefined ? { quality } : {}),
        ...(nsfwChecker !== undefined ? { nsfwChecker } : {}),
      },
    });

    return { success: true, taskId };
  });
}
