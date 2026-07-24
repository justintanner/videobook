import type { Engine } from "videobook-engine";
import type { HappyHorse11AspectRatio, HappyHorseResolution } from "@apicity/kie";
import { submitKieTask } from "./kie-paygate.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildHappyHorseT2vPayload } from "../payload-builders.js";

type GenerateHappyhorseT2vVideoPayload = {
  type: "generate_happyhorse_t2v_video";
  vidAssetId: string;
  vidAssetDir: string;
  bookId: string;
  prompt: string;
  resolution?: HappyHorseResolution;
  aspect_ratio?: HappyHorse11AspectRatio;
  duration?: string;
};

export function registerGenerateHappyhorseT2vVideoJob(fs: Engine): void {
  registerJobHandler("generate_happyhorse_t2v_video", async (payload, ctx) => {
    const { vidAssetId, vidAssetDir, bookId, prompt, resolution, aspect_ratio, duration } = payload as GenerateHappyhorseT2vVideoPayload;

    requireApiKey("KIE_API_KEY");

    const request = buildHappyHorseT2vPayload({ prompt, resolution, aspect_ratio, duration });
    const taskId = await submitKieTask(fs, ctx, {
      request,
      taskType: "happyhorse_t2v_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      bookId,
      meta: { prompt, mode: "t2v" },
    });

    return { success: true, taskId };
  });
}
