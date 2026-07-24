import type { Engine } from "videobook-engine";
import { registerJobHandler } from "../queue.js";
import { withProviderHandoff } from "./_lease.js";
import { submitFalJob } from "./_fal-shared.js";

type Payload = {
  type: "generate_wan27_t2v_fal";
  vidAssetId: string;
  vidAssetDir: string;
  projectSlug: string;
  prompt: string;
  aspect_ratio?: string;
  resolution?: string;
  duration?: number;
  negative_prompt?: string;
  enable_prompt_expansion?: boolean;
  enable_safety_checker?: boolean;
  seed?: number;
};

export function registerGenerateWan27T2vFalJob(fs: Engine): void {
  registerJobHandler("generate_wan27_t2v_fal", async (payload, ctx) => {
    const p = payload as Payload;
    return withProviderHandoff(fs, p.projectSlug, p.vidAssetId, ctx, "generate", async (ownerId) => {
  
      const input: Record<string, unknown> = {
        prompt: p.prompt,
        ...(p.aspect_ratio !== undefined ? { aspect_ratio: p.aspect_ratio } : {}),
        ...(p.resolution !== undefined ? { resolution: p.resolution } : {}),
        ...(p.duration !== undefined ? { duration: p.duration } : {}),
        ...(p.negative_prompt !== undefined ? { negative_prompt: p.negative_prompt } : {}),
        ...(p.enable_prompt_expansion !== undefined ? { enable_prompt_expansion: p.enable_prompt_expansion } : {}),
        ...(p.enable_safety_checker !== undefined ? { enable_safety_checker: p.enable_safety_checker } : {}),
        ...(p.seed !== undefined ? { seed: p.seed } : {}),
      };
  
      const taskId = await submitFalJob({
        fs,
        projectSlug: p.projectSlug,
        assetId: p.vidAssetId,
        assetDir: p.vidAssetDir,
        endpointId: "fal-ai/wan/v2.7/text-to-video",
        input,
        taskType: "fal_wan27_t2v",
        meta: { prompt: p.prompt, mode: "t2v", sourceImageIds: [], return_last_frame: false },
        expectedOwnerId: ownerId,
      });
  
      return { taskId, result: { success: true, taskId } };    });
  });
}
