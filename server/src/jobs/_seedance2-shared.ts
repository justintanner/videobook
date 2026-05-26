import type { VideocityFs } from "vc-engine";
import { kie, submitMediaJob } from "@apicity/kie";
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

    const apiKey = requireApiKey("KIE_API_KEY");
    const provider = kie({ apiKey, timeout: 60_000 });

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

    await fs.writeMetadata(vidAssetId, "generation-payload", request, projectSlug);
    const taskId = await submitMediaJob(provider, request);

    const ptResult = await fs.pendingTasks.write(projectSlug, {
      taskId,
      taskType: "seedance2_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      meta: {
        prompt,
        mode: "all",
        sourceImageIds,
        sourceVideoIds,
        sourceAudioIds,
        ...(replaceAudioWith ? { replaceAudioWith } : {}),
      },
    }, ctx.getOwnerId());
    if (!ptResult.ok) throw new Error(`Failed to write pending-task for ${vidAssetId}: ${ptResult.error.message}`);
    if (ptResult.value === null) throw new Error(`Lost local lease while writing pending-task`);

    ctx.setLease({ kind: "task", taskId });
    return { success: true, taskId };
  });
}
