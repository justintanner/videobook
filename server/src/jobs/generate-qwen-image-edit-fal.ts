import type { ClipfirstFs } from "clipfirst-engine";
import { registerJobHandler } from "../queue.js";
import { withProviderHandoff } from "./_lease.js";
import { uploadAssetToFal } from "./_fal-upload.js";
import { submitFalJob } from "./_fal-shared.js";
import type { ImageInput } from "../tools/_image-inputs.js";

type Payload = {
  type: "generate_qwen_image_edit_fal";
  imgAssetId: string;
  imgAssetDir: string;
  projectSlug: string;
  prompt: string;
  refImage: ImageInput;
  sourceImageIds: string[];
  image_size?: string;
  num_inference_steps?: number;
  guidance_scale?: number;
  num_images?: number;
  output_format?: string;
  negative_prompt?: string;
  acceleration?: string;
  enable_safety_checker?: boolean;
  seed?: number;
};

export function registerGenerateQwenImageEditFalJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_qwen_image_edit_fal", async (payload, ctx) => {
    const p = payload as Payload;
    return withProviderHandoff(fs, p.projectSlug, p.imgAssetId, ctx, "generate", async (ownerId) => {
  
      const image_url = "url" in p.refImage
        ? p.refImage.url
        : await uploadAssetToFal(fs, p.refImage.assetId, p.refImage.filename, p.projectSlug);
  
      const input: Record<string, unknown> = {
        prompt: p.prompt,
        image_url,
        ...(p.image_size !== undefined ? { image_size: p.image_size } : {}),
        ...(p.num_inference_steps !== undefined ? { num_inference_steps: p.num_inference_steps } : {}),
        ...(p.guidance_scale !== undefined ? { guidance_scale: p.guidance_scale } : {}),
        ...(p.num_images !== undefined ? { num_images: p.num_images } : {}),
        ...(p.output_format !== undefined ? { output_format: p.output_format } : {}),
        ...(p.negative_prompt !== undefined ? { negative_prompt: p.negative_prompt } : {}),
        ...(p.acceleration !== undefined ? { acceleration: p.acceleration } : {}),
        ...(p.enable_safety_checker !== undefined ? { enable_safety_checker: p.enable_safety_checker } : {}),
        ...(p.seed !== undefined ? { seed: p.seed } : {}),
      };
  
      const taskId = await submitFalJob({
        fs,
        projectSlug: p.projectSlug,
        assetId: p.imgAssetId,
        assetDir: p.imgAssetDir,
        endpointId: "fal-ai/qwen-image/edit",
        input,
        taskType: "fal_qwen_image_edit",
        meta: { prompt: p.prompt, sourceImageIds: p.sourceImageIds },
        expectedOwnerId: ownerId,
      });
  
      return { taskId, result: { success: true, taskId } };    });
  });
}
