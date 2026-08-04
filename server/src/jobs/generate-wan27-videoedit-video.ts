import type { Engine } from "videobook-engine";
import type { Wan27Resolution, Wan27VideoEditRequest } from "@apicity/kie";
import { submitKieTask } from "./kie-paygate.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildWan27VideoEditPayload } from "../payload-builders.js";
import { transformProviderPrompt } from "../provider-prompt-transform.js";

type RefInput = { assetId: string; filename: string };

type GenerateWan27VideoeditVideoPayload = {
  type: "generate_wan27_videoedit_video";
  vidAssetId: string;
  vidAssetDir: string;
  bookId: string;
  prompt?: string;
  negative_prompt?: string;
  videoInput: RefInput;
  imageInput?: RefInput;
  sourceImageIds: string[];
  sourceVideoIds: string[];
  sourceAudioIds: string[];
  resolution?: Wan27Resolution;
  aspect_ratio?: Wan27VideoEditRequest["input"]["aspect_ratio"];
  duration?: string;
  audio_setting?: Wan27VideoEditRequest["input"]["audio_setting"];
  prompt_extend?: boolean;
  watermark?: boolean;
  nsfw_checker?: boolean;
  seed?: number;
};

async function uploadSingle(
  fs: Engine,
  input: RefInput,
  bookId: string,
): Promise<string> {
  return uploadAssetToKie(fs, input.assetId, input.filename, bookId);
}

export function registerGenerateWan27VideoeditVideoJob(fs: Engine): void {
  registerJobHandler("generate_wan27_videoedit_video", async (payload, ctx) => {
    const {
      vidAssetId, vidAssetDir, bookId, prompt, negative_prompt,
      videoInput, imageInput,
      sourceImageIds, sourceVideoIds, sourceAudioIds,
      resolution, aspect_ratio, duration, audio_setting, prompt_extend, watermark, nsfw_checker, seed,
    } = payload as GenerateWan27VideoeditVideoPayload;

    requireApiKey("KIE_API_KEY");

    const videoUrl = await uploadSingle(fs, videoInput, bookId);
    const referenceImageUrl = imageInput ? await uploadSingle(fs, imageInput, bookId) : undefined;

    // Free-form edit prompt — rewrite confirmed @vid-*/@img-* to natural refs.
    const normalizedPrompt = prompt === undefined
      ? undefined
      : transformProviderPrompt("generate_kie_wan_2_7_edit_video", {
        prompt,
        video_ref: videoInput.assetId,
        image_ref: imageInput?.assetId,
      });

    const request = buildWan27VideoEditPayload(
      {
        prompt: normalizedPrompt,
        negative_prompt,
        resolution,
        aspect_ratio,
        duration,
        audio_setting,
        prompt_extend,
        watermark,
        nsfw_checker,
        seed,
      },
      { videoUrl, referenceImageUrl },
    );
    const taskId = await submitKieTask(fs, ctx, {
      request,
      taskType: "wan27_videoedit_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      bookId,
      meta: {
        prompt: prompt ?? "",
        mode: "videoedit",
        sourceImageIds,
        sourceVideoIds,
        sourceAudioIds,
      },
    });

    return { success: true, taskId };
  });
}
