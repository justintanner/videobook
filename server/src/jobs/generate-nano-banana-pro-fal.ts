import type { Engine } from "videobook-engine";
import { registerJobHandler } from "../queue.js";
import { withProviderHandoff } from "./_lease.js";
import { submitFalJob } from "./_fal-shared.js";

type Payload = {
  type: "generate_nano_banana_pro_fal";
  imgAssetId: string;
  imgAssetDir: string;
  bookId: string;
  prompt: string;
  num_images?: number;
  aspect_ratio?: string;
  resolution?: string;
  output_format?: string;
  seed?: number;
  enable_web_search?: boolean;
};

export function registerGenerateNanoBananaProFalJob(fs: Engine): void {
  registerJobHandler("generate_nano_banana_pro_fal", async (payload, ctx) => {
    const p = payload as Payload;
    return withProviderHandoff(fs, p.bookId, p.imgAssetId, ctx, "generate", async (ownerId) => {
  
      const input: Record<string, unknown> = {
        prompt: p.prompt,
        ...(p.num_images !== undefined ? { num_images: p.num_images } : {}),
        ...(p.aspect_ratio !== undefined ? { aspect_ratio: p.aspect_ratio } : {}),
        ...(p.resolution !== undefined ? { resolution: p.resolution } : {}),
        ...(p.output_format !== undefined ? { output_format: p.output_format } : {}),
        ...(p.seed !== undefined ? { seed: p.seed } : {}),
        ...(p.enable_web_search !== undefined ? { enable_web_search: p.enable_web_search } : {}),
      };
  
      const taskId = await submitFalJob({
        fs,
        bookId: p.bookId,
        assetId: p.imgAssetId,
        assetDir: p.imgAssetDir,
        endpointId: "fal-ai/nano-banana-pro",
        input,
        taskType: "fal_nano_banana_pro",
        meta: {
          prompt: p.prompt,
          sourceImageIds: [],
          ...(p.aspect_ratio !== undefined ? { aspectRatio: p.aspect_ratio } : {}),
          ...(p.resolution !== undefined ? { resolution: p.resolution } : {}),
          ...(p.output_format !== undefined ? { outputFormat: p.output_format } : {}),
        },
        expectedOwnerId: ownerId,
      });
  
      return { taskId, result: { success: true, taskId } };    });
  });
}
