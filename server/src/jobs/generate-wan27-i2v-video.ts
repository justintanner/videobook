import type { Engine } from "videobook-engine";
import type { Wan27Resolution } from "@apicity/kie";
import { submitKieTask } from "./kie-paygate.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildWan27FramesVideoPayload } from "../payload-builders.js";
import { transformProviderPrompt } from "../provider-prompt-transform.js";

type RefInput = { assetId: string; filename: string };

type GenerateWan27I2vVideoPayload = {
  type: "generate_wan27_i2v_video";
  vidAssetId: string;
  vidAssetDir: string;
  bookId: string;
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
  fs: Engine,
  input: RefInput,
  bookId: string,
): Promise<string> {
  return uploadAssetToKie(fs, input.assetId, input.filename, bookId);
}

export function registerGenerateWan27I2vVideoJob(fs: Engine): void {
  registerJobHandler("generate_wan27_i2v_video", async (payload, ctx) => {
    const {
      vidAssetId, vidAssetDir, bookId, prompt, negative_prompt,
      firstFrame, lastFrame, firstClip, drivingAudio,
      sourceImageIds, sourceVideoIds, sourceAudioIds,
      resolution, duration, prompt_extend, watermark, nsfw_checker, seed,
    } = payload as GenerateWan27I2vVideoPayload;

    requireApiKey("KIE_API_KEY");

    const firstFrameUrl = firstFrame ? await uploadInput(fs, firstFrame, bookId) : undefined;
    const lastFrameUrl = lastFrame ? await uploadInput(fs, lastFrame, bookId) : undefined;
    const firstClipUrl = firstClip ? await uploadInput(fs, firstClip, bookId) : undefined;
    const drivingAudioUrl = drivingAudio ? await uploadInput(fs, drivingAudio, bookId) : undefined;
    const normalizedPrompt = transformProviderPrompt(
      "generate_kie_wan_2_7_image_to_video",
      {
        prompt,
        first_frame_slug: firstFrame?.assetId,
        last_frame_slug: lastFrame?.assetId,
        first_clip_slug: firstClip?.assetId,
        driving_audio_slug: drivingAudio?.assetId,
      },
    ) ?? "";

    const request = buildWan27FramesVideoPayload(
      { prompt: normalizedPrompt, negative_prompt, resolution, duration, prompt_extend, watermark, nsfw_checker, seed },
      { firstFrameUrl, lastFrameUrl, firstClipUrl, drivingAudioUrl },
    );
    const taskId = await submitKieTask(fs, ctx, {
      request,
      taskType: "wan27_i2v_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      bookId,
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
