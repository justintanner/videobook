import type { Engine } from "videobook-engine";
import { submitKieTask } from "./kie-paygate.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildSeedance2VideoPayload } from "../payload-builders.js";
import type { Seedance2FastRequest, Seedance2Request } from "@apicity/kie";
import { transformProviderPrompt } from "../provider-prompt-transform.js";

type Seedance2Model = Seedance2Request["model"] | Seedance2FastRequest["model"];
type RefInput = { assetId: string; filename: string };

export type Seedance2JobPayload = {
  vidAssetId: string;
  vidAssetDir: string;
  bookId: string;
  prompt: string;
  apiModel: Seedance2Model;
  firstFrame?: RefInput;
  lastFrame?: RefInput;
  imageInputs: RefInput[];
  videoInputs: RefInput[];
  audioInputs: RefInput[];
  sourceImageIds: string[];
  sourceVideoIds: string[];
  sourceAudioIds: string[];
  aspect_ratio?: Seedance2Request["input"]["aspect_ratio"];
  resolution?: Seedance2Request["input"]["resolution"];
  duration?: string;
  generate_audio?: boolean;
  web_search?: boolean;
  nsfw_checker?: boolean;
  replaceAudioWith?: RefInput;
};

async function uploadAll(
  fs: Engine,
  inputs: RefInput[],
  bookId: string,
): Promise<string[]> {
  const urls: string[] = [];
  for (const { assetId, filename } of inputs) {
    urls.push(await uploadAssetToKie(fs, assetId, filename, bookId));
  }
  return urls;
}

export function registerSeedance2Job(fs: Engine, jobType: string): void {
  registerJobHandler(jobType, async (payload, ctx) => {
    const {
      vidAssetId, vidAssetDir, bookId, prompt, apiModel,
      firstFrame, lastFrame,
      imageInputs, videoInputs, audioInputs,
      sourceImageIds, sourceVideoIds, sourceAudioIds,
      aspect_ratio, resolution, duration,
      generate_audio, web_search, nsfw_checker,
      replaceAudioWith,
    } = payload as unknown as Seedance2JobPayload;

    requireApiKey("KIE_API_KEY");

    const firstFrameUrl = firstFrame
      ? await uploadAssetToKie(fs, firstFrame.assetId, firstFrame.filename, bookId)
      : undefined;
    const lastFrameUrl = lastFrame
      ? await uploadAssetToKie(fs, lastFrame.assetId, lastFrame.filename, bookId)
      : undefined;
    const referenceImageUrls = await uploadAll(fs, imageInputs, bookId);
    const referenceVideoUrls = await uploadAll(fs, videoInputs, bookId);
    const referenceAudioUrls = await uploadAll(fs, audioInputs, bookId);

    const normalizedPrompt = transformProviderPrompt(
      apiModel === "bytedance/seedance-2-fast"
        ? "generate_kie_seedance_2_0_fast_video"
        : "generate_kie_seedance_2_0_video",
      {
        prompt,
        image_slugs: imageInputs.map((input) => input.assetId),
        video_slugs: videoInputs.map((input) => input.assetId),
        audio_slugs: audioInputs.map((input) => input.assetId),
        first_frame_slug: firstFrame?.assetId,
        last_frame_slug: lastFrame?.assetId,
      },
    ) ?? "";

    const request = buildSeedance2VideoPayload(
      {
        prompt: normalizedPrompt,
        model: apiModel,
        aspect_ratio,
        resolution,
        duration,
        generate_audio,
        web_search: web_search ?? false,
        nsfw_checker,
      },
      {
        ...(firstFrameUrl ? { firstFrameUrl } : {}),
        ...(lastFrameUrl ? { lastFrameUrl } : {}),
        ...(referenceImageUrls.length > 0 ? { referenceImageUrls } : {}),
        ...(referenceVideoUrls.length > 0 ? { referenceVideoUrls } : {}),
        ...(referenceAudioUrls.length > 0 ? { referenceAudioUrls } : {}),
      },
    );

    const taskId = await submitKieTask(fs, ctx, {
      request,
      taskType: "seedance2_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      bookId,
      meta: {
        prompt,
        mode: "all",
        apiModel,
        sourceImageIds,
        sourceVideoIds,
        sourceAudioIds,
        ...(replaceAudioWith ? { replaceAudioWith } : {}),
      },
    });

    return { success: true, taskId };
  });
}
