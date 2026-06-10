import type { VideocityFs } from "videocity-engine";
import { registerJobHandler } from "../queue.js";
import { withProviderHandoff } from "./_lease.js";
import { uploadAssetToFal } from "./_fal-upload.js";
import { submitFalJob } from "./_fal-shared.js";

type ImageInput = { assetId: string; filename: string };

type Payload = {
  type: "generate_nano_banana_edit_fal";
  imgAssetId: string;
  imgAssetDir: string;
  projectSlug: string;
  prompt: string;
  imageInputs: ImageInput[];
  sourceImageIds: string[];
  num_images?: number;
  aspect_ratio?: string;
  output_format?: string;
  safety_tolerance?: string;
  seed?: number;
};

export function registerGenerateNanoBananaEditFalJob(fs: VideocityFs): void {
  registerJobHandler("generate_nano_banana_edit_fal", async (payload, ctx) => {
    const p = payload as Payload;
    return withProviderHandoff(fs, p.projectSlug, p.imgAssetId, ctx, "generate", async (ownerId) => {
  
      const image_urls = await Promise.all(
        p.imageInputs.map((i) => uploadAssetToFal(fs, i.assetId, i.filename, p.projectSlug)),
      );
  
      const input: Record<string, unknown> = {
        prompt: p.prompt,
        image_urls,
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
        endpointId: "fal-ai/nano-banana/edit",
        input,
        taskType: "fal_nano_banana_edit",
        meta: { prompt: p.prompt, sourceImageIds: p.sourceImageIds },
        expectedOwnerId: ownerId,
      });
  
      return { taskId, result: { success: true, taskId } };    });
  });
}
