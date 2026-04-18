import type { ClipfirstFs } from "clipfirst-fs";
import { registerJobHandler } from "../queue.js";
import { submitFalJob } from "./_fal-shared.js";

type Payload = {
  type: "generate_seedream_v5_lite_fal";
  imgAssetId: string;
  imgAssetDir: string;
  projectSlug: string;
  prompt: string;
  image_size?: string;
  num_images?: number;
  max_images?: number;
  seed?: number;
};

export function registerGenerateSeedreamV5LiteFalJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_seedream_v5_lite_fal", async (payload) => {
    const p = payload as Payload;

    const input: Record<string, unknown> = {
      prompt: p.prompt,
      ...(p.image_size !== undefined ? { image_size: p.image_size } : {}),
      ...(p.num_images !== undefined ? { num_images: p.num_images } : {}),
      ...(p.max_images !== undefined ? { max_images: p.max_images } : {}),
      ...(p.seed !== undefined ? { seed: p.seed } : {}),
    };

    const taskId = await submitFalJob({
      fs,
      projectSlug: p.projectSlug,
      assetId: p.imgAssetId,
      assetDir: p.imgAssetDir,
      endpointId: "fal-ai/bytedance/seedream/v5/lite/text-to-image",
      input,
      taskType: "fal_seedream_v5_lite",
      meta: {
        prompt: p.prompt,
        sourceImageIds: [],
        ...(p.image_size !== undefined ? { imageSize: p.image_size } : {}),
        ...(p.seed !== undefined ? { seed: p.seed } : {}),
      },
    });

    return { success: true, taskId };
  });
}
