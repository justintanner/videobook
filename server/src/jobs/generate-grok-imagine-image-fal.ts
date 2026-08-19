import type { FalEndpointInputMap } from "@apicity/fal";
import type { Engine } from "videobook-engine";
import { registerJobHandler } from "../queue.js";
import { withProviderHandoff } from "./_lease.js";
import { submitFalJob } from "./_fal-shared.js";

type FalInput = FalEndpointInputMap["xai/grok-imagine-image"];

type Payload = {
  type: "generate_grok_imagine_image_fal";
  imgAssetId: string;
  imgAssetDir: string;
  bookId: string;
  prompt: string;
  num_images?: number;
  aspect_ratio?: FalInput["aspect_ratio"];
  resolution?: FalInput["resolution"];
  output_format?: FalInput["output_format"];
};

export function registerGenerateGrokImagineImageFalJob(engine: Engine): void {
  registerJobHandler("generate_grok_imagine_image_fal", async (payload, ctx) => {
    const p = payload as Payload;
    return withProviderHandoff(engine, p.imgAssetId, ctx, "generate", async (ownerId) => {
  
      const input: FalInput = {
        prompt: p.prompt,
        ...(p.num_images !== undefined ? { num_images: p.num_images } : {}),
        ...(p.aspect_ratio !== undefined ? { aspect_ratio: p.aspect_ratio } : {}),
        ...(p.resolution !== undefined ? { resolution: p.resolution } : {}),
        ...(p.output_format !== undefined ? { output_format: p.output_format } : {}),
      };
  
      const taskId = await submitFalJob({
        engine,
        bookId: p.bookId,
        assetId: p.imgAssetId,
        assetDir: p.imgAssetDir,
        endpointId: "xai/grok-imagine-image",
        input,
        taskType: "fal_grok_imagine_image",
        meta: { prompt: p.prompt },
        expectedOwnerId: ownerId,
      });
  
      return { taskId, result: { success: true, taskId } };    });
  });
}
