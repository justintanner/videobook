import type { VideocityFs } from "videocity-engine";
import { submitKieTask } from "./kie-paygate.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildKling30MotionControlPayload } from "../payload-builders.js";

type RefInput = { assetId: string; filename: string };

type GenerateKling30MotionControlPayload = {
  type: "generate_kling30_motion_control_video";
  vidAssetId: string;
  vidAssetDir: string;
  projectSlug: string;
  imageInputs: RefInput[];
  videoInputs: RefInput[];
  sourceImageIds: string[];
  sourceVideoIds: string[];
  prompt?: string;
  mode?: "720p" | "1080p";
  character_orientation?: "video" | "image";
  background_source?: "input_video" | "input_image";
};

async function uploadInputs(fs: VideocityFs, inputs: RefInput[], projectSlug: string): Promise<string[]> {
  const urls: string[] = [];
  for (const { assetId, filename } of inputs) {
    urls.push(await uploadAssetToKie(fs, assetId, filename, projectSlug));
  }
  return urls;
}

export function registerGenerateKling30MotionControlVideoJob(fs: VideocityFs): void {
  registerJobHandler("generate_kling30_motion_control_video", async (payload, ctx) => {
    const {
      vidAssetId, vidAssetDir, projectSlug,
      imageInputs, videoInputs, sourceImageIds, sourceVideoIds,
      prompt, mode, character_orientation, background_source,
    } = payload as GenerateKling30MotionControlPayload;

    requireApiKey("KIE_API_KEY");

    const inputUrls = await uploadInputs(fs, imageInputs, projectSlug);
    const videoUrls = await uploadInputs(fs, videoInputs, projectSlug);

    const request = buildKling30MotionControlPayload(
      { prompt, mode, character_orientation, background_source },
      inputUrls,
      videoUrls,
    );
    const taskId = await submitKieTask(fs, ctx, {
      request,
      taskType: "kling30_motion_control_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      projectSlug,
      meta: {
        ...(prompt !== undefined ? { prompt } : {}),
        ...(mode !== undefined ? { mode } : {}),
        sourceImageIds,
        sourceVideoIds,
      },
    });

    return { success: true, taskId };
  });
}
