import type { VideocityFs } from "videocity-engine";
import type { Wan27Resolution } from "@apicity/kie";
import { submitKieTask } from "./kie-paygate.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildWan27ReferenceVideoPayload } from "../payload-builders.js";

type RefInput = { assetId: string; filename: string };

type GenerateWan27R2vVideoPayload = {
  type: "generate_wan27_r2v_video";
  vidAssetId: string;
  vidAssetDir: string;
  projectSlug: string;
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
  aspect_ratio?: string;
  duration?: string;
  prompt_extend?: boolean;
  watermark?: boolean;
  nsfw_checker?: boolean;
  seed?: number;
};

async function uploadInputs(
  fs: VideocityFs,
  inputs: RefInput[],
  projectSlug: string,
): Promise<string[]> {
  const urls: string[] = [];
  for (const { assetId, filename } of inputs) {
    urls.push(await uploadAssetToKie(fs, assetId, filename, projectSlug));
  }
  return urls;
}

async function uploadSingle(
  fs: VideocityFs,
  input: RefInput,
  projectSlug: string,
): Promise<string> {
  return uploadAssetToKie(fs, input.assetId, input.filename, projectSlug);
}

export function registerGenerateWan27R2vVideoJob(fs: VideocityFs): void {
  registerJobHandler("generate_wan27_r2v_video", async (payload, ctx) => {
    const {
      vidAssetId, vidAssetDir, projectSlug, prompt, negative_prompt,
      imageInputs, videoInputs, firstFrame, voiceRef,
      sourceImageIds, sourceVideoIds, sourceAudioIds,
      resolution, aspect_ratio, duration, prompt_extend, watermark, nsfw_checker, seed,
    } = payload as GenerateWan27R2vVideoPayload;

    requireApiKey("KIE_API_KEY");

    const referenceImageUrls = await uploadInputs(fs, imageInputs, projectSlug);
    const referenceVideoUrls = await uploadInputs(fs, videoInputs, projectSlug);
    const firstFrameUrl = firstFrame ? await uploadSingle(fs, firstFrame, projectSlug) : undefined;
    const referenceVoiceUrl = voiceRef ? await uploadSingle(fs, voiceRef, projectSlug) : undefined;

    const request = buildWan27ReferenceVideoPayload(
      { prompt, negative_prompt, resolution, aspect_ratio, duration, prompt_extend, watermark, nsfw_checker, seed },
      { referenceImageUrls, referenceVideoUrls, firstFrameUrl, referenceVoiceUrl },
    );
    const taskId = await submitKieTask(fs, ctx, {
      request,
      taskType: "wan27_r2v_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      projectSlug,
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
