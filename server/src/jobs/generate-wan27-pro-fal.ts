import type { VideocityFs } from "videobook-engine";
import { registerJobHandler } from "../queue.js";
import { withProviderHandoff } from "./_lease.js";
import { submitFalJob } from "./_fal-shared.js";

type Payload = {
  type: "generate_wan27_pro_fal";
  imgAssetId: string;
  imgAssetDir: string;
  projectSlug: string;
  prompt: string;
  negative_prompt?: string;
  image_size?: string;
  max_images?: number;
  seed?: number;
};

export function registerGenerateWan27ProFalJob(fs: VideocityFs): void {
  registerJobHandler("generate_wan27_pro_fal", async (payload, ctx) => {
    const p = payload as Payload;
    return withProviderHandoff(fs, p.projectSlug, p.imgAssetId, ctx, "generate", async (ownerId) => {
  
      const input: Record<string, unknown> = {
        prompt: p.prompt,
        ...(p.negative_prompt !== undefined ? { negative_prompt: p.negative_prompt } : {}),
        ...(p.image_size !== undefined ? { image_size: p.image_size } : {}),
        ...(p.max_images !== undefined ? { max_images: p.max_images } : {}),
        ...(p.seed !== undefined ? { seed: p.seed } : {}),
      };
  
      const taskId = await submitFalJob({
        fs,
        projectSlug: p.projectSlug,
        assetId: p.imgAssetId,
        assetDir: p.imgAssetDir,
        endpointId: "fal-ai/wan/v2.7/pro/text-to-image",
        input,
        taskType: "fal_wan27_pro",
        meta: {
          prompt: p.prompt,
          sourceImageIds: [],
          ...(p.image_size !== undefined ? { imageSize: p.image_size } : {}),
          ...(p.seed !== undefined ? { seed: p.seed } : {}),
        },
        expectedOwnerId: ownerId,
      });
  
      return { taskId, result: { success: true, taskId } };    });
  });
}
