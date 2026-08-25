import type { FalEndpointInputMap } from "@apicity/fal";
import type { Engine } from "videobook-engine";
import { registerJobHandler } from "../queue.js";
import { withProviderHandoff } from "./_lease.js";
import { submitFalJob } from "./_fal-shared.js";

type FalInput = FalEndpointInputMap["alibaba/wan-3.0-prime/text-to-video"];

type Payload = {
  type: "generate_wan30_prime_t2v_fal";
  vidAssetId: string;
  vidAssetDir: string;
  bookId: string;
  prompt: string;
  aspect_ratio?: FalInput["aspect_ratio"];
  resolution?: FalInput["resolution"];
  duration: number;
  audio?: boolean;
  enable_prompt_expansion?: boolean;
  enable_thinking?: boolean;
  enable_safety_checker?: boolean;
  seed?: number;
};

export function registerGenerateWan30PrimeT2vFalJob(engine: Engine): void {
  registerJobHandler("generate_wan30_prime_t2v_fal", async (payload, ctx) => {
    const p = payload as Payload;
    return withProviderHandoff(engine, p.vidAssetId, ctx, "generate", async (ownerId) => {

      const input: FalInput = {
        prompt: p.prompt,
        ...(p.aspect_ratio !== undefined ? { aspect_ratio: p.aspect_ratio } : {}),
        ...(p.resolution !== undefined ? { resolution: p.resolution } : {}),
        duration: p.duration,
        ...(p.audio !== undefined ? { audio: p.audio } : {}),
        ...(p.enable_prompt_expansion !== undefined ? { enable_prompt_expansion: p.enable_prompt_expansion } : {}),
        ...(p.enable_thinking !== undefined ? { enable_thinking: p.enable_thinking } : {}),
        ...(p.enable_safety_checker !== undefined ? { enable_safety_checker: p.enable_safety_checker } : {}),
        ...(p.seed !== undefined ? { seed: p.seed } : {}),
      };

      const taskId = await submitFalJob({
        engine,
        bookId: p.bookId,
        assetId: p.vidAssetId,
        assetDir: p.vidAssetDir,
        endpointId: "alibaba/wan-3.0-prime/text-to-video",
        input,
        taskType: "fal_wan30_prime_t2v",
        meta: { prompt: p.prompt, mode: "t2v", sourceImageIds: [], return_last_frame: false },
        expectedOwnerId: ownerId,
      });

      return { taskId, result: { success: true, taskId } };    });
  });
}
