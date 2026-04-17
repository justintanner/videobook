import type { ClipfirstFs } from "clipfirst-fs";
import { alibaba, type AlibabaVideoSynthesisParameters } from "@apicity/alibaba";
import { uploadAssetFile } from "../upload.js";
import { registerJobHandler } from "../queue.js";
import { writePendingTask } from "./pending-task.js";
import { buildAlibabaVideoPayload } from "../payload-builders.js";

type RefInput = { assetId: string; filename: string };

type GenerateAlibabaVideoPayload = {
  type: "generate_alibaba_video";
  vidAssetId: string;
  vidAssetDir: string;
  projectSlug: string;
  prompt: string;
  negative_prompt?: string;
  model?: string;
  firstFrame?: RefInput;
  lastFrame?: RefInput;
  firstClip?: RefInput;
  drivingAudio?: RefInput;
  videoRef?: RefInput;
  sourceImageIds: string[];
  sourceVideoIds: string[];
  sourceAudioIds: string[];
  resolution?: AlibabaVideoSynthesisParameters["resolution"];
  duration?: AlibabaVideoSynthesisParameters["duration"];
  prompt_extend?: AlibabaVideoSynthesisParameters["prompt_extend"];
  watermark?: AlibabaVideoSynthesisParameters["watermark"];
  audio_setting?: AlibabaVideoSynthesisParameters["audio_setting"];
  seed?: AlibabaVideoSynthesisParameters["seed"];
};

async function uploadInput(
  fs: ClipfirstFs,
  input: RefInput,
  projectSlug: string,
): Promise<string> {
  return uploadAssetFile(fs, input.assetId, input.filename, projectSlug);
}

export function registerGenerateAlibabaVideoJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_alibaba_video", async (payload) => {
    const {
      vidAssetId, vidAssetDir, projectSlug, prompt, negative_prompt, model,
      firstFrame, lastFrame, firstClip, drivingAudio, videoRef,
      sourceImageIds, sourceVideoIds, sourceAudioIds,
      resolution, duration, prompt_extend, watermark, audio_setting, seed,
    } = payload as GenerateAlibabaVideoPayload;

    const apiKey = process.env.DASHSCOPE_API_KEY;
    if (!apiKey) throw new Error("DASHSCOPE_API_KEY environment variable is not set");

    const firstFrameUrl = firstFrame ? await uploadInput(fs, firstFrame, projectSlug) : undefined;
    const lastFrameUrl = lastFrame ? await uploadInput(fs, lastFrame, projectSlug) : undefined;
    const firstClipUrl = firstClip ? await uploadInput(fs, firstClip, projectSlug) : undefined;
    const drivingAudioUrl = drivingAudio ? await uploadInput(fs, drivingAudio, projectSlug) : undefined;
    const videoUrl = videoRef ? await uploadInput(fs, videoRef, projectSlug) : undefined;

    const provider = alibaba({ apiKey, timeout: 120_000 });

    const request = buildAlibabaVideoPayload(
      {
        prompt,
        negative_prompt,
        model,
        resolution,
        duration,
        prompt_extend,
        watermark,
        audio_setting,
        seed,
      },
      { firstFrameUrl, lastFrameUrl, firstClipUrl, drivingAudioUrl, videoUrl },
    );
    await fs.writeMetadata(vidAssetId, "generation-payload", request, projectSlug);
    const submitResult = await provider.post.api.v1.services.aigc.videoGeneration.videoSynthesis(request);
    const taskId = submitResult.output.task_id;
    await writePendingTask(fs, vidAssetId, projectSlug, {
      taskId,
      taskType: "alibaba_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      projectSlug,
      createdAt: new Date().toISOString(),
      meta: {
        prompt,
        sourceImageIds,
        sourceVideoIds,
        sourceAudioIds,
      },
    });

    return { success: true, taskId };
  });
}
