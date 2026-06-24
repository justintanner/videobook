import type { VideocityFs } from "videocity-engine";
import { submitKieTask } from "./kie-paygate.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildSeedance2VideoPayload } from "../payload-builders.js";

type Seedance2Model = "bytedance/seedance-2" | "bytedance/seedance-2-fast";
type RefInput = { assetId: string; filename: string };

export type Seedance2JobPayload = {
  vidAssetId: string;
  vidAssetDir: string;
  projectSlug: string;
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
  aspect_ratio?: string;
  resolution?: "480p" | "720p" | "1080p";
  duration?: string;
  generate_audio?: boolean;
  web_search?: boolean;
  nsfw_checker?: boolean;
  replaceAudioWith?: RefInput;
};

async function uploadAll(
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

export function registerSeedance2Job(fs: VideocityFs, jobType: string): void {
  registerJobHandler(jobType, async (payload, ctx) => {
    const {
      vidAssetId, vidAssetDir, projectSlug, prompt, apiModel,
      firstFrame, lastFrame,
      imageInputs, videoInputs, audioInputs,
      sourceImageIds, sourceVideoIds, sourceAudioIds,
      aspect_ratio, resolution, duration,
      generate_audio, web_search, nsfw_checker,
      replaceAudioWith,
    } = payload as unknown as Seedance2JobPayload;

    requireApiKey("KIE_API_KEY");

    const firstFrameUrl = firstFrame
      ? await uploadAssetToKie(fs, firstFrame.assetId, firstFrame.filename, projectSlug)
      : undefined;
    const lastFrameUrl = lastFrame
      ? await uploadAssetToKie(fs, lastFrame.assetId, lastFrame.filename, projectSlug)
      : undefined;
    const referenceImageUrls = await uploadAll(fs, imageInputs, projectSlug);
    const referenceVideoUrls = await uploadAll(fs, videoInputs, projectSlug);
    const referenceAudioUrls = await uploadAll(fs, audioInputs, projectSlug);

    const request = buildSeedance2VideoPayload(
      {
        prompt,
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
      projectSlug,
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
