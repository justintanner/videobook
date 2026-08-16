import type { Engine } from "videobook-engine";
import type { Seedance2MiniAspectRatio, Seedance2MiniResolution } from "@apicity/kie";
import { submitKieTask } from "./kie-paygate.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildSeedance2MiniVideoPayload } from "../payload-builders.js";
import { transformProviderPrompt } from "../provider-prompt-transform.js";

type RefInput = { assetId: string; filename: string };

type GenerateSeedance2MiniVideoPayload = {
  type: "generate_seedance2_mini_video";
  vidAssetId: string;
  vidAssetDir: string;
  bookId: string;
  imageInputs: RefInput[];
  videoInputs: RefInput[];
  audioInputs: RefInput[];
  sourceImageIds: string[];
  sourceVideoIds: string[];
  sourceAudioIds: string[];
  prompt?: string;
  aspect_ratio?: Seedance2MiniAspectRatio;
  resolution?: Seedance2MiniResolution;
  duration?: string;
  generate_audio?: boolean;
  web_search?: boolean;
  nsfw_checker?: boolean;
  replaceAudioWith?: RefInput;
};

async function uploadAll(fs: Engine, inputs: RefInput[]): Promise<string[]> {
  const urls: string[] = [];
  for (const { assetId, filename } of inputs) {
    urls.push(await uploadAssetToKie(fs, assetId, filename));
  }
  return urls;
}

export function registerGenerateSeedance2MiniVideoJob(fs: Engine): void {
  registerJobHandler("generate_seedance2_mini_video", async (payload, ctx) => {
    const {
      vidAssetId, vidAssetDir, bookId,
      imageInputs, videoInputs, audioInputs,
      sourceImageIds, sourceVideoIds, sourceAudioIds,
      prompt, aspect_ratio, resolution, duration,
      generate_audio, web_search, nsfw_checker,
      replaceAudioWith,
    } = payload as unknown as GenerateSeedance2MiniVideoPayload;

    requireApiKey("KIE_API_KEY");

    const referenceImageUrls = await uploadAll(fs, imageInputs);
    const referenceVideoUrls = await uploadAll(fs, videoInputs);
    const referenceAudioUrls = await uploadAll(fs, audioInputs);

    const normalizedPrompt = prompt === undefined
      ? undefined
      : transformProviderPrompt("generate_kie_seedance_2_0_mini_video", {
        prompt,
        image_refs: imageInputs.map((input) => input.assetId),
        video_refs: videoInputs.map((input) => input.assetId),
        audio_refs: audioInputs.map((input) => input.assetId),
      });

    const request = buildSeedance2MiniVideoPayload(
      {
        ...(normalizedPrompt !== undefined ? { prompt: normalizedPrompt } : {}),
        aspect_ratio,
        resolution,
        duration,
        generate_audio,
        web_search,
        nsfw_checker,
      },
      {
        ...(referenceImageUrls.length > 0 ? { referenceImageUrls } : {}),
        ...(referenceVideoUrls.length > 0 ? { referenceVideoUrls } : {}),
        ...(referenceAudioUrls.length > 0 ? { referenceAudioUrls } : {}),
      },
    );

    // Reuse the shared seedance2_video TaskType + completion handler — they key
    // off taskType, not the apiModel. apiModel rides in meta so the completed
    // asset records bytedance/seedance-2-mini provenance accurately.
    const taskId = await submitKieTask(fs, ctx, {
      request,
      taskType: "seedance2_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      bookId,
      meta: {
        mode: "mini",
        apiModel: "bytedance/seedance-2-mini",
        sourceImageIds,
        sourceVideoIds,
        sourceAudioIds,
        ...(prompt !== undefined ? { prompt } : {}),
        ...(replaceAudioWith ? { replaceAudioWith } : {}),
      },
    });

    return { success: true, taskId };
  });
}
