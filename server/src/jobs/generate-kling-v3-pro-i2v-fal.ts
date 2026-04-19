import type { ClipfirstFs } from "clipfirst-fs";
import { uploadAssetToFal } from "./_fal-upload.js";
import { registerJobHandler } from "../queue.js";
import { submitFalJob } from "./_fal-shared.js";

type FrameInput = { assetId: string; filename: string };

type Payload = {
  type: "generate_kling_v3_pro_i2v_fal";
  vidAssetId: string;
  vidAssetDir: string;
  projectSlug: string;
  firstFrame: FrameInput;
  endFrame?: FrameInput;
  sourceImageIds: string[];
  prompt?: string;
  duration?: string;
  generate_audio?: boolean;
  negative_prompt?: string;
  cfg_scale?: number;
};

export function registerGenerateKlingV3ProI2vFalJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_kling_v3_pro_i2v_fal", async (payload) => {
    const p = payload as Payload;

    const start_image_url = await uploadAssetToFal(fs, p.firstFrame.assetId, p.firstFrame.filename, p.projectSlug);
    const end_image_url = p.endFrame
      ? await uploadAssetToFal(fs, p.endFrame.assetId, p.endFrame.filename, p.projectSlug)
      : undefined;

    const input: Record<string, unknown> = {
      start_image_url,
      ...(end_image_url ? { end_image_url } : {}),
      ...(p.prompt !== undefined ? { prompt: p.prompt } : {}),
      ...(p.duration !== undefined ? { duration: p.duration } : {}),
      ...(p.generate_audio !== undefined ? { generate_audio: p.generate_audio } : {}),
      ...(p.negative_prompt !== undefined ? { negative_prompt: p.negative_prompt } : {}),
      ...(p.cfg_scale !== undefined ? { cfg_scale: p.cfg_scale } : {}),
    };

    const taskId = await submitFalJob({
      fs,
      projectSlug: p.projectSlug,
      assetId: p.vidAssetId,
      assetDir: p.vidAssetDir,
      endpointId: "fal-ai/kling-video/v3/pro/image-to-video",
      input,
      taskType: "fal_kling_v3_pro_i2v",
      meta: { prompt: p.prompt ?? "", mode: "i2v", sourceImageIds: p.sourceImageIds, return_last_frame: false },
    });

    return { success: true, taskId };
  });
}
