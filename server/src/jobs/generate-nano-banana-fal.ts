import type { VideocityFs } from "vc-engine";
import { registerJobHandler } from "../queue.js";
import { withProviderHandoff } from "./_lease.js";
import { submitFalJob } from "./_fal-shared.js";

type Payload = {
  type: "generate_nano_banana_fal";
  imgAssetId: string;
  imgAssetDir: string;
  projectSlug: string;
  prompt: string;
  num_images?: number;
  aspect_ratio?: string;
  output_format?: string;
  safety_tolerance?: string;
  seed?: number;
};

export function registerGenerateNanoBananaFalJob(fs: VideocityFs): void {
  registerJobHandler("generate_nano_banana_fal", async (payload, ctx) => {
    const p = payload as Payload;
    return withProviderHandoff(fs, p.projectSlug, p.imgAssetId, ctx, "generate", async (ownerId) => {
  
      const input: Record<string, unknown> = {
        prompt: p.prompt,
        ...(p.num_images !== undefined ? { num_images: p.num_images } : {}),
        ...(p.aspect_ratio !== undefined ? { aspect_ratio: p.aspect_ratio } : {}),
        ...(p.output_format !== undefined ? { output_format: p.output_format } : {}),
        ...(p.safety_tolerance !== undefined ? { safety_tolerance: p.safety_tolerance } : {}),
        ...(p.seed !== undefined ? { seed: p.seed } : {}),
      };
  
      const taskId = await submitFalJob({
        fs,
        projectSlug: p.projectSlug,
        assetId: p.imgAssetId,
        assetDir: p.imgAssetDir,
        endpointId: "fal-ai/nano-banana",
        input,
        taskType: "fal_nano_banana",
        meta: { prompt: p.prompt, sourceImageIds: [] },
        expectedOwnerId: ownerId,
      });
  
      return { taskId, result: { success: true, taskId } };    });
  });
}
