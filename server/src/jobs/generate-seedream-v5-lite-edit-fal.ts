import type { FalEndpointInputMap } from "@apicity/fal";
import type { Engine } from "videobook-engine";
import { registerJobHandler } from "../queue.js";
import { withProviderHandoff } from "./_lease.js";
import { uploadAssetToFal } from "./_fal-upload.js";
import { submitFalJob } from "./_fal-shared.js";
import type { ImageInput } from "../tools/_image-inputs.js";

type FalInput = FalEndpointInputMap["fal-ai/bytedance/seedream/v5/lite/edit"];

type Payload = {
  type: "generate_seedream_v5_lite_edit_fal";
  imgAssetId: string;
  imgAssetDir: string;
  bookId: string;
  prompt: string;
  imageInputs: ImageInput[];
  sourceImageIds: string[];
  image_size?: FalInput["image_size"];
  num_images?: number;
  max_images?: number;
};

export function registerGenerateSeedreamV5LiteEditFalJob(engine: Engine): void {
  registerJobHandler("generate_seedream_v5_lite_edit_fal", async (payload, ctx) => {
    const p = payload as Payload;
    return withProviderHandoff(engine, p.imgAssetId, ctx, "generate", async (ownerId) => {
  
      const image_urls = await Promise.all(
        p.imageInputs.map((i) =>
          "url" in i ? i.url : uploadAssetToFal(engine, i.assetId, i.filename),
        ),
      );
  
      const input: FalInput = {
        prompt: p.prompt,
        image_urls,
        ...(p.image_size !== undefined ? { image_size: p.image_size } : {}),
        ...(p.num_images !== undefined ? { num_images: p.num_images } : {}),
        ...(p.max_images !== undefined ? { max_images: p.max_images } : {}),
      };
  
      const taskId = await submitFalJob({
        engine,
        bookId: p.bookId,
        assetId: p.imgAssetId,
        assetDir: p.imgAssetDir,
        endpointId: "fal-ai/bytedance/seedream/v5/lite/edit",
        input,
        taskType: "fal_seedream_v5_lite_edit",
        meta: {
          prompt: p.prompt,
          sourceImageIds: p.sourceImageIds,
          ...(p.image_size !== undefined ? { imageSize: p.image_size } : {}),
        },
        expectedOwnerId: ownerId,
      });
  
      return { taskId, result: { success: true, taskId } };    });
  });
}
