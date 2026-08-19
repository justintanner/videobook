import type { FalEndpointInputMap } from "@apicity/fal";
import type { Engine } from "videobook-engine";
import { registerJobHandler } from "../queue.js";
import { withProviderHandoff } from "./_lease.js";
import { uploadAssetToFal } from "./_fal-upload.js";
import { submitFalJob } from "./_fal-shared.js";

type FrameInput = { assetId: string; filename: string };

type FalInput = FalEndpointInputMap["fal-ai/wan/v2.7/image-to-video"];

type Payload = {
  type: "generate_wan27_i2v_fal";
  vidAssetId: string;
  vidAssetDir: string;
  bookId: string;
  prompt: string;
  firstFrame: FrameInput;
  endFrame?: FrameInput;
  sourceImageIds: string[];
  resolution?: FalInput["resolution"];
  duration?: number;
  negative_prompt?: string;
  enable_prompt_expansion?: boolean;
  enable_safety_checker?: boolean;
  seed?: number;
};

export function registerGenerateWan27I2vFalJob(engine: Engine): void {
  registerJobHandler("generate_wan27_i2v_fal", async (payload, ctx) => {
    const p = payload as Payload;
    return withProviderHandoff(engine, p.vidAssetId, ctx, "generate", async (ownerId) => {
  
      const image_url = await uploadAssetToFal(engine, p.firstFrame.assetId, p.firstFrame.filename);
      const end_image_url = p.endFrame
        ? await uploadAssetToFal(engine, p.endFrame.assetId, p.endFrame.filename)
        : undefined;
  
      const input: FalInput = {
        prompt: p.prompt,
        image_url,
        ...(end_image_url ? { end_image_url } : {}),
        ...(p.resolution !== undefined ? { resolution: p.resolution } : {}),
        ...(p.duration !== undefined ? { duration: p.duration } : {}),
        ...(p.negative_prompt !== undefined ? { negative_prompt: p.negative_prompt } : {}),
        ...(p.enable_prompt_expansion !== undefined ? { enable_prompt_expansion: p.enable_prompt_expansion } : {}),
        ...(p.enable_safety_checker !== undefined ? { enable_safety_checker: p.enable_safety_checker } : {}),
        ...(p.seed !== undefined ? { seed: p.seed } : {}),
      };
  
      const taskId = await submitFalJob({
        engine,
        bookId: p.bookId,
        assetId: p.vidAssetId,
        assetDir: p.vidAssetDir,
        endpointId: "fal-ai/wan/v2.7/image-to-video",
        input,
        taskType: "fal_wan27_i2v",
        meta: { prompt: p.prompt, mode: "i2v", sourceImageIds: p.sourceImageIds, return_last_frame: false },
        expectedOwnerId: ownerId,
      });
  
      return { taskId, result: { success: true, taskId } };    });
  });
}
