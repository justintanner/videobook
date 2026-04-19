import type { ClipfirstFs } from "clipfirst-fs";
import { registerJobHandler } from "../queue.js";
import { submitFalJob } from "./_fal-shared.js";

type Payload = {
  type: "generate_nano_banana_2_fal";
  imgAssetId: string;
  imgAssetDir: string;
  projectSlug: string;
  prompt: string;
  num_images?: number;
  aspect_ratio?: string;
  resolution?: string;
  output_format?: string;
  safety_tolerance?: string;
  thinking_level?: string;
  enable_web_search?: boolean;
  seed?: number;
};

export function registerGenerateNanoBanana2FalJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_nano_banana_2_fal", async (payload) => {
    const p = payload as Payload;

    const input: Record<string, unknown> = {
      prompt: p.prompt,
      ...(p.num_images !== undefined ? { num_images: p.num_images } : {}),
      ...(p.aspect_ratio !== undefined ? { aspect_ratio: p.aspect_ratio } : {}),
      ...(p.resolution !== undefined ? { resolution: p.resolution } : {}),
      ...(p.output_format !== undefined ? { output_format: p.output_format } : {}),
      ...(p.safety_tolerance !== undefined ? { safety_tolerance: p.safety_tolerance } : {}),
      ...(p.thinking_level !== undefined ? { thinking_level: p.thinking_level } : {}),
      ...(p.enable_web_search !== undefined ? { enable_web_search: p.enable_web_search } : {}),
      ...(p.seed !== undefined ? { seed: p.seed } : {}),
    };

    const taskId = await submitFalJob({
      fs,
      projectSlug: p.projectSlug,
      assetId: p.imgAssetId,
      assetDir: p.imgAssetDir,
      endpointId: "fal-ai/nano-banana-2",
      input,
      taskType: "fal_nano_banana_2",
      meta: { prompt: p.prompt, sourceImageIds: [] },
    });

    return { success: true, taskId };
  });
}
