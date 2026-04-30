import type { ClipfirstFs } from "clipfirst-engine";
import { kie, submitMediaJob, type Wan27Resolution } from "@apicity/kie";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
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
  nsfw_checker?: boolean;
  seed?: number;
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

async function uploadSingle(
  fs: ClipfirstFs,
  provider: ReturnType<typeof kie>,
  input: RefInput,
  projectSlug: string,
): Promise<string> {
  return uploadAssetToKie(fs, input.assetId, input.filename, projectSlug);
}

export function registerGenerateWan27R2vVideoJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_wan27_r2v_video", async (payload, ctx) => {
    const {
      vidAssetId, vidAssetDir, projectSlug, prompt, negative_prompt,
      imageInputs, videoInputs, firstFrame, voiceRef,
      sourceImageIds, sourceVideoIds, sourceAudioIds,
      resolution, aspect_ratio, duration, prompt_extend, nsfw_checker, seed,
    } = payload as GenerateWan27R2vVideoPayload;

    const apiKey = process.env.KIE_API_KEY;
    if (!apiKey) throw new Error("KIE_API_KEY environment variable is not set");

    const provider = kie({ apiKey, timeout: 60_000 });

    const referenceImageUrls = await uploadInputs(fs, provider, imageInputs, projectSlug);
    const referenceVideoUrls = await uploadInputs(fs, provider, videoInputs, projectSlug);
    const firstFrameUrl = firstFrame ? await uploadSingle(fs, provider, firstFrame, projectSlug) : undefined;
    const referenceVoiceUrl = voiceRef ? await uploadSingle(fs, provider, voiceRef, projectSlug) : undefined;

    const request = buildWan27ReferenceVideoPayload(
      { prompt, negative_prompt, resolution, aspect_ratio, duration, prompt_extend, nsfw_checker, seed },
      { referenceImageUrls, referenceVideoUrls, firstFrameUrl, referenceVoiceUrl },
    );
    await fs.writeMetadata(vidAssetId, "generation-payload", request, projectSlug);
    const taskId = await submitMediaJob(provider, request);
    {
      const _ptResult = await fs.pendingTasks.write(projectSlug, {
        taskId,
        taskType: "wan27_r2v_video",
        assetId: vidAssetId,
        assetDir: vidAssetDir,
        meta: {
          prompt,
          mode: "reference",
          sourceImageIds,
          sourceVideoIds,
          sourceAudioIds,
        },
    });
      if (!_ptResult.ok) throw new Error(`Failed to write pending-task for ${vidAssetId}: ${_ptResult.error.message}`);
    }
    ctx.setLease({ kind: "task", taskId });

    return { success: true, taskId };
  });
}
