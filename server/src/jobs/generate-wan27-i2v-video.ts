import type { VideocityFs } from "vc-engine";
import type { Wan27Resolution } from "@apicity/kie";
import { submitKieTask } from "./kie-paygate.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildWan27FramesVideoPayload } from "../payload-builders.js";

type RefInput = { assetId: string; filename: string };

type GenerateWan27I2vVideoPayload = {
  type: "generate_wan27_i2v_video";
  vidAssetId: string;
  vidAssetDir: string;
  projectSlug: string;
  prompt: string;
  negative_prompt?: string;
  firstFrame?: RefInput;
  lastFrame?: RefInput;
  firstClip?: RefInput;
  drivingAudio?: RefInput;
  sourceImageIds: string[];
  sourceVideoIds: string[];
  sourceAudioIds: string[];
  resolution?: Wan27Resolution;
  duration?: string;
  prompt_extend?: boolean;
  watermark?: boolean;
  nsfw_checker?: boolean;
  seed?: number;
};

async function uploadInput(
  fs: VideocityFs,
  input: RefInput,
  projectSlug: string,
): Promise<string> {
  return uploadAssetToKie(fs, input.assetId, input.filename, projectSlug);
}

export function registerGenerateWan27I2vVideoJob(fs: VideocityFs): void {
  registerJobHandler("generate_wan27_i2v_video", async (payload, ctx) => {
    const {
      vidAssetId, vidAssetDir, projectSlug, prompt, negative_prompt,
      firstFrame, lastFrame, firstClip, drivingAudio,
      sourceImageIds, sourceVideoIds, sourceAudioIds,
      resolution, duration, prompt_extend, watermark, nsfw_checker, seed,
    } = payload as GenerateWan27I2vVideoPayload;

    requireApiKey("KIE_API_KEY");

    const firstFrameUrl = firstFrame ? await uploadInput(fs, firstFrame, projectSlug) : undefined;
    const lastFrameUrl = lastFrame ? await uploadInput(fs, lastFrame, projectSlug) : undefined;
    const firstClipUrl = firstClip ? await uploadInput(fs, firstClip, projectSlug) : undefined;
    const drivingAudioUrl = drivingAudio ? await uploadInput(fs, drivingAudio, projectSlug) : undefined;

    const request = buildWan27FramesVideoPayload(
      { prompt, negative_prompt, resolution, duration, prompt_extend, watermark, nsfw_checker, seed },
      { firstFrameUrl, lastFrameUrl, firstClipUrl, drivingAudioUrl },
    );
    const taskId = await submitKieTask(fs, ctx, {
      request,
      taskType: "wan27_i2v_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      projectSlug,
      meta: {
        prompt,
        mode: "i2v",
        sourceImageIds,
        sourceVideoIds,
        sourceAudioIds,
      },
    });

    return { success: true, taskId };
  });
}
