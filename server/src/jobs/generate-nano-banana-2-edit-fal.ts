import type { FalEndpointInputMap } from "@apicity/fal";
import type { Engine } from "videobook-engine";
import { registerJobHandler } from "../queue.js";
import { withProviderHandoff } from "./_lease.js";
import { uploadAssetToFal } from "./_fal-upload.js";
import { submitFalJob } from "./_fal-shared.js";

type ImageInput = { assetId: string; filename: string };

type FalInput = FalEndpointInputMap["fal-ai/nano-banana-2/edit"];

type Payload = {
  type: "generate_nano_banana_2_edit_fal";
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
  safety_tolerance?: FalInput["safety_tolerance"];
  thinking_level?: FalInput["thinking_level"];
  enable_web_search?: boolean;
  seed?: number;
};

export function registerGenerateNanoBanana2EditFalJob(engine: Engine): void {
  registerJobHandler("generate_nano_banana_2_edit_fal", async (payload, ctx) => {
    const p = payload as Payload;
    return withProviderHandoff(engine, p.imgAssetId, ctx, "generate", async (ownerId) => {
  
      const image_urls = await Promise.all(
        p.imageInputs.map((i) => uploadAssetToFal(engine, i.assetId, i.filename)),
      );
  
      const input: FalInput = {
        prompt: p.prompt,
        image_urls,
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
        engine,
        bookId: p.bookId,
        assetId: p.imgAssetId,
        assetDir: p.imgAssetDir,
        endpointId: "fal-ai/nano-banana-2/edit",
        input,
        taskType: "fal_nano_banana_2_edit",
        meta: { prompt: p.prompt, sourceImageIds: p.sourceImageIds },
        expectedOwnerId: ownerId,
      });
  
      return { taskId, result: { success: true, taskId } };    });
  });
}
