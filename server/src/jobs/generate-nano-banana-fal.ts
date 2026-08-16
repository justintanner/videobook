import type { FalEndpointInputMap } from "@apicity/fal";
import type { Engine } from "videobook-engine";
import { registerJobHandler } from "../queue.js";
import { withProviderHandoff } from "./_lease.js";
import { submitFalJob } from "./_fal-shared.js";

type FalInput = FalEndpointInputMap["fal-ai/nano-banana"];

type Payload = {
  type: "generate_nano_banana_fal";
  imgAssetId: string;
  imgAssetDir: string;
  bookId: string;
  prompt: string;
  num_images?: number;
  aspect_ratio?: FalInput["aspect_ratio"];
  output_format?: FalInput["output_format"];
  safety_tolerance?: FalInput["safety_tolerance"];
  seed?: number;
};

export function registerGenerateNanoBananaFalJob(fs: Engine): void {
  registerJobHandler("generate_nano_banana_fal", async (payload, ctx) => {
    const p = payload as Payload;
    return withProviderHandoff(fs, p.imgAssetId, ctx, "generate", async (ownerId) => {
  
      const input: FalInput = {
        prompt: p.prompt,
        ...(p.num_images !== undefined ? { num_images: p.num_images } : {}),
        ...(p.aspect_ratio !== undefined ? { aspect_ratio: p.aspect_ratio } : {}),
        ...(p.output_format !== undefined ? { output_format: p.output_format } : {}),
        ...(p.safety_tolerance !== undefined ? { safety_tolerance: p.safety_tolerance } : {}),
        ...(p.seed !== undefined ? { seed: p.seed } : {}),
      };
  
      const taskId = await submitFalJob({
        fs,
        bookId: p.bookId,
        assetId: p.imgAssetId,
        assetDir: p.imgAssetDir,
        endpointId: "fal-ai/nano-banana",
        input,
        taskType: "fal_nano_banana",
        meta: { prompt: p.prompt, sourceImageIds: [] },
        expectedOwnerId: ownerId,
      });
  
      return { taskId, result: { success: true, taskId } };    });
  });
}
