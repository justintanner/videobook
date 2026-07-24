import type { Engine } from "videobook-engine";
import { registerJobHandler } from "../queue.js";
import { withProviderHandoff } from "./_lease.js";
import { submitFalJob } from "./_fal-shared.js";

type Payload = {
  type: "generate_seedance2_t2v_fal";
  vidAssetId: string;
  vidAssetDir: string;
  projectSlug: string;
  prompt: string;
  resolution?: string;
  duration?: string;
  aspect_ratio?: string;
  generate_audio?: boolean;
  seed?: number;
};

export function registerGenerateSeedance2T2vFalJob(fs: Engine): void {
  registerJobHandler("generate_seedance2_t2v_fal", async (payload, ctx) => {
    const p = payload as Payload;
    return withProviderHandoff(fs, p.projectSlug, p.vidAssetId, ctx, "generate", async (ownerId) => {
  
      const input: Record<string, unknown> = {
        prompt: p.prompt,
        ...(p.resolution !== undefined ? { resolution: p.resolution } : {}),
        ...(p.duration !== undefined ? { duration: p.duration } : {}),
        ...(p.aspect_ratio !== undefined ? { aspect_ratio: p.aspect_ratio } : {}),
        ...(p.generate_audio !== undefined ? { generate_audio: p.generate_audio } : {}),
        ...(p.seed !== undefined ? { seed: p.seed } : {}),
      };
  
      const taskId = await submitFalJob({
        fs,
        projectSlug: p.projectSlug,
        assetId: p.vidAssetId,
        assetDir: p.vidAssetDir,
        endpointId: "bytedance/seedance-2.0/text-to-video",
        input,
        taskType: "fal_seedance2_t2v",
        meta: { prompt: p.prompt, mode: "t2v", sourceImageIds: [], return_last_frame: false },
        expectedOwnerId: ownerId,
      });
  
      return { taskId, result: { success: true, taskId } };    });
  });
}
