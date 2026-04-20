import type { ClipfirstFs } from "clipfirst-fs";
import { registerJobHandler } from "../queue.js";
import { uploadAssetToFal } from "./_fal-upload.js";
import { submitFalJob } from "./_fal-shared.js";

type RefInput = { assetId: string; filename: string };

type Payload = {
  type: "generate_wan27_videoedit_fal";
  vidAssetId: string;
  vidAssetDir: string;
  projectSlug: string;
  prompt: string;
  sourceVideo: RefInput;
  refImage?: RefInput;
  sourceImageIds?: string[];
  sourceVideoIds: string[];
  aspect_ratio?: string;
  resolution?: string;
  duration?: number;
  audio_setting?: string;
  negative_prompt?: string;
  enable_safety_checker?: boolean;
  seed?: number;
};

export function registerGenerateWan27VideoeditFalJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_wan27_videoedit_fal", async (payload) => {
    const p = payload as Payload;

    const video_url = await uploadAssetToFal(fs, p.sourceVideo.assetId, p.sourceVideo.filename, p.projectSlug);
    const reference_image_url = p.refImage
      ? await uploadAssetToFal(fs, p.refImage.assetId, p.refImage.filename, p.projectSlug)
      : undefined;

    const input: Record<string, unknown> = {
      prompt: p.prompt,
      video_url,
      ...(reference_image_url ? { reference_image_url } : {}),
      ...(p.aspect_ratio !== undefined ? { aspect_ratio: p.aspect_ratio } : {}),
      ...(p.resolution !== undefined ? { resolution: p.resolution } : {}),
      ...(p.duration !== undefined ? { duration: p.duration } : {}),
      ...(p.audio_setting !== undefined ? { audio_setting: p.audio_setting } : {}),
      ...(p.negative_prompt !== undefined ? { negative_prompt: p.negative_prompt } : {}),
      ...(p.enable_safety_checker !== undefined ? { enable_safety_checker: p.enable_safety_checker } : {}),
      ...(p.seed !== undefined ? { seed: p.seed } : {}),
    };

    const taskId = await submitFalJob({
      fs,
      projectSlug: p.projectSlug,
      assetId: p.vidAssetId,
      assetDir: p.vidAssetDir,
      endpointId: "fal-ai/wan/v2.7/edit-video",
      input,
      taskType: "fal_wan27_videoedit",
      meta: {
        prompt: p.prompt,
        mode: "videoedit",
        sourceVideoIds: p.sourceVideoIds,
        ...(p.sourceImageIds ? { sourceImageIds: p.sourceImageIds } : {}),
      },
    });

    return { success: true, taskId };
  });
}
