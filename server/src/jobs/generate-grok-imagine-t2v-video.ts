import type { Engine } from "videobook-engine";
import { submitKieTask } from "./kie-paygate.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildGrokImagineT2vVideoPayload } from "../payload-builders.js";
import type { GrokTextToVideoRequest } from "@apicity/kie";

type GenerateGrokImagineT2vVideoPayload = {
  type: "generate_grok_imagine_t2v_video";
  vidAssetId: string;
  vidAssetDir: string;
  bookId: string;
  prompt: string;
  mode?: GrokTextToVideoRequest["input"]["mode"];
  duration?: number;
  resolution?: GrokTextToVideoRequest["input"]["resolution"];
  aspect_ratio?: GrokTextToVideoRequest["input"]["aspect_ratio"];
  nsfw_checker?: boolean;
};

export function registerGenerateGrokImagineT2vVideoJob(engine: Engine): void {
  registerJobHandler("generate_grok_imagine_t2v_video", async (payload, ctx) => {
    const {
      vidAssetId, vidAssetDir, bookId, prompt,
      mode, duration, resolution, aspect_ratio, nsfw_checker,
    } = payload as GenerateGrokImagineT2vVideoPayload;

    requireApiKey("KIE_API_KEY");

    const request = buildGrokImagineT2vVideoPayload({
      prompt, mode, duration, resolution, aspect_ratio, nsfw_checker,
    });
    const taskId = await submitKieTask(engine, ctx, {
      request,
      taskType: "grok_imagine_t2v_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      bookId,
      meta: {
        prompt,
        ...(mode !== undefined ? { mode } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
      },
    });

    return { success: true, taskId };
  });
}
