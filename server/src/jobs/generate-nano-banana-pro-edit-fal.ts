import type { FalEndpointInputMap } from "@apicity/fal";
import type { Engine } from "videobook-engine";
import { registerJobHandler } from "../queue.js";
import { withProviderHandoff } from "./_lease.js";
import { uploadAssetToFal } from "./_fal-upload.js";
import { submitFalJob } from "./_fal-shared.js";
import type { ImageInput } from "../tools/_image-inputs.js";

type FalInput = FalEndpointInputMap["fal-ai/nano-banana-pro/edit"];

type Payload = {
  type: "generate_nano_banana_pro_edit_fal";
  imgAssetId: string;
  imgAssetDir: string;
  bookId: string;
  prompt: string;
  imageInputs: ImageInput[];
  sourceImageIds: string[];
  num_images?: number;
  aspect_ratio?: FalInput["aspect_ratio"];
  resolution?: FalInput["resolution"];
  output_format?: FalInput["output_format"];
  seed?: number;
  enable_web_search?: boolean;
};

export function registerGenerateNanoBananaProEditFalJob(fs: Engine): void {
  registerJobHandler("generate_nano_banana_pro_edit_fal", async (payload, ctx) => {
    const p = payload as Payload;
    return withProviderHandoff(fs, p.imgAssetId, ctx, "generate", async (ownerId) => {
  
      const image_urls = await Promise.all(
        p.imageInputs.map((i) =>
          "url" in i ? i.url : uploadAssetToFal(fs, i.assetId, i.filename),
        ),
      );
  
      const input: FalInput = {
        prompt: p.prompt,
        image_urls,
        ...(p.num_images !== undefined ? { num_images: p.num_images } : {}),
        ...(p.aspect_ratio !== undefined ? { aspect_ratio: p.aspect_ratio } : {}),
        ...(p.resolution !== undefined ? { resolution: p.resolution } : {}),
        ...(p.output_format !== undefined ? { output_format: p.output_format } : {}),
        ...(p.seed !== undefined ? { seed: p.seed } : {}),
        ...(p.enable_web_search !== undefined ? { enable_web_search: p.enable_web_search } : {}),
      };
  
      const taskId = await submitFalJob({
        fs,
        bookId: p.bookId,
        assetId: p.imgAssetId,
        assetDir: p.imgAssetDir,
        endpointId: "fal-ai/nano-banana-pro/edit",
        input,
        taskType: "fal_nano_banana_pro_edit",
        meta: {
          prompt: p.prompt,
          sourceImageIds: p.sourceImageIds,
          ...(p.aspect_ratio !== undefined ? { aspectRatio: p.aspect_ratio } : {}),
          ...(p.resolution !== undefined ? { resolution: p.resolution } : {}),
          ...(p.output_format !== undefined ? { outputFormat: p.output_format } : {}),
        },
        expectedOwnerId: ownerId,
      });
  
      return { taskId, result: { success: true, taskId } };    });
  });
}
