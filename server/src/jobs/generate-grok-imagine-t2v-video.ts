import type { VideocityFs } from "videocity-engine";
import { submitKieTask } from "./kie-paygate.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildGrokImagineT2vVideoPayload } from "../payload-builders.js";

type GenerateGrokImagineT2vVideoPayload = {
  type: "generate_grok_imagine_t2v_video";
  vidAssetId: string;
  vidAssetDir: string;
  projectSlug: string;
  prompt: string;
  mode?: "fun" | "normal" | "spicy";
  duration?: number;
  resolution?: "480p" | "720p";
  aspect_ratio?: "16:9" | "9:16" | "1:1" | "2:3" | "3:2";
  nsfw_checker?: boolean;
};

export function registerGenerateGrokImagineT2vVideoJob(fs: VideocityFs): void {
  registerJobHandler("generate_grok_imagine_t2v_video", async (payload, ctx) => {
    const {
      vidAssetId, vidAssetDir, projectSlug, prompt,
      mode, duration, resolution, aspect_ratio, nsfw_checker,
    } = payload as GenerateGrokImagineT2vVideoPayload;

    requireApiKey("KIE_API_KEY");

    const request = buildGrokImagineT2vVideoPayload({
      prompt, mode, duration, resolution, aspect_ratio, nsfw_checker,
    });
    const taskId = await submitKieTask(fs, ctx, {
      request,
      taskType: "grok_imagine_t2v_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      projectSlug,
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
