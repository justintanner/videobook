import type { ClipfirstFs } from "clipfirst-fs";
import { registerJobHandler } from "../queue.js";
import { submitFalJob } from "./_fal-shared.js";

type Payload = {
  type: "generate_sora2_t2v_fal";
  vidAssetId: string;
  vidAssetDir: string;
  projectSlug: string;
  prompt: string;
  model?: string;
  resolution?: string;
  aspect_ratio?: string;
  duration?: number;
};

export function registerGenerateSora2T2vFalJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_sora2_t2v_fal", async (payload) => {
    const p = payload as Payload;

    const input: Record<string, unknown> = {
      prompt: p.prompt,
      ...(p.model !== undefined ? { model: p.model } : {}),
      ...(p.resolution !== undefined ? { resolution: p.resolution } : {}),
      ...(p.aspect_ratio !== undefined ? { aspect_ratio: p.aspect_ratio } : {}),
      ...(p.duration !== undefined ? { duration: p.duration } : {}),
    };

    const taskId = await submitFalJob({
      fs,
      projectSlug: p.projectSlug,
      assetId: p.vidAssetId,
      assetDir: p.vidAssetDir,
      endpointId: "fal-ai/sora-2/text-to-video",
      input,
      taskType: "fal_sora2_t2v",
      meta: { prompt: p.prompt, mode: "t2v", sourceImageIds: [], return_last_frame: false },
    });

    return { success: true, taskId };
  });
}
