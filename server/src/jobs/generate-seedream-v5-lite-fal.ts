import type { FalEndpointInputMap } from "@apicity/fal";
import type { Engine } from "videobook-engine";
import { registerJobHandler } from "../queue.js";
import { withProviderHandoff } from "./_lease.js";
import { submitFalJob } from "./_fal-shared.js";

type FalInput = FalEndpointInputMap["fal-ai/bytedance/seedream/v5/lite/text-to-image"];

type Payload = {
  type: "generate_seedream_v5_lite_fal";
  imgAssetId: string;
  imgAssetDir: string;
  bookId: string;
  prompt: string;
  image_size?: FalInput["image_size"];
  num_images?: number;
  max_images?: number;
};

export function registerGenerateSeedreamV5LiteFalJob(engine: Engine): void {
  registerJobHandler("generate_seedream_v5_lite_fal", async (payload, ctx) => {
    const p = payload as Payload;
    return withProviderHandoff(engine, p.imgAssetId, ctx, "generate", async (ownerId) => {
  
      const input: FalInput = {
        prompt: p.prompt,
        ...(p.image_size !== undefined ? { image_size: p.image_size } : {}),
        ...(p.num_images !== undefined ? { num_images: p.num_images } : {}),
        ...(p.max_images !== undefined ? { max_images: p.max_images } : {}),
      };
  
      const taskId = await submitFalJob({
        engine,
        bookId: p.bookId,
        assetId: p.imgAssetId,
        assetDir: p.imgAssetDir,
        endpointId: "fal-ai/bytedance/seedream/v5/lite/text-to-image",
        input,
        taskType: "fal_seedream_v5_lite",
        meta: {
          prompt: p.prompt,
          sourceImageIds: [],
          ...(p.image_size !== undefined ? { imageSize: p.image_size } : {}),
        },
        expectedOwnerId: ownerId,
      });
  
      return { taskId, result: { success: true, taskId } };    });
  });
}
