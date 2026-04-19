import type { ClipfirstFs } from "clipfirst-fs";
import { uploadAssetToFal } from "./_fal-upload.js";
import { registerJobHandler } from "../queue.js";
import { submitFalJob } from "./_fal-shared.js";

type FrameInput = { assetId: string; filename: string };

type Payload = {
  type: "generate_veo31_i2v_fal";
  vidAssetId: string;
  vidAssetDir: string;
  projectSlug: string;
  prompt: string;
  firstFrame: FrameInput;
  sourceImageIds: string[];
  aspect_ratio?: string;
  duration?: string;
  resolution?: string;
  generate_audio?: boolean;
  negative_prompt?: string;
  seed?: number;
  auto_fix?: boolean;
  safety_tolerance?: string;
};

export function registerGenerateVeo31I2vFalJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_veo31_i2v_fal", async (payload) => {
    const p = payload as Payload;

    const image_url = await uploadAssetToFal(fs, p.firstFrame.assetId, p.firstFrame.filename, p.projectSlug);

    const input: Record<string, unknown> = {
      prompt: p.prompt,
      image_url,
      ...(p.aspect_ratio !== undefined ? { aspect_ratio: p.aspect_ratio } : {}),
      ...(p.duration !== undefined ? { duration: p.duration } : {}),
      ...(p.resolution !== undefined ? { resolution: p.resolution } : {}),
      ...(p.generate_audio !== undefined ? { generate_audio: p.generate_audio } : {}),
      ...(p.negative_prompt !== undefined ? { negative_prompt: p.negative_prompt } : {}),
      ...(p.seed !== undefined ? { seed: p.seed } : {}),
      ...(p.auto_fix !== undefined ? { auto_fix: p.auto_fix } : {}),
      ...(p.safety_tolerance !== undefined ? { safety_tolerance: p.safety_tolerance } : {}),
    };

    const taskId = await submitFalJob({
      fs,
      projectSlug: p.projectSlug,
      assetId: p.vidAssetId,
      assetDir: p.vidAssetDir,
      endpointId: "fal-ai/veo3.1/image-to-video",
      input,
      taskType: "fal_veo31_i2v",
      meta: { prompt: p.prompt, mode: "i2v", sourceImageIds: p.sourceImageIds, return_last_frame: false },
    });

    return { success: true, taskId };
  });
}
