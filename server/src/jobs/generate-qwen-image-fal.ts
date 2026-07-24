import type { Engine } from "videobook-engine";
import { registerJobHandler } from "../queue.js";
import { withProviderHandoff } from "./_lease.js";
import { submitFalJob } from "./_fal-shared.js";

type Payload = {
  type: "generate_qwen_image_fal";
  imgAssetId: string;
  imgAssetDir: string;
  bookId: string;
  prompt: string;
  image_size?: string;
  num_inference_steps?: number;
  guidance_scale?: number;
  num_images?: number;
  output_format?: string;
  negative_prompt?: string;
  acceleration?: string;
  enable_safety_checker?: boolean;
  use_turbo?: boolean;
  seed?: number;
};

export function registerGenerateQwenImageFalJob(fs: Engine): void {
  registerJobHandler("generate_qwen_image_fal", async (payload, ctx) => {
    const p = payload as Payload;
    return withProviderHandoff(fs, p.bookId, p.imgAssetId, ctx, "generate", async (ownerId) => {
  
      const input: Record<string, unknown> = {
        prompt: p.prompt,
        ...(p.image_size !== undefined ? { image_size: p.image_size } : {}),
        ...(p.num_inference_steps !== undefined ? { num_inference_steps: p.num_inference_steps } : {}),
        ...(p.guidance_scale !== undefined ? { guidance_scale: p.guidance_scale } : {}),
        ...(p.num_images !== undefined ? { num_images: p.num_images } : {}),
        ...(p.output_format !== undefined ? { output_format: p.output_format } : {}),
        ...(p.negative_prompt !== undefined ? { negative_prompt: p.negative_prompt } : {}),
        ...(p.acceleration !== undefined ? { acceleration: p.acceleration } : {}),
        ...(p.enable_safety_checker !== undefined ? { enable_safety_checker: p.enable_safety_checker } : {}),
        ...(p.use_turbo !== undefined ? { use_turbo: p.use_turbo } : {}),
        ...(p.seed !== undefined ? { seed: p.seed } : {}),
      };
  
      const taskId = await submitFalJob({
        fs,
        bookId: p.bookId,
        assetId: p.imgAssetId,
        assetDir: p.imgAssetDir,
        endpointId: "fal-ai/qwen-image",
        input,
        taskType: "fal_qwen_image",
        meta: { prompt: p.prompt, sourceImageIds: [] },
        expectedOwnerId: ownerId,
      });
  
      return { taskId, result: { success: true, taskId } };    });
  });
}
