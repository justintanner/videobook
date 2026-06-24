import type { VideocityFs } from "videocity-engine";
import type { HappyHorseResolution } from "@apicity/kie";
import { submitKieTask } from "./kie-paygate.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildHappyHorseI2vPayload } from "../payload-builders.js";

type RefInput = { assetId: string; filename: string };

type GenerateHappyhorseI2vVideoPayload = {
  type: "generate_happyhorse_i2v_video";
  vidAssetId: string;
  vidAssetDir: string;
  projectSlug: string;
  firstFrame: RefInput;
  sourceImageIds: string[];
  prompt?: string;
  resolution?: HappyHorseResolution;
  duration?: string;
};

export function registerGenerateHappyhorseI2vVideoJob(fs: VideocityFs): void {
  registerJobHandler("generate_happyhorse_i2v_video", async (payload, ctx) => {
    const {
      vidAssetId, vidAssetDir, projectSlug,
      firstFrame, sourceImageIds,
      prompt, resolution, duration,
    } = payload as GenerateHappyhorseI2vVideoPayload;

    requireApiKey("KIE_API_KEY");

    const imageUrl = await uploadAssetToKie(fs, firstFrame.assetId, firstFrame.filename, projectSlug);

    const request = buildHappyHorseI2vPayload({ prompt, resolution, duration }, imageUrl);
    const taskId = await submitKieTask(fs, ctx, {
      request,
      taskType: "happyhorse_i2v_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      projectSlug,
      meta: { mode: "i2v", sourceImageIds, ...(prompt !== undefined ? { prompt } : {}) },
    });

    return { success: true, taskId };
  });
}
