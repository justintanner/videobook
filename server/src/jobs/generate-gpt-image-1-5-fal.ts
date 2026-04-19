import type { ClipfirstFs } from "clipfirst-fs";
import { registerJobHandler } from "../queue.js";
import { submitFalJob } from "./_fal-shared.js";

type Payload = {
  type: "generate_gpt_image_1_5_fal";
  imgAssetId: string;
  imgAssetDir: string;
  projectSlug: string;
  prompt: string;
  image_size?: string;
  num_images?: number;
  background?: string;
  output_format?: string;
  quality?: string;
};

export function registerGenerateGptImage1p5FalJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_gpt_image_1_5_fal", async (payload) => {
    const p = payload as Payload;

    const input: Record<string, unknown> = {
      prompt: p.prompt,
      ...(p.image_size !== undefined ? { image_size: p.image_size } : {}),
      ...(p.num_images !== undefined ? { num_images: p.num_images } : {}),
      ...(p.background !== undefined ? { background: p.background } : {}),
      ...(p.output_format !== undefined ? { output_format: p.output_format } : {}),
      ...(p.quality !== undefined ? { quality: p.quality } : {}),
    };

    const taskId = await submitFalJob({
      fs,
      projectSlug: p.projectSlug,
      assetId: p.imgAssetId,
      assetDir: p.imgAssetDir,
      endpointId: "fal-ai/gpt-image-1.5",
      input,
      taskType: "fal_gpt_image_1_5",
      meta: { prompt: p.prompt, sourceImageIds: [] },
    });

    return { success: true, taskId };
  });
}
