import type { Engine } from "videobook-engine";
import type { HappyHorseResolution } from "@apicity/kie";
import { submitKieTask } from "./kie-paygate.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildHappyHorseI2vPayload } from "../payload-builders.js";
import { transformProviderPrompt } from "../provider-prompt-transform.js";

type RefInput = { assetId: string; filename: string };

type GenerateHappyhorseI2vVideoPayload = {
  type: "generate_happyhorse_i2v_video";
  vidAssetId: string;
  vidAssetDir: string;
  bookId: string;
  firstFrame: RefInput;
  sourceImageIds: string[];
  prompt?: string;
  resolution?: HappyHorseResolution;
  duration?: string;
};

export function registerGenerateHappyhorseI2vVideoJob(fs: Engine): void {
  registerJobHandler("generate_happyhorse_i2v_video", async (payload, ctx) => {
    const {
      vidAssetId, vidAssetDir, bookId,
      firstFrame, sourceImageIds,
      prompt, resolution, duration,
    } = payload as GenerateHappyhorseI2vVideoPayload;

    requireApiKey("KIE_API_KEY");

    const imageUrl = await uploadAssetToKie(fs, firstFrame.assetId, firstFrame.filename, bookId);

    // First frame rides image_urls; strip confirmed @img-* from free-form prompt.
    const normalizedPrompt = prompt === undefined
      ? undefined
      : transformProviderPrompt("generate_kie_happyhorse_1_1_image_to_video", {
        prompt,
        first_frame_slug: firstFrame.assetId,
      });
    const request = buildHappyHorseI2vPayload(
      { prompt: normalizedPrompt, resolution, duration },
      imageUrl,
    );
    const taskId = await submitKieTask(fs, ctx, {
      request,
      taskType: "happyhorse_i2v_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      bookId,
      meta: { mode: "i2v", sourceImageIds, ...(prompt !== undefined ? { prompt } : {}) },
    });

    return { success: true, taskId };
  });
}
