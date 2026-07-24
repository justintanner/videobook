import type { Engine } from "videobook-engine";
import { submitKieTask } from "./kie-paygate.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildSeedreamTextImagePayload } from "../payload-builders.js";
import type { SeedreamTextToImageRequest } from "@apicity/kie";

type GenerateSeedreamTextImagePayload = {
  type: "generate_seedream_text_image";
  prompt: string;
  imgAssetId: string;
  imgAssetDir: string;
  bookId: string;
  aspectRatio?: SeedreamTextToImageRequest["input"]["aspect_ratio"];
  quality?: SeedreamTextToImageRequest["input"]["quality"];
  nsfwChecker?: boolean;
};

export function registerGenerateSeedreamTextImageJob(fs: Engine): void {
  registerJobHandler("generate_seedream_text_image", async (payload, ctx) => {
    const {
      prompt, imgAssetId, imgAssetDir, bookId,
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
      bookId,
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
