import type { VideocityFs } from "videobook-engine";
import { registerJobHandler } from "../queue.js";
import { withProviderHandoff } from "./_lease.js";
import { submitFalJob } from "./_fal-shared.js";
import { requireApiKey } from "../api-key.js";

type Payload = {
  type: "generate_nano_banana_2_lite_fal";
  imgAssetId: string;
  imgAssetDir: string;
  projectSlug: string;
  prompt: string;
  num_images?: number;
  aspect_ratio?: string;
  output_format?: string;
  safety_tolerance?: string;
  thinking_level?: string;
  seed?: number;
};

export function registerGenerateNanoBanana2LiteFalJob(fs: VideocityFs): void {
  registerJobHandler("generate_nano_banana_2_lite_fal", async (payload, ctx) => {
    requireApiKey("FAL_API_KEY");
    const p = payload as Payload;
    return withProviderHandoff(fs, p.projectSlug, p.imgAssetId, ctx, "generate", async (ownerId) => {

      const input: Record<string, unknown> = {
        prompt: p.prompt,
        ...(p.num_images !== undefined ? { num_images: p.num_images } : {}),
        ...(p.aspect_ratio !== undefined ? { aspect_ratio: p.aspect_ratio } : {}),
        ...(p.output_format !== undefined ? { output_format: p.output_format } : {}),
        ...(p.safety_tolerance !== undefined ? { safety_tolerance: p.safety_tolerance } : {}),
        ...(p.thinking_level !== undefined ? { thinking_level: p.thinking_level } : {}),
        ...(p.seed !== undefined ? { seed: p.seed } : {}),
      };

      const taskId = await submitFalJob({
        fs,
        projectSlug: p.projectSlug,
        assetId: p.imgAssetId,
        assetDir: p.imgAssetDir,
        endpointId: "google/nano-banana-2-lite",
        input,
        taskType: "fal_nano_banana_2",
        meta: { prompt: p.prompt, sourceImageIds: [], aspectRatio: p.aspect_ratio, outputFormat: p.output_format, apiModel: "nano-banana-2-lite" },
        expectedOwnerId: ownerId,
      });

      return { taskId, result: { success: true, taskId } };
    });
  });
}
