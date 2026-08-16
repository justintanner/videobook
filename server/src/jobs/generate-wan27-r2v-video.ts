import type { Engine } from "videobook-engine";
import type { Wan27RefToVideoRequest, Wan27Resolution } from "@apicity/kie";
import { submitKieTask } from "./kie-paygate.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildWan27ReferenceVideoPayload } from "../payload-builders.js";
import { transformProviderPrompt } from "../provider-prompt-transform.js";

type RefInput = { assetId: string; filename: string };

type GenerateWan27R2vVideoPayload = {
  type: "generate_wan27_r2v_video";
  vidAssetId: string;
  vidAssetDir: string;
  bookId: string;
  prompt: string;
  negative_prompt?: string;
  imageInputs: RefInput[];
  videoInputs: RefInput[];
  firstFrame?: RefInput;
  voiceRef?: RefInput;
  sourceImageIds: string[];
  sourceVideoIds: string[];
  sourceAudioIds: string[];
  resolution?: Wan27Resolution;
  aspect_ratio?: Wan27RefToVideoRequest["input"]["aspect_ratio"];
  duration?: string;
  prompt_extend?: boolean;
  watermark?: boolean;
  nsfw_checker?: boolean;
  seed?: number;
};

async function uploadInputs(
  fs: Engine,
  inputs: RefInput[],
): Promise<string[]> {
  const urls: string[] = [];
  for (const { assetId, filename } of inputs) {
    urls.push(await uploadAssetToKie(fs, assetId, filename));
  }
  return urls;
}

async function uploadSingle(
  fs: Engine,
  input: RefInput,
): Promise<string> {
  return uploadAssetToKie(fs, input.assetId, input.filename);
}

export function registerGenerateWan27R2vVideoJob(fs: Engine): void {
  registerJobHandler("generate_wan27_r2v_video", async (payload, ctx) => {
    const {
      vidAssetId, vidAssetDir, bookId, prompt, negative_prompt,
      imageInputs, videoInputs, firstFrame, voiceRef,
      sourceImageIds, sourceVideoIds, sourceAudioIds,
      resolution, aspect_ratio, duration, prompt_extend, watermark, nsfw_checker, seed,
    } = payload as GenerateWan27R2vVideoPayload;

    requireApiKey("KIE_API_KEY");

    const referenceImageUrls = await uploadInputs(fs, imageInputs);
    const referenceVideoUrls = await uploadInputs(fs, videoInputs);
    const firstFrameUrl = firstFrame ? await uploadSingle(fs, firstFrame) : undefined;
    const referenceVoiceUrl = voiceRef ? await uploadSingle(fs, voiceRef) : undefined;
    const normalizedPrompt = transformProviderPrompt(
      "generate_kie_wan_2_7_reference_to_video",
      {
        prompt,
        image_refs: imageInputs.map((input) => input.assetId),
        video_refs: videoInputs.map((input) => input.assetId),
        first_frame_ref: firstFrame?.assetId,
        audio_ref: voiceRef?.assetId,
      },
    ) ?? "";

    const request = buildWan27ReferenceVideoPayload(
      { prompt: normalizedPrompt, negative_prompt, resolution, aspect_ratio, duration, prompt_extend, watermark, nsfw_checker, seed },
      { referenceImageUrls, referenceVideoUrls, firstFrameUrl, referenceVoiceUrl },
    );
    const taskId = await submitKieTask(fs, ctx, {
      request,
      taskType: "wan27_r2v_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      bookId,
      meta: {
        prompt,
        mode: "reference",
        sourceImageIds,
        sourceVideoIds,
        sourceAudioIds,
      },
    });

    return { success: true, taskId };
  });
}
