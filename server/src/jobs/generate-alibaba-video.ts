import type { ClipfirstFs } from "clipfirst-engine";
import { alibaba, type AlibabaVideoSynthesisParameters } from "@apicity/alibaba";
import { uploadAssetToAlibaba } from "./_alibaba-upload.js";
import { registerJobHandler } from "../queue.js";
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
  model: string,
): Promise<string> {
  return uploadAssetToAlibaba(fs, input.assetId, input.filename, projectSlug, model);
}

export function registerGenerateAlibabaVideoJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_alibaba_video", async (payload, ctx) => {
    const {
      vidAssetId, vidAssetDir, projectSlug, prompt, negative_prompt, model,
      firstFrame, lastFrame, firstClip, drivingAudio, videoRef,
      sourceImageIds, sourceVideoIds, sourceAudioIds,
      resolution, duration, prompt_extend, watermark, audio_setting, seed,
    } = payload as GenerateAlibabaVideoPayload;

    const apiKey = process.env.DASHSCOPE_API_KEY;
    if (!apiKey) throw new Error("DASHSCOPE_API_KEY environment variable is not set");

    const uploadModel = model ?? "wan2.7-i2v";
    const firstFrameUrl = firstFrame ? await uploadInput(fs, firstFrame, projectSlug, uploadModel) : undefined;
    const lastFrameUrl = lastFrame ? await uploadInput(fs, lastFrame, projectSlug, uploadModel) : undefined;
    const firstClipUrl = firstClip ? await uploadInput(fs, firstClip, projectSlug, uploadModel) : undefined;
    const drivingAudioUrl = drivingAudio ? await uploadInput(fs, drivingAudio, projectSlug, uploadModel) : undefined;
    const videoUrl = videoRef ? await uploadInput(fs, videoRef, projectSlug, uploadModel) : undefined;

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
    {
      const _ptResult = await fs.pendingTasks.write(projectSlug, {
        taskId,
        taskType: "alibaba_video",
        assetId: vidAssetId,
        assetDir: vidAssetDir,
        meta: {
          prompt,
          sourceImageIds,
          sourceVideoIds,
          sourceAudioIds,
        },
    }, ctx.getOwnerId());
      if (!_ptResult.ok) throw new Error(`Failed to write pending-task for ${vidAssetId}: ${_ptResult.error.message}`);
    }
    ctx.setLease({ kind: "task", taskId });

    return { success: true, taskId };
  });
}
