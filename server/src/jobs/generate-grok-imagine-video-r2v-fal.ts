import type { ClipfirstFs } from "vc-engine";
import { registerJobHandler } from "../queue.js";
import { withProviderHandoff } from "./_lease.js";
import { uploadAssetToFal } from "./_fal-upload.js";
import { submitFalJob } from "./_fal-shared.js";

type RefInput = { assetId: string; filename: string };

type Payload = {
  type: "generate_grok_imagine_video_r2v_fal";
  vidAssetId: string;
  vidAssetDir: string;
  projectSlug: string;
  prompt: string;
  imageInputs: RefInput[];
  sourceImageIds: string[];
  duration?: number;
  aspect_ratio?: string;
  resolution?: string;
};

export function registerGenerateGrokImagineVideoR2vFalJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_grok_imagine_video_r2v_fal", async (payload, ctx) => {
    const p = payload as Payload;
    return withProviderHandoff(fs, p.projectSlug, p.vidAssetId, ctx, "generate", async (ownerId) => {
  
      const reference_image_urls: string[] = [];
      for (const img of p.imageInputs) {
        reference_image_urls.push(await uploadAssetToFal(fs, img.assetId, img.filename, p.projectSlug));
      }
  
      const input: Record<string, unknown> = {
        prompt: p.prompt,
        reference_image_urls,
        ...(p.duration !== undefined ? { duration: p.duration } : {}),
        ...(p.aspect_ratio !== undefined ? { aspect_ratio: p.aspect_ratio } : {}),
        ...(p.resolution !== undefined ? { resolution: p.resolution } : {}),
      };
  
      const taskId = await submitFalJob({
        fs,
        projectSlug: p.projectSlug,
        assetId: p.vidAssetId,
        assetDir: p.vidAssetDir,
        endpointId: "xai/grok-imagine-video/reference-to-video",
        input,
        taskType: "fal_grok_imagine_video_r2v",
        meta: { prompt: p.prompt, mode: "reference", sourceImageIds: p.sourceImageIds },
        expectedOwnerId: ownerId,
      });
  
      return { taskId, result: { success: true, taskId } };    });
  });
}
