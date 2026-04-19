import type { ClipfirstFs } from "clipfirst-fs";
import { kie, submitMediaJob } from "@apicity/kie";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { writePendingTask } from "./pending-task.js";
import { buildSeedance2VideoPayload } from "../payload-builders.js";

type RefInput = { assetId: string; filename: string };

type GenerateSeedance2ReferenceVideoPayload = {
  type: "generate_seedance2_reference_video";
  vidAssetId: string;
  vidAssetDir: string;
  projectSlug: string;
  prompt: string;
  imageInputs: RefInput[];
  videoInputs: RefInput[];
  audioInputs: RefInput[];
  sourceImageIds: string[];
  sourceVideoIds: string[];
  sourceAudioIds: string[];
  model?: "bytedance/seedance-2-fast" | "bytedance/seedance-2";
  aspect_ratio?: string;
  resolution?: "480p" | "720p" | "1080p";
  duration?: string;
  generate_audio?: boolean;
  return_last_frame?: boolean;
  web_search?: boolean;
};

async function uploadInputs(
  fs: ClipfirstFs,
  provider: ReturnType<typeof kie>,
  inputs: RefInput[],
  projectSlug: string,
): Promise<string[]> {
  const urls: string[] = [];
  for (const { assetId, filename } of inputs) {
    urls.push(await uploadAssetToKie(fs, assetId, filename, projectSlug));
  }
  return urls;
}

export function registerGenerateSeedance2ReferenceVideoJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_seedance2_reference_video", async (payload) => {
    const {
      vidAssetId, vidAssetDir, projectSlug, prompt,
      imageInputs, videoInputs, audioInputs,
      sourceImageIds, sourceVideoIds, sourceAudioIds,
      model, aspect_ratio, resolution, duration,
      generate_audio, return_last_frame, web_search,
    } = payload as GenerateSeedance2ReferenceVideoPayload;

    const apiKey = process.env.KIE_API_KEY;
    if (!apiKey) throw new Error("KIE_API_KEY environment variable is not set");

    const provider = kie({ apiKey, timeout: 60_000 });

    const referenceImageUrls = await uploadInputs(fs, provider, imageInputs, projectSlug);
    const referenceVideoUrls = await uploadInputs(fs, provider, videoInputs, projectSlug);
    const referenceAudioUrls = await uploadInputs(fs, provider, audioInputs, projectSlug);

    const request = buildSeedance2VideoPayload(
      { prompt, model, aspect_ratio, resolution, duration, generate_audio, return_last_frame, web_search },
      { referenceImageUrls, referenceVideoUrls, referenceAudioUrls },
    );
    await fs.writeMetadata(vidAssetId, "generation-payload", request, projectSlug);
    const taskId = await submitMediaJob(provider, request);
    await writePendingTask(fs, vidAssetId, projectSlug, {
      taskId,
      taskType: "seedance2_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      projectSlug,
      createdAt: new Date().toISOString(),
      meta: {
        prompt,
        mode: "reference",
        sourceImageIds,
        sourceVideoIds,
        sourceAudioIds,
        ...(return_last_frame !== undefined ? { return_last_frame } : {}),
      },
    });

    return { success: true, taskId };
  });
}
