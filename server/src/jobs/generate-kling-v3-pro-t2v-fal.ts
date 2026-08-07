import type { FalEndpointInputMap } from "@apicity/fal";
import type { Engine } from "videobook-engine";
import { registerJobHandler } from "../queue.js";
import { withProviderHandoff } from "./_lease.js";
import { submitFalJob } from "./_fal-shared.js";

type FalInput = FalEndpointInputMap["fal-ai/kling-video/v3/pro/text-to-video"];

type Payload = {
  type: "generate_kling_v3_pro_t2v_fal";
  vidAssetId: string;
  vidAssetDir: string;
  bookId: string;
  prompt: string;
  duration?: string;
  aspect_ratio?: FalInput["aspect_ratio"];
  generate_audio?: boolean;
  shot_type?: FalInput["shot_type"];
  negative_prompt?: string;
  cfg_scale?: number;
};

export function registerGenerateKlingV3ProT2vFalJob(fs: Engine): void {
  registerJobHandler("generate_kling_v3_pro_t2v_fal", async (payload, ctx) => {
    const p = payload as Payload;
    return withProviderHandoff(fs, p.bookId, p.vidAssetId, ctx, "generate", async (ownerId) => {
  
      const input: FalInput = {
        prompt: p.prompt,
        ...(p.duration !== undefined ? { duration: p.duration } : {}),
        ...(p.aspect_ratio !== undefined ? { aspect_ratio: p.aspect_ratio } : {}),
        ...(p.generate_audio !== undefined ? { generate_audio: p.generate_audio } : {}),
        ...(p.shot_type !== undefined ? { shot_type: p.shot_type } : {}),
        ...(p.negative_prompt !== undefined ? { negative_prompt: p.negative_prompt } : {}),
        ...(p.cfg_scale !== undefined ? { cfg_scale: p.cfg_scale } : {}),
      };
  
      const taskId = await submitFalJob({
        fs,
        bookId: p.bookId,
        assetId: p.vidAssetId,
        assetDir: p.vidAssetDir,
        endpointId: "fal-ai/kling-video/v3/pro/text-to-video",
        input,
        taskType: "fal_kling_v3_pro_t2v",
        meta: { prompt: p.prompt, mode: "t2v", sourceImageIds: [], return_last_frame: false },
        expectedOwnerId: ownerId,
      });
  
      return { taskId, result: { success: true, taskId } };    });
  });
}
