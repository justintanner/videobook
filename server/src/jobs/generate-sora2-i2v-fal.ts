import type { ClipfirstFs } from "clipfirst-fs";
import { uploadAssetFile } from "../upload.js";
import { registerJobHandler } from "../queue.js";
import { submitFalJob } from "./_fal-shared.js";

type FrameInput = { assetId: string; filename: string };

type Payload = {
  type: "generate_sora2_i2v_fal";
  vidAssetId: string;
  vidAssetDir: string;
  projectSlug: string;
  prompt: string;
  firstFrame: FrameInput;
  sourceImageIds: string[];
  model?: string;
  resolution?: string;
  aspect_ratio?: string;
  duration?: number;
};

export function registerGenerateSora2I2vFalJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_sora2_i2v_fal", async (payload) => {
    const p = payload as Payload;

    const image_url = await uploadAssetFile(fs, p.firstFrame.assetId, p.firstFrame.filename, p.projectSlug);

    const input: Record<string, unknown> = {
      prompt: p.prompt,
      image_url,
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
      endpointId: "fal-ai/sora-2/image-to-video",
      input,
      taskType: "fal_sora2_i2v",
      meta: { prompt: p.prompt, mode: "i2v", sourceImageIds: p.sourceImageIds, return_last_frame: false },
    });

    return { success: true, taskId };
  });
}
