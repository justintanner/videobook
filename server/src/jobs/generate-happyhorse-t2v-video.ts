import type { VideocityFs } from "videocity-engine";
import { submitKieTask } from "./kie-paygate.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildHappyHorseT2vPayload } from "../payload-builders.js";

type GenerateHappyhorseT2vVideoPayload = {
  type: "generate_happyhorse_t2v_video";
  vidAssetId: string;
  vidAssetDir: string;
  projectSlug: string;
  prompt: string;
  resolution?: "720p" | "1080p";
  aspect_ratio?: "16:9" | "9:16" | "1:1" | "4:3" | "3:4";
  duration?: string;
  seed?: number;
};

export function registerGenerateHappyhorseT2vVideoJob(fs: VideocityFs): void {
  registerJobHandler("generate_happyhorse_t2v_video", async (payload, ctx) => {
    const { vidAssetId, vidAssetDir, projectSlug, prompt, resolution, aspect_ratio, duration, seed } = payload as GenerateHappyhorseT2vVideoPayload;

    requireApiKey("KIE_API_KEY");

    const request = buildHappyHorseT2vPayload({ prompt, resolution, aspect_ratio, duration, seed });
    const taskId = await submitKieTask(fs, ctx, {
      request,
      taskType: "happyhorse_t2v_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      projectSlug,
      meta: { prompt, mode: "t2v" },
    });

    return { success: true, taskId };
  });
}
