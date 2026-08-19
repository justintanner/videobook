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
  engine: Engine,
  input: RefInput,
): Promise<string> {
  return uploadAssetToKie(engine, input.assetId, input.filename);
}

export function registerGenerateWan27I2vVideoJob(engine: Engine): void {
  registerJobHandler("generate_wan27_i2v_video", async (payload, ctx) => {
    const {
      vidAssetId, vidAssetDir, bookId, prompt, negative_prompt,
      firstFrame, lastFrame, firstClip, drivingAudio,
      sourceImageIds, sourceVideoIds, sourceAudioIds,
      resolution, duration, prompt_extend, watermark, nsfw_checker, seed,
    } = payload as GenerateWan27I2vVideoPayload;

    requireApiKey("KIE_API_KEY");

    const firstFrameUrl = firstFrame ? await uploadInput(engine, firstFrame) : undefined;
    const lastFrameUrl = lastFrame ? await uploadInput(engine, lastFrame) : undefined;
    const firstClipUrl = firstClip ? await uploadInput(engine, firstClip) : undefined;
    const drivingAudioUrl = drivingAudio ? await uploadInput(engine, drivingAudio) : undefined;
    const normalizedPrompt = transformProviderPrompt(
      "generate_kie_wan_2_7_image_to_video",
      {
        prompt,
        first_frame_ref: firstFrame?.assetId,
        last_frame_ref: lastFrame?.assetId,
        first_clip_ref: firstClip?.assetId,
        driving_audio_ref: drivingAudio?.assetId,
      },
    ) ?? "";

    const request = buildWan27FramesVideoPayload(
      { prompt: normalizedPrompt, negative_prompt, resolution, duration, prompt_extend, watermark, nsfw_checker, seed },
      { firstFrameUrl, lastFrameUrl, firstClipUrl, drivingAudioUrl },
    );
    const taskId = await submitKieTask(engine, ctx, {
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
