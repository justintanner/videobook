import type { FalEndpointInputMap } from "@apicity/fal";
import type { Engine } from "videobook-engine";
import { registerJobHandler } from "../queue.js";
import { withProviderHandoff } from "./_lease.js";
import { uploadAssetToFal } from "./_fal-upload.js";
import { submitFalJob } from "./_fal-shared.js";
import type { ImageInput } from "../tools/_image-inputs.js";

type FalInput = FalEndpointInputMap["fal-ai/wan/v2.7/pro/edit"];

type Payload = {
  type: "generate_wan27_pro_edit_fal";
  imgAssetId: string;
  imgAssetDir: string;
  bookId: string;
  prompt: string;
  imageInputs: ImageInput[];
  sourceImageIds: string[];
  negative_prompt?: string;
  image_size?: FalInput["image_size"];
  num_images?: number;
  seed?: number;
};

export function registerGenerateWan27ProEditFalJob(fs: Engine): void {
  registerJobHandler("generate_wan27_pro_edit_fal", async (payload, ctx) => {
    const p = payload as Payload;
    return withProviderHandoff(fs, p.bookId, p.imgAssetId, ctx, "generate", async (ownerId) => {
  
      const image_urls = await Promise.all(
        p.imageInputs.map((i) =>
          "url" in i ? i.url : uploadAssetToFal(fs, i.assetId, i.filename, p.bookId),
        ),
      );
  
      const input: FalInput = {
        prompt: p.prompt,
        image_urls,
        ...(p.negative_prompt !== undefined ? { negative_prompt: p.negative_prompt } : {}),
        ...(p.image_size !== undefined ? { image_size: p.image_size } : {}),
        ...(p.num_images !== undefined ? { num_images: p.num_images } : {}),
        ...(p.seed !== undefined ? { seed: p.seed } : {}),
      };
  
      const taskId = await submitFalJob({
        fs,
        bookId: p.bookId,
        assetId: p.imgAssetId,
        assetDir: p.imgAssetDir,
        endpointId: "fal-ai/wan/v2.7/pro/edit",
        input,
        taskType: "fal_wan27_pro_edit",
        meta: {
          prompt: p.prompt,
          sourceImageIds: p.sourceImageIds,
          ...(p.image_size !== undefined ? { imageSize: p.image_size } : {}),
          ...(p.seed !== undefined ? { seed: p.seed } : {}),
        },
        expectedOwnerId: ownerId,
      });
  
      return { taskId, result: { success: true, taskId } };    });
  });
}
