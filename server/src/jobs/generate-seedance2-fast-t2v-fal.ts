import type { FalEndpointInputMap } from "@apicity/fal";
import type { Engine } from "videobook-engine";
import { registerJobHandler } from "../queue.js";
import { withProviderHandoff } from "./_lease.js";
import { submitFalJob } from "./_fal-shared.js";

type FalInput = FalEndpointInputMap["bytedance/seedance-2.0/fast/text-to-video"];

type Payload = {
  type: "generate_seedance2_fast_t2v_fal";
  vidAssetId: string;
  vidAssetDir: string;
  bookId: string;
  prompt: string;
  resolution?: FalInput["resolution"];
  duration?: FalInput["duration"];
  aspect_ratio?: FalInput["aspect_ratio"];
  generate_audio?: boolean;
  seed?: number;
};

export function registerGenerateSeedance2FastT2vFalJob(engine: Engine): void {
  registerJobHandler("generate_seedance2_fast_t2v_fal", async (payload, ctx) => {
    const p = payload as Payload;
    return withProviderHandoff(engine, p.vidAssetId, ctx, "generate", async (ownerId) => {
  
      const input: FalInput = {
        prompt: p.prompt,
        ...(p.resolution !== undefined ? { resolution: p.resolution } : {}),
        ...(p.duration !== undefined ? { duration: p.duration } : {}),
        ...(p.aspect_ratio !== undefined ? { aspect_ratio: p.aspect_ratio } : {}),
        ...(p.generate_audio !== undefined ? { generate_audio: p.generate_audio } : {}),
        ...(p.seed !== undefined ? { seed: p.seed } : {}),
      };
  
      const taskId = await submitFalJob({
        engine,
        bookId: p.bookId,
        assetId: p.vidAssetId,
        assetDir: p.vidAssetDir,
        endpointId: "bytedance/seedance-2.0/fast/text-to-video",
        input,
        taskType: "fal_seedance2_fast_t2v",
        meta: { prompt: p.prompt, mode: "t2v", sourceImageIds: [], return_last_frame: false },
        expectedOwnerId: ownerId,
      });
  
      return { taskId, result: { success: true, taskId } };    });
  });
}
