import type { Engine } from "videobook-engine";
import type { MiniMaxH3FixedAspectRatio, MiniMaxH3Resolution } from "@apicity/kie";
import { submitKieTask } from "./kie-paygate.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildMiniMaxH3T2vPayload } from "../payload-builders.js";

type GenerateMiniMaxH3T2vVideoPayload = {
  type: "generate_minimax_h3_t2v_video";
  vidAssetId: string;
  vidAssetDir: string;
  bookId: string;
  prompt: string;
  aspect_ratio: MiniMaxH3FixedAspectRatio;
  duration: string;
  resolution?: MiniMaxH3Resolution;
};

export function registerGenerateMiniMaxH3T2vVideoJob(engine: Engine): void {
  registerJobHandler("generate_minimax_h3_t2v_video", async (payload, ctx) => {
    const { vidAssetId, vidAssetDir, bookId, prompt, aspect_ratio, duration, resolution } = payload as GenerateMiniMaxH3T2vVideoPayload;

    requireApiKey("KIE_API_KEY");

    const request = buildMiniMaxH3T2vPayload({ prompt, aspect_ratio, duration, resolution });
    const taskId = await submitKieTask(engine, ctx, {
      request,
      taskType: "minimax_h3_t2v_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      bookId,
      meta: { prompt, mode: "t2v" },
    });

    return { success: true, taskId };
  });
}
