import type { ClipfirstFs } from "vc-engine";
import { registerJobHandler } from "../queue.js";
import { withProviderHandoff } from "./_lease.js";
import { uploadAssetToFal } from "./_fal-upload.js";
import { submitFalJob } from "./_fal-shared.js";

type RefInput = { assetId: string; filename: string };

type Payload = {
  type: "generate_wan27_r2v_fal";
  vidAssetId: string;
  vidAssetDir: string;
  projectSlug: string;
  prompt: string;
  imageInputs: RefInput[];
  videoInputs: RefInput[];
  sourceImageIds: string[];
  sourceVideoIds: string[];
  aspect_ratio?: string;
  resolution?: string;
  duration?: number;
  multi_shots?: boolean;
  negative_prompt?: string;
  enable_safety_checker?: boolean;
  seed?: number;
};

export function registerGenerateWan27R2vFalJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_wan27_r2v_fal", async (payload, ctx) => {
    const p = payload as Payload;
    return withProviderHandoff(fs, p.projectSlug, p.vidAssetId, ctx, "generate", async (ownerId) => {
  
      const reference_image_urls: string[] = [];
      for (const img of p.imageInputs) {
        reference_image_urls.push(await uploadAssetToFal(fs, img.assetId, img.filename, p.projectSlug));
      }
      const reference_video_urls: string[] = [];
      for (const vid of p.videoInputs) {
        reference_video_urls.push(await uploadAssetToFal(fs, vid.assetId, vid.filename, p.projectSlug));
      }
  
      const input: Record<string, unknown> = {
        prompt: p.prompt,
        ...(reference_image_urls.length > 0 ? { reference_image_urls } : {}),
        ...(reference_video_urls.length > 0 ? { reference_video_urls } : {}),
        ...(p.aspect_ratio !== undefined ? { aspect_ratio: p.aspect_ratio } : {}),
        ...(p.resolution !== undefined ? { resolution: p.resolution } : {}),
        ...(p.duration !== undefined ? { duration: p.duration } : {}),
        ...(p.multi_shots !== undefined ? { multi_shots: p.multi_shots } : {}),
        ...(p.negative_prompt !== undefined ? { negative_prompt: p.negative_prompt } : {}),
        ...(p.enable_safety_checker !== undefined ? { enable_safety_checker: p.enable_safety_checker } : {}),
        ...(p.seed !== undefined ? { seed: p.seed } : {}),
      };
  
      const taskId = await submitFalJob({
        fs,
        projectSlug: p.projectSlug,
        assetId: p.vidAssetId,
        assetDir: p.vidAssetDir,
        endpointId: "fal-ai/wan/v2.7/reference-to-video",
        input,
        taskType: "fal_wan27_r2v",
        meta: {
          prompt: p.prompt,
          mode: "reference",
          sourceImageIds: p.sourceImageIds,
          sourceVideoIds: p.sourceVideoIds,
        },
        expectedOwnerId: ownerId,
      });
  
      return { taskId, result: { success: true, taskId } };    });
  });
}
