import type { Engine } from "videobook-engine";
import { registerJobHandler } from "../queue.js";
import { withProviderHandoff } from "./_lease.js";
import { uploadAssetToFal } from "./_fal-upload.js";
import { submitFalJob } from "./_fal-shared.js";
import type { ImageInput } from "../tools/_image-inputs.js";

type Payload = {
  type: "generate_seedream_v5_lite_edit_fal";
  imgAssetId: string;
  imgAssetDir: string;
  bookId: string;
  prompt: string;
  imageInputs: ImageInput[];
  sourceImageIds: string[];
  image_size?: string;
  auto_4K?: boolean;
  num_images?: number;
  max_images?: number;
};

export function registerGenerateSeedreamV5LiteEditFalJob(fs: Engine): void {
  registerJobHandler("generate_seedream_v5_lite_edit_fal", async (payload, ctx) => {
    const p = payload as Payload;
    return withProviderHandoff(fs, p.bookId, p.imgAssetId, ctx, "generate", async (ownerId) => {
  
      const image_urls = await Promise.all(
        p.imageInputs.map((i) =>
          "url" in i ? i.url : uploadAssetToFal(fs, i.assetId, i.filename, p.bookId),
        ),
      );
  
      const input: Record<string, unknown> = {
        prompt: p.prompt,
        image_urls,
        ...(p.image_size !== undefined ? { image_size: p.image_size } : {}),
        ...(p.auto_4K !== undefined ? { auto_4K: p.auto_4K } : {}),
        ...(p.num_images !== undefined ? { num_images: p.num_images } : {}),
        ...(p.max_images !== undefined ? { max_images: p.max_images } : {}),
      };
  
      const taskId = await submitFalJob({
        fs,
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
